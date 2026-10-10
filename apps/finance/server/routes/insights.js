// Dashboard and reports. Every number is computed by ledger.js / budgets.js from posted transactions.
import { v } from '../../../../shared/validate.js';
import { badRequest } from '../../../../shared/errors.js';
import { HttpError } from '../../../../shared/errors.js';
import { todayIn, namedRange, bucketKey, RANGE_NAMES, addDays } from '../dates.js';
import { accountBalances, summarize, categoryBreakdown, trend } from '../ledger.js';
import { budgetStatus } from '../budgets.js';
import { debtState } from '../debts.js';
import { goalProgress, dueOccurrences } from '../planning.js';
import { formatMoney } from '../money.js';
import { byId, pathOf } from '../categories.js';

export function insightRoutes({ router, s, store, pins, guard, P }) {
  const { col, all } = store;
  const use = (h, o) => guard('finance.access', h, o);
  const strip = ({ ownerId, ...d }) => d;

  async function scope(user, query) {
    const [st, accounts, txns, cats] = await Promise.all([col.settings.get(user.id), all(col.accounts, user.id), all(col.txns, user.id), all(col.cats, user.id)]);
    const today = todayIn(st.timezone), name = query.get('range') || 'this_month';
    if (!RANGE_NAMES.includes(name)) throw badRequest(`range must be one of: ${RANGE_NAMES.join(', ')}`);
    let range; try { range = namedRange(name, today, { weekStartsOn: st.weekStartsOn, from: query.get('from'), to: query.get('to') }); } catch (e) { throw badRequest(e.message); }
    const ids = (query.get('accountIds') || '').split(',').filter(Boolean), known = new Set(accounts.map((a) => a.id));
    if (ids.some((i) => !known.has(i))) throw badRequest('Unknown account in accountIds');
    return { st, accounts, txns, cats, today, range, rangeName: name, accountIds: ids.length ? ids : null };
  }
  const counts = (txns) => ({ transactions: txns.filter((t) => t.status !== 'voided').length, uncategorised: txns.filter((t) => t.status !== 'voided' && (t.type === 'expense' || t.type === 'income') && !t.categoryId).length });

  router.add('GET', `${P}/dashboard`, use(async ({ user, query }) => {
    const c = await scope(user, query), { st, accounts, txns, cats, today, range, accountIds } = c;
    const sel = accountIds ? accounts.filter((a) => accountIds.includes(a.id)) : accounts.filter((a) => !a.archived);
    const bal = accountBalances(accounts, txns), totals = {};
    for (const a of sel) totals[a.currency] = (totals[a.currency] || 0) + (bal.get(a.id) || 0);
    const summary = summarize(txns, { range, accountIds: accountIds || accounts.map((a) => a.id) });
    const live = (await all(col.budgets, user.id)).filter((b) => !b.archived), bm = byId(cats);
    const budgets = live.map((b) => ({ id: b.id, categoryPath: b.categoryId ? pathOf(bm, b.categoryId) : 'All spending', currency: b.currency, ...budgetStatus(b, txns, cats, today, st.weekStartsOn) })).sort((a, b) => b.percent - a.percent).slice(0, 4);
    const [debts, goals, rules] = await Promise.all([all(col.debts, user.id), all(col.goals, user.id), all(col.recurring, user.id)]);
    const open = debts.filter((d) => !d.archived).map((d) => ({ d, s: debtState(d, txns, today) })).filter((x) => x.s.status === 'open');
    const debtTotals = {}; for (const { d, s: x } of open) { const t = (debtTotals[d.currency] ??= { owedToYouMinor: 0, youOweMinor: 0, overdue: 0 }); t[d.direction === 'lent' ? 'owedToYouMinor' : 'youOweMinor'] += x.outstandingMinor; if (x.overdue) t.overdue++; }
    const recent = txns.filter((t) => t.status !== 'voided').sort((a, b) => (`${a.localDate}|${a.occurredAt}` < `${b.localDate}|${b.occurredAt}` ? 1 : -1)).slice(0, 8).map((t) => ({ ...strip(t), categoryPath: pathOf(bm, t.categoryId) }));
    return { range: { ...range, name: c.rangeName }, today, totalBalances: totals, summary, budgets, debts: debtTotals,
      goals: goals.filter((g) => !g.archived).slice(0, 4).map((g) => ({ id: g.id, name: g.name, currency: g.currency, targetMinor: g.targetMinor, ...goalProgress(g, txns, today) })),
      upcoming: rules.filter((r) => !r.archived).flatMap((r) => dueOccurrences(r, today, { horizonDays: r.reminderDays ?? 7, max: 3 }).map((o) => ({ ...o, name: r.name, amountMinor: r.amountMinor, currency: r.currency, type: r.type }))).sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 5),
      recent, coverage: counts(txns) };
  }));

  router.add('GET', `${P}/reports/summary`, use(async ({ user, query }) => {
    const c = await scope(user, query);
    return { range: { ...c.range, name: c.rangeName }, accountIds: c.accountIds, byCurrency: summarize(c.txns, { range: c.range, accountIds: c.accountIds || c.accounts.map((a) => a.id) }), coverage: counts(c.txns),
      rules: 'Transfers between your own accounts, refunds, loans, repayments and balance adjustments are not income or expense. Refunds reduce spending. Voided transactions are ignored.' };
  }));
  router.add('GET', `${P}/reports/categories`, use(async ({ user, query }) => {
    const c = await scope(user, query), kind = query.get('kind') === 'income' ? 'income' : 'expense', currency = query.get('currency') || c.st.currency;
    return { range: { ...c.range, name: c.rangeName }, ...categoryBreakdown(c.txns, c.cats, { kind, range: c.range, accountIds: c.accountIds, currency }) };
  }));
  router.add('GET', `${P}/reports/trend`, use(async ({ user, query }) => {
    const c = await scope(user, query), g = query.get('granularity') || 'day', currency = query.get('currency') || c.st.currency;
    if (!['day', 'week', 'month', 'year'].includes(g)) throw badRequest('granularity must be day, week, month or year');
    return { range: { ...c.range, name: c.rangeName }, granularity: g, currency, points: trend(c.txns, { granularity: g, range: c.range, accountIds: c.accountIds, currency, weekStartsOn: c.st.weekStartsOn, bucketKey }) };
  }));
  router.add('GET', `${P}/reports/accounts`, use(async ({ user, query }) => {
    const c = await scope(user, query), bal = accountBalances(c.accounts, c.txns);
    return { range: { ...c.range, name: c.rangeName }, accounts: c.accounts.map((a) => { const sm = summarize(c.txns, { range: c.range, accountIds: [a.id] })[a.currency] || {}; return { id: a.id, name: a.name, kind: a.kind, currency: a.currency, archived: a.archived, balanceMinor: bal.get(a.id) || 0, incomeMinor: sm.income || 0, netExpenseMinor: sm.netExpense || 0, transfersInMinor: sm.transfersIn || 0, transfersOutMinor: sm.transfersOut || 0, balanceChangeMinor: sm.balanceChange || 0 }; }) };
  }));
  router.add('GET', `${P}/reports/cashflow`, use(async ({ user, query }) => {
    const c = await scope(user, query), g = query.get('granularity') || 'month', currency = query.get('currency') || c.st.currency;
    const pts = trend(c.txns, { granularity: g, range: c.range, accountIds: c.accountIds, currency, weekStartsOn: c.st.weekStartsOn, bucketKey });
    let running = 0; return { currency, granularity: g, points: pts.map((p) => ({ ...p, cumulativeMinor: (running += p.net) })) };
  }));
  router.add('GET', `${P}/reports/debts`, use(async ({ user }) => {
    const [st, debts, txns] = await Promise.all([col.settings.get(user.id), all(col.debts, user.id), all(col.txns, user.id)]), today = todayIn(st.timezone);
    return { debts: debts.map((d) => ({ ...strip(d), ...debtState(d, txns, today) })) };
  }));

  // Dashboard widget. It lives outside the PIN check on purpose so the home page can say "Locked"; it never returns money while locked
  // and, even when unlocked, shows nothing unless the user turned the widget on in Orbit settings.
  router.add('GET', `${P}/widget/summary`, guard('finance.access', async ({ user, req, res, session }) => {
    try { await pins.authorize(req, res, user, session); } catch (e) { if (e instanceof HttpError && e.status === 423) return { stats: [{ label: 'Orbit', value: 'Locked' }] }; throw e; }
    const st = await col.settings.get(user.id); if (!st.showOnDashboard) return { stats: [{ label: 'Orbit', value: 'Hidden' }] };
    const [accounts, txns] = await Promise.all([all(col.accounts, user.id), all(col.txns, user.id)]), bal = accountBalances(accounts, txns), cur = st.currency;
    const total = accounts.filter((a) => !a.archived && a.currency === cur).reduce((x, a) => x + (bal.get(a.id) || 0), 0);
    const m = summarize(txns, { range: namedRange('this_month', todayIn(st.timezone)) })[cur] || { income: 0, netExpense: 0 };
    return { stats: [{ label: 'Balance', value: formatMoney(total, cur, st.customCurrencies) }, { label: 'Spent this month', value: formatMoney(m.netExpense, cur, st.customCurrencies) }] };
  }, { open: true, setup: false }));
}
