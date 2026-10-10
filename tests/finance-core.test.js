// Orbit: deterministic maths (no server). Money, dates/time zones, ledger rules, categories, budgets, debts, goals, PIN policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMoney, formatMoney, toDecimal, MoneyError } from '../apps/finance/server/money.js';
import { zonedToUtc, localDateOf, namedRange, addMonths, bucketKey, startOfWeek } from '../apps/finance/server/dates.js';
import { summarize, accountBalances, categoryBreakdown, trend, postings, queryTransactions, accountHistory } from '../apps/finance/server/ledger.js';
import { parentProblem, descendantIds, starterCategories, pathOf, byId } from '../apps/finance/server/categories.js';
import { budgetStatus, summarizeBudgets, rolloverFor } from '../apps/finance/server/budgets.js';
import { debtState } from '../apps/finance/server/debts.js';
import { goalProgress, dueOccurrences, netWorth } from '../apps/finance/server/planning.js';
import { weakPin, delaySec } from '../apps/finance/server/pin.js';
import { matchName } from '../apps/finance/server/names.js';
import { parseCsv, toCsv } from '../apps/finance/server/csv.js';
import { resolveDraft, mergeFields } from '../apps/finance/server/assistant.js';

let n = 0; const id = () => `x${++n}`;
const T = (o) => ({ id: id(), status: 'posted', currency: 'NGN', localDate: '2026-10-05', occurredAt: '2026-10-05T10:00:00Z', tags: [], ...o });

test('money: exact integer parsing, no floating point drift', () => {
  assert.equal(parseMoney('₦3,500'), 350000); assert.equal(parseMoney('3.5k'), 350000); assert.equal(parseMoney('41000.5'), 4100050);
  assert.equal(parseMoney('0.1') + parseMoney('0.2'), parseMoney('0.3')); // 10 + 20 = 30 kobo, exactly
  assert.equal(parseMoney(19.99), 1999);
  for (const bad of ['', 'abc', '1.234', '-5', '1e5', '12,3a']) assert.throws(() => parseMoney(bad), MoneyError, bad);
  assert.throws(() => parseMoney('99999999999999'), MoneyError);
  assert.equal(parseMoney('1,500', 'XOF'), 1500); assert.equal(formatMoney(1234567890, 'NGN'), '₦12,345,678.90'); assert.equal(formatMoney(-5, 'NGN'), '-₦0.05'); assert.equal(toDecimal(350050), '3500.50');
  assert.equal(parseMoney('12.5', 'ABC', [{ code: 'ABC', exp: 3, symbol: 'A' }]), 12500); // custom currency
});

test('dates: local date is computed in the user\'s time zone and survives DST maths', () => {
  assert.equal(localDateOf('2026-10-10T23:30:00Z', 'Africa/Lagos'), '2026-10-11'); // Lagos is UTC+1
  assert.equal(zonedToUtc('2026-10-10', '23:30', 'Africa/Lagos'), '2026-10-10T22:30:00.000Z');
  assert.equal(zonedToUtc('2026-03-08', '12:00', 'America/New_York'), '2026-03-08T16:00:00.000Z'); // after the spring-forward jump
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.deepEqual(namedRange('this_week', '2026-10-10'), { from: '2026-10-05', to: '2026-10-11' }); // Monday start
  assert.deepEqual(namedRange('last_month', '2026-01-15'), { from: '2025-12-01', to: '2025-12-31' });
  assert.equal(startOfWeek('2026-10-11', 0), '2026-10-11'); assert.equal(bucketKey('2026-10-11', 'month'), '2026-10');
  assert.throws(() => namedRange('custom', 'x', { from: '2026-02-30', to: '2026-03-01' }));
});

const A = { id: 'a', currency: 'NGN', openingBalanceMinor: 1_000_000 }, B = { id: 'b', currency: 'NGN', openingBalanceMinor: 0 }, U = { id: 'u', currency: 'USD', openingBalanceMinor: 0 };
test('ledger: transfers are not income or expense; both sides move together; fees are expenses', () => {
  const txns = [T({ type: 'income', accountId: 'a', amountMinor: 500000 }), T({ type: 'expense', accountId: 'a', amountMinor: 120000 }),
    T({ type: 'transfer', accountId: 'a', toAccountId: 'b', toCurrency: 'NGN', amountMinor: 300000, toAmountMinor: 300000, feeMinor: 5000, feeCategoryId: null })];
  const bal = accountBalances([A, B], txns);
  assert.equal(bal.get('a'), 1_000_000 + 500000 - 120000 - 305000); assert.equal(bal.get('b'), 300000);
  const all = summarize(txns, {}).NGN; // everything: the transfer is internal
  assert.equal(all.income, 500000); assert.equal(all.expense, 125000); assert.equal(all.fees, 5000); assert.equal(all.transfersIn, 0); assert.equal(all.transfersOut, 0);
  const onlyB = summarize(txns, { accountIds: ['b'] }).NGN; assert.equal(onlyB.income, 0); assert.equal(onlyB.transfersIn, 300000); assert.equal(onlyB.balanceChange, 300000);
  for (const s of [all, onlyB, summarize(txns, { accountIds: ['a'] }).NGN]) assert.equal(s.balanceChange, s.net + s.debt.net + s.adjustments + (s.transfersIn - s.transfersOut)); // the reconciliation identity
});
test('ledger: refunds reduce expense (not income); loans and repayments are not income/expense; adjustments are separate; voided ignored', () => {
  const txns = [T({ type: 'expense', accountId: 'a', amountMinor: 100000, categoryId: 'food' }), T({ type: 'refund', accountId: 'a', amountMinor: 30000, categoryId: 'food' }),
    T({ type: 'loan_out', accountId: 'a', amountMinor: 50000 }), T({ type: 'repay_in', accountId: 'a', amountMinor: 20000 }), T({ type: 'loan_in', accountId: 'a', amountMinor: 70000 }), T({ type: 'repay_out', accountId: 'a', amountMinor: 10000 }),
    T({ type: 'adjustment', accountId: 'a', direction: 'decrease', amountMinor: 1000 }), T({ type: 'expense', accountId: 'a', amountMinor: 999999, status: 'voided' })];
  const s = summarize(txns, {}).NGN;
  assert.equal(s.income, 0); assert.equal(s.netExpense, 70000); assert.equal(s.refunds, 30000);
  assert.deepEqual(s.debt, { borrowed: 70000, lent: 50000, repaymentsReceived: 20000, repaymentsMade: 10000, net: 30000 }); assert.equal(s.adjustments, -1000);
  assert.equal(s.balanceChange, -100000 + 30000 - 50000 + 20000 + 70000 - 10000 - 1000);
  assert.equal(postings(txns[7]).length, 0);
});
test('ledger: multi-currency stays separate (no silent conversion)', () => {
  const txns = [T({ type: 'income', accountId: 'a', amountMinor: 1000 }), T({ type: 'income', accountId: 'u', currency: 'USD', amountMinor: 500 }),
    T({ type: 'transfer', accountId: 'u', toAccountId: 'a', currency: 'USD', toCurrency: 'NGN', amountMinor: 100, toAmountMinor: 150000 })];
  const s = summarize(txns, {}); assert.equal(s.NGN.income, 1000); assert.equal(s.USD.income, 500);
  const bal = accountBalances([A, U], txns); assert.equal(bal.get('u'), 400); assert.equal(bal.get('a'), 1_000_000 + 1000 + 150000);
});
test('categories: nesting rules, rollups count each transaction once', () => {
  const cats = starterCategories('o', (p) => `${p}_${id()}`, 'now'), find = (name) => cats.find((c) => c.name === name), map = byId(cats);
  assert.equal(pathOf(map, find('Data & Airtime').id), 'Bills & Utilities › Data & Airtime');
  assert.ok(parentProblem(cats, { parentId: find('Salary & Wages').id, kind: 'expense' })); // kinds must match
  const food = find('Food & Dining'), groc = find('Groceries');
  assert.ok(parentProblem(cats, { id: food.id, parentId: groc.id, kind: 'expense' })); // no loops
  let chain = cats, parent = food.id; for (let i = 0; i < 8; i++) { const c = { id: `deep${i}`, kind: 'expense', parentId: parent, name: `d${i}` }; chain = [...chain, c]; parent = c.id; }
  assert.ok(parentProblem(chain, { parentId: parent, kind: 'expense' }), 'depth is capped');
  const txns = [T({ type: 'expense', accountId: 'a', amountMinor: 1000, categoryId: groc.id }), T({ type: 'expense', accountId: 'a', amountMinor: 500, categoryId: food.id }), T({ type: 'expense', accountId: 'a', amountMinor: 200, categoryId: null }),
    T({ type: 'refund', accountId: 'a', amountMinor: 100, categoryId: groc.id })];
  const bd = categoryBreakdown(txns, cats, { kind: 'expense', currency: 'NGN' });
  const f = bd.roots.find((r) => r.id === food.id);
  assert.equal(f.ownMinor, 500); assert.equal(f.totalMinor, 1400); assert.equal(bd.uncategorisedMinor, 200); assert.equal(bd.totalMinor, 1600);
  assert.equal(bd.totalMinor, summarize(txns, {}).NGN.netExpense); // the breakdown always reconciles with the summary
  assert.equal(descendantIds(cats, food.id).has(groc.id), true);
});
test('budgets: progress, rollover, previous period, and nested budgets are never double counted', () => {
  const cats = starterCategories('o', (p) => `${p}_${id()}`, 'now'), food = cats.find((c) => c.name === 'Food & Dining'), groc = cats.find((c) => c.name === 'Groceries');
  const txns = [T({ type: 'expense', accountId: 'a', amountMinor: 30000, categoryId: groc.id, localDate: '2026-10-03' }), T({ type: 'expense', accountId: 'a', amountMinor: 10000, categoryId: food.id, localDate: '2026-10-04' }),
    T({ type: 'expense', accountId: 'a', amountMinor: 20000, categoryId: groc.id, localDate: '2026-09-10' })];
  const parent = { id: 'b1', categoryId: food.id, period: 'monthly', currency: 'NGN', amountMinor: 100000, warnAtPercent: 30 }, child = { id: 'b2', categoryId: groc.id, period: 'monthly', currency: 'NGN', amountMinor: 50000 };
  const sp = budgetStatus(parent, txns, cats, '2026-10-10'), sc = budgetStatus(child, txns, cats, '2026-10-10');
  assert.equal(sp.spentMinor, 40000); assert.equal(sp.state, 'warning'); assert.equal(sp.remainingMinor, 60000); assert.equal(sc.spentMinor, 30000); assert.equal(sp.previous.spentMinor, 20000); assert.equal(sp.previous.deltaMinor, 20000);
  const total = summarizeBudgets([parent, child], new Map([['b1', sp], ['b2', sc]]), cats).NGN;
  assert.equal(total.budgetMinor, 100000); assert.equal(total.spentMinor, 40000); // child excluded from the overall total
  assert.equal(budgetStatus({ ...parent, amountMinor: 30000 }, txns, cats, '2026-10-10').state, 'over');
  const roll = { ...parent, rollover: true, createdLocalDate: '2026-09-01' };
  assert.equal(rolloverFor(roll, txns, cats, { from: '2026-10-01', to: '2026-10-31' }), 80000); // September: 100,000 budget - 20,000 spent
  assert.equal(budgetStatus(roll, txns, cats, '2026-10-10').availableMinor, 180000);
  assert.equal(rolloverFor({ ...roll, period: 'custom' }, txns, cats, { from: '2026-10-01', to: '2026-10-31' }), 0); // custom periods never roll over
  assert.equal(budgetStatus({ id: 'c', categoryId: null, period: 'custom', startDate: '2026-10-01', endDate: '2026-10-05', currency: 'NGN', amountMinor: 1 }, txns, cats, '2026-10-02').spentMinor, 40000);
});
test('debts: outstanding balance, overdue, write-offs; repayments are not income/expense', () => {
  const d = { id: 'd1', direction: 'lent', counterparty: 'Ada', principalMinor: 500000, currency: 'NGN', startDate: '2026-09-01', dueDate: '2026-10-01', events: [] };
  const txns = [T({ type: 'repay_in', accountId: 'a', amountMinor: 200000, debtId: 'd1' }), T({ type: 'repay_in', accountId: 'a', amountMinor: 50000, debtId: 'd1', status: 'voided' })];
  let st = debtState(d, txns, '2026-10-10'); assert.equal(st.outstandingMinor, 300000); assert.equal(st.overdue, true); assert.equal(st.status, 'open');
  assert.equal(summarize(txns, {}).NGN.income, 0);
  st = debtState({ ...d, events: [{ kind: 'written_off', amountMinor: 300000 }] }, txns, '2026-10-10'); assert.equal(st.outstandingMinor, 0); assert.equal(st.status, 'settled');
});
test('goals, recurring and net worth', () => {
  const g = { id: 'g', targetMinor: 1_000_000, deadline: '2027-01-10' };
  const txns = [T({ type: 'transfer', accountId: 'a', toAccountId: 'b', amountMinor: 400000, toAmountMinor: 400000, goalId: 'g' }), T({ type: 'expense', accountId: 'b', amountMinor: 100000, goalId: 'g' })];
  const p = goalProgress(g, txns, '2026-10-10'); assert.equal(p.savedMinor, 300000); assert.equal(p.percent, 30); assert.equal(p.monthsLeft, 3); assert.equal(p.suggestedMonthlyMinor, 233334);
  const rule = { id: 'r', frequency: 'monthly', nextDue: '2026-09-30', interval: 1 };
  assert.deepEqual(dueOccurrences(rule, '2026-10-10', { horizonDays: 25 }).map((o) => o.dueDate), ['2026-09-30', '2026-10-30']);
  const nw = netWorth({ accounts: [{ id: 'a', name: 'A', currency: 'NGN' }, { id: 'o', name: 'Old', currency: 'NGN', archived: true }], balances: new Map([['a', 100], ['o', 0]]), debts: [{ id: 'd', direction: 'borrowed', counterparty: 'Bank', currency: 'NGN' }], debtStates: new Map([['d', { outstandingMinor: 40 }]]), items: [{ name: 'Laptop', kind: 'asset', valueMinor: 500, currency: 'NGN' }] });
  assert.equal(nw.NGN.netWorth, 100 - 40 + 500);
});
test('queries: search/filter/sort/pagination and account history running balance', () => {
  const txns = Array.from({ length: 120 }, (_, i) => T({ type: 'expense', accountId: 'a', amountMinor: (i + 1) * 100, description: i === 7 ? 'Special lunch' : `item ${i}`, localDate: `2026-09-${String((i % 28) + 1).padStart(2, '0')}`, occurredAt: `2026-09-01T${String(i % 24).padStart(2, '0')}:00:00Z` }));
  assert.equal(queryTransactions(txns, { q: 'special' }).total, 1); const page = queryTransactions(txns, { sort: 'amount', dir: 'desc', limit: 10, offset: 10 });
  assert.equal(page.items.length, 10); assert.equal(page.items[0].amountMinor, 11000); assert.equal(page.total, 120);
  assert.equal(queryTransactions(txns, { minMinor: 11900 }).total, 2);
  const h = accountHistory({ id: 'a', openingBalanceMinor: 1_000_000 }, txns.slice(0, 3)); assert.equal(h[0].balanceAfterMinor, 1_000_000 - 600); // newest first
  assert.equal(trend(txns.slice(0, 3), { granularity: 'month', currency: 'NGN', bucketKey })[0].expense, 600);
});
test('PIN policy and escalating delays; names; csv', () => {
  for (const bad of ['123456', '111111', '654321', '12', 'abcdef', '121212']) assert.ok(weakPin(bad), bad); assert.equal(weakPin('482915'), null);
  assert.deepEqual([4, 5, 6, 7, 8, 9, 10, 20].map(delaySec), [0, 30, 60, 300, 900, 3600, 86400, 86400]);
  const items = [{ id: '1', names: ['OPay Wallet'] }, { id: '2', names: ['PalmPay'] }, { id: '3', names: ['OPay Savings'] }];
  assert.equal(matchName('palmpay', items).match.id, '2'); assert.equal(matchName('opay', items).match, null); assert.equal(matchName('opay', items).candidates.length, 2); assert.equal(matchName('opay wallet', items).matchedBy, 'exact');
  const rows = parseCsv('a,b\r\n"x, y","he said ""hi"""\n'); assert.deepEqual(rows[1], ['x, y', 'he said "hi"']);
  assert.ok(toCsv([['=cmd|calc', '+1']]).startsWith("'=cmd|calc")); // spreadsheet formula injection neutralised
});
test('assistant draft resolver: never guesses an ambiguous account/person; explains accounting', () => {
  const cats = starterCategories('o', (p) => `${p}_${id()}`, 'now'), settings = { currency: 'NGN', customCurrencies: [] };
  const accounts = [{ id: 'a1', name: 'OPay Wallet', currency: 'NGN' }, { id: 'a2', name: 'PalmPay', currency: 'NGN' }, { id: 'a3', name: 'OPay Savings', currency: 'NGN' }];
  const ctx = { settings, accounts, cats, debts: [{ id: 'd1', direction: 'lent', counterparty: 'Ada', currency: 'NGN', principalMinor: 500000, startDate: '2026-09-01', events: [] }], txns: [], today: '2026-10-10' };
  let r = resolveDraft({ type: 'expense', amount: '3,500', account: 'opay', category: 'Data & Airtime' }, ctx);
  assert.equal(r.ready, false); assert.equal(r.ambiguous[0].field, 'account'); assert.ok(r.ambiguous[0].options.includes('OPay Savings'));
  r = resolveDraft({ type: 'expense', amount: '3,500', account: 'OPay Wallet', category: 'data' }, ctx);
  assert.equal(r.ready, true); assert.equal(r.payload.amountMinor, 350000); assert.equal(r.payload.type, 'expense'); assert.deepEqual(r.assumed, ['date']);
  r = resolveDraft({ type: 'lend', amount: '5000', account: 'OPay Wallet', counterparty: 'my friend' }, ctx); assert.equal(r.missing[0].field, 'counterparty');
  r = resolveDraft({ type: 'transfer', amount: '10000', account: 'PalmPay', toAccount: 'OPay Wallet' }, ctx); assert.equal(r.ready, true); assert.match(r.accounting, /NOT income or expense/); assert.equal(r.payload.toAccountId, 'a1');
  r = resolveDraft({ type: 'repay_received', amount: '900000', account: 'OPay Wallet', counterparty: 'Ada' }, ctx); assert.ok(r.errors[0].includes('more than')); // cannot overpay a debt
  r = resolveDraft({ type: 'income', amount: 'lots', account: 'PalmPay' }, ctx); assert.equal(r.ready, false);
  assert.deepEqual(mergeFields({ amount: '3500', accountId: 'a1' }, { account: 'PalmPay', bogus: 'x' }), { amount: '3500', account: 'PalmPay' }); // name replaces id; unknown keys dropped
});
