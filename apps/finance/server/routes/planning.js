// Budgets, debts, goals, recurring bills and net worth.
import { createHash } from 'node:crypto';
import { v, allowKeys } from '../../../../shared/validate.js';
import { badRequest, conflict, notFound } from '../../../../shared/errors.js';
import { newId, nowIso } from '../../../../shared/ids.js';
import { reply } from '../../../../http/http.js';
import { parseMoney, MoneyError, currencyInfo } from '../money.js';
import { isDateStr, todayIn, addDays } from '../dates.js';
import { accountBalances, isPosted } from '../ledger.js';
import { byId, pathOf } from '../categories.js';
import { PERIODS, budgetStatus, summarizeBudgets } from '../budgets.js';
import { debtState, debtHistory, repaymentType, fundingType } from '../debts.js';
import { makeDebtOps } from '../debtops.js';
import { goalProgress, dueOccurrences, nextDate, FREQUENCIES, netWorth } from '../planning.js';

export function planningRoutes({ router, s, store, txn, guard, P }) {
  const { col, all, own, audit, diff, storage } = store;
  const use = (h, o) => guard('finance.access', h, o);
  const strip = ({ ownerId, ...d }) => d;
  const bump = (d) => ({ version: (d.version || 1) + 1 });
  const money = (st, x, cur, name = 'amount', { allowZero = false } = {}) => {
    try { const m = parseMoney(x, cur, st.customCurrencies); if (!allowZero && m < 1) throw new MoneyError(`${name} must be greater than zero`); return m; } catch (e) { if (e instanceof MoneyError) throw badRequest(e.message, 'invalid_amount'); throw e; }
  };
  const date = (x, name) => { if (!isDateStr(x)) throw badRequest(`${name} must look like 2026-01-31`); return x; };
  const curOf = (st, c) => { const x = c ?? st.currency; if (!currencyInfo(x, st.customCurrencies)) throw badRequest('Unknown currency'); return x; };
  const debtOps = makeDebtOps(store, txn);

  // ===================== budgets =====================
  const BUD = ['name', 'categoryId', 'period', 'startDate', 'endDate', 'amount', 'currency', 'rollover', 'warnAtPercent', 'includeSubcategories'];
  async function budgetViews(user) {
    const [st, budgets, cats, txns] = await Promise.all([col.settings.get(user.id), all(col.budgets, user.id), all(col.cats, user.id), all(col.txns, user.id)]);
    const today = todayIn(st.timezone), live = budgets.filter((b) => !b.archived), statuses = new Map(live.map((b) => [b.id, budgetStatus(b, txns, cats, today, st.weekStartsOn)]));
    const summary = summarizeBudgets(live, statuses, cats), map = byId(cats);
    return { summary, budgets: live.map((b) => ({ ...strip(b), categoryPath: b.categoryId ? pathOf(map, b.categoryId) : 'All spending', status: statuses.get(b.id) })) };
  }
  router.add('GET', `${P}/budgets`, use(async ({ user }) => budgetViews(user)));
  function parseBudget(b, st, cats, existing) {
    const o = {};
    if ('name' in b) o.name = v.string(b.name ?? '', 'name', { max: 60 });
    if (!existing || 'categoryId' in b) {
      if (b.categoryId) { const c = cats.find((x) => x.id === b.categoryId); if (!c || c.kind !== 'expense') throw badRequest('Choose one of your expense categories'); o.categoryId = c.id; } else o.categoryId = null;
    }
    if (!existing || 'period' in b) o.period = v.enum(b.period, 'period', PERIODS);
    const period = o.period ?? existing.period;
    if (period === 'custom') {
      o.startDate = date(b.startDate ?? existing?.startDate, 'startDate'); o.endDate = date(b.endDate ?? existing?.endDate, 'endDate');
      if (o.startDate > o.endDate) throw badRequest('startDate must not be after endDate');
    }
    if (!existing || 'currency' in b) o.currency = curOf(st, b.currency);
    if (!existing || 'amount' in b) o.amountMinor = money(st, b.amount, o.currency ?? existing.currency, 'amount');
    if ('rollover' in b) o.rollover = !!b.rollover && period !== 'custom';
    if ('includeSubcategories' in b) o.includeSubcategories = b.includeSubcategories !== false;
    if ('warnAtPercent' in b) { if (!Number.isInteger(b.warnAtPercent) || b.warnAtPercent < 1 || b.warnAtPercent > 100) throw badRequest('warnAtPercent must be a whole number from 1 to 100'); o.warnAtPercent = b.warnAtPercent; }
    return o;
  }
  router.add('POST', `${P}/budgets`, use(async ({ user, body }) => {
    const b = allowKeys(v.object(body), BUD), st = await col.settings.get(user.id), cats = await all(col.cats, user.id), f = parseBudget(b, st, cats, null);
    return storage.transaction(async () => {
      if (f.period !== 'custom' && (await all(col.budgets, user.id)).some((x) => !x.archived && x.period === f.period && (x.categoryId || null) === (f.categoryId || null) && x.currency === f.currency)) throw conflict('You already have a budget like this. Edit that one instead.', 'duplicate_budget');
      const now = nowIso(), doc = await col.budgets.insert({ id: newId('bud'), schemaVersion: 1, ownerId: user.id, name: '', rollover: false, warnAtPercent: 80, includeSubcategories: true, archived: false, createdLocalDate: todayIn(st.timezone), ...f, version: 1, createdAt: now, updatedAt: now });
      await audit(user.id, { action: 'budget.create', entityType: 'budget', entityId: doc.id, source: 'manual' });
      return reply(201, { budget: strip(doc) });
    });
  }));
  router.add('PATCH', `${P}/budgets/:id`, use(async ({ user, params, body }) => {
    const b = allowKeys(v.object(body), BUD), st = await col.settings.get(user.id), cats = await all(col.cats, user.id);
    return storage.transaction(async () => {
      const old = await own(col.budgets, params.id, user.id, 'Budget'), f = parseBudget(b, st, cats, old);
      const doc = await col.budgets.update(old.id, { ...f, ...bump(old) });
      await audit(user.id, { action: 'budget.update', entityType: 'budget', entityId: doc.id, source: 'manual', changes: diff(old, doc, Object.keys(f)) });
      return { budget: strip(doc) };
    });
  }));
  router.add('DELETE', `${P}/budgets/:id`, use(async ({ user, params }) => storage.transaction(async () => {
    const old = await own(col.budgets, params.id, user.id, 'Budget'); await col.budgets.delete(old.id);
    await audit(user.id, { action: 'budget.delete', entityType: 'budget', entityId: old.id, source: 'manual' }); return { ok: true };
  })));

  // ===================== debts =====================
  const DEBT = ['direction', 'counterparty', 'amount', 'currency', 'startDate', 'dueDate', 'notes', 'accountId', 'noCashMovement', 'idempotencyKey'];
  async function debtViews(user, { includeAll = false } = {}) {
    const [st, debts, txns] = await Promise.all([col.settings.get(user.id), all(col.debts, user.id), all(col.txns, user.id)]);
    const today = todayIn(st.timezone);
    const list = debts.filter((d) => includeAll || !d.archived).map((d) => ({ ...strip(d), ...debtState(d, txns, today) }));
    const totals = {}; for (const d of list) if (d.status === 'open') { const t = (totals[d.currency] ??= { owedToYouMinor: 0, youOweMinor: 0 }); t[d.direction === 'lent' ? 'owedToYouMinor' : 'youOweMinor'] += d.outstandingMinor; }
    return { debts: list.sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || (a.dueDate || '9') .localeCompare(b.dueDate || '9')), totals };
  }
  router.add('GET', `${P}/debts`, use(async ({ user, query }) => debtViews(user, { includeAll: query.get('all') === 'true' })));
  router.add('GET', `${P}/debts/:id`, use(async ({ user, params }) => {
    const d = await own(col.debts, params.id, user.id, 'Debt'), st = await col.settings.get(user.id), txns = (await all(col.txns, user.id)).filter((t) => t.debtId === d.id);
    return { debt: { ...strip(d), ...debtState(d, txns, todayIn(st.timezone)) }, history: debtHistory(d, txns), transactions: txns.map(strip) };
  }));
  // Lending/borrowing. With an account, the cash movement is recorded in the same all-or-nothing step as the debt itself.
  router.add('POST', `${P}/debts`, use(async ({ user, body }) => {
    const b = allowKeys(v.object(body), DEBT), st = await col.settings.get(user.id);
    const direction = v.enum(b.direction, 'direction', ['lent', 'borrowed']), counterparty = v.string(b.counterparty, 'counterparty', { min: 1, max: 100 });
    const accounts = await all(col.accounts, user.id), noCash = b.noCashMovement === true, acct = accounts.find((a) => a.id === b.accountId);
    if (!noCash && !acct) throw badRequest('Choose the account the money moved through, or tick "no cash movement" for an older debt.', 'unknown_account');
    const currency = acct ? acct.currency : curOf(st, b.currency), principalMinor = money(st, b.amount, currency);
    const startDate = b.startDate ? date(b.startDate, 'startDate') : todayIn(st.timezone), dueDate = b.dueDate ? date(b.dueDate, 'dueDate') : null;
    if (dueDate && dueDate < startDate) throw badRequest('The due date is before the start date');
    const key = typeof b.idempotencyKey === 'string' ? b.idempotencyKey : null; if (!key || key.length < 8) throw badRequest('idempotencyKey is required', 'idempotency_required');
    const r = await debtOps.createDebt(user, { direction, counterparty, principalMinor, currency, startDate, dueDate, notes: v.string(b.notes ?? '', 'notes', { max: 500 }), accountId: acct?.id, noCash, key });
    return reply(r.replayed ? 200 : 201, { debt: strip(r.debt), replayed: r.replayed });
  }));
  router.add('PATCH', `${P}/debts/:id`, use(async ({ user, params, body }) => {
    const b = allowKeys(v.object(body), ['counterparty', 'dueDate', 'notes']), f = {};
    if ('counterparty' in b) f.counterparty = v.string(b.counterparty, 'counterparty', { min: 1, max: 100 });
    if ('dueDate' in b) f.dueDate = b.dueDate ? date(b.dueDate, 'dueDate') : null;
    if ('notes' in b) f.notes = v.string(b.notes ?? '', 'notes', { max: 500 });
    return storage.transaction(async () => { const old = await own(col.debts, params.id, user.id, 'Debt'); const d = await col.debts.update(old.id, { ...f, ...bump(old) });
      await audit(user.id, { action: 'debt.update', entityType: 'debt', entityId: d.id, source: 'manual', changes: diff(old, d, Object.keys(f)) }); return { debt: strip(d) }; });
  }));
  router.add('POST', `${P}/debts/:id/repayments`, use(async ({ user, params, body }) => {
    const b = allowKeys(v.object(body), ['amount', 'accountId', 'date', 'time', 'notes', 'idempotencyKey']), st = await col.settings.get(user.id);
    const key = typeof b.idempotencyKey === 'string' ? b.idempotencyKey : null; if (!key || key.length < 8) throw badRequest('idempotencyKey is required', 'idempotency_required');
    const d = await own(col.debts, params.id, user.id, 'Debt');
    const r = await debtOps.repay(user, { debtId: d.id, accountId: b.accountId, amountMinor: money(st, b.amount, d.currency), date: b.date, time: b.time, notes: b.notes, key });
    return reply(r.replayed ? 200 : 201, { transaction: strip(r.transaction), replayed: r.replayed, debt: strip(r.debt) });
  }));
  router.add('POST', `${P}/debts/:id/write-off`, use(async ({ user, params, body }) => {
    const b = allowKeys(v.object(body), ['amount', 'note', 'confirm']), st = await col.settings.get(user.id);
    if (b.confirm !== true) throw badRequest('Writing off a debt must be confirmed (confirm: true)', 'confirmation_required');
    return storage.transaction(async () => {
      const d = await own(col.debts, params.id, user.id, 'Debt'), txns = (await all(col.txns, user.id)).filter((t) => t.debtId === d.id), state = debtState(d, txns, todayIn(st.timezone));
      const amountMinor = b.amount === undefined ? state.outstandingMinor : money(st, b.amount, d.currency);
      if (amountMinor < 1 || amountMinor > state.outstandingMinor) throw conflict('Nothing to write off, or more than is outstanding', 'bad_amount');
      const events = [...(d.events || []), { kind: 'written_off', amountMinor, date: todayIn(st.timezone), note: v.string(b.note ?? '', 'note', { max: 200 }) }];
      const nd = await col.debts.update(d.id, { events, ...bump(d) });
      await audit(user.id, { action: 'debt.write_off', entityType: 'debt', entityId: d.id, source: 'manual' });
      return { debt: { ...strip(nd), ...debtState(nd, txns, todayIn(st.timezone)) }, note: 'No money moved, so this is not counted as income or expense. It only removes the amount from what is owed.' };
    });
  }));
  router.add('POST', `${P}/debts/:id/archive`, use(async ({ user, params }) => storage.transaction(async () => { const old = await own(col.debts, params.id, user.id, 'Debt'); return { debt: strip(await col.debts.update(old.id, { archived: !old.archived, ...bump(old) })) }; })));
  // Deleting a debt that has had no repayments also voids the transaction that created it, so balances stay right.
  router.add('DELETE', `${P}/debts/:id`, use(async ({ user, params, body }) => {
    if (body?.confirm !== true) throw badRequest('Deleting must be confirmed (confirm: true)', 'confirmation_required');
    return storage.transaction(async () => {
      const d = await own(col.debts, params.id, user.id, 'Debt'), linked = (await all(col.txns, user.id)).filter((t) => t.debtId === d.id && isPosted(t) && t.id !== d.fundingTransactionId);
      if (linked.length) throw conflict('This debt has repayments. Void them first, or archive the debt to keep its history.', 'has_repayments');
      if (d.fundingTransactionId) { const f = await col.txns.get(d.fundingTransactionId); if (f && isPosted(f)) await col.txns.update(f.id, { status: 'voided', voidedAt: nowIso(), voidReason: 'Debt deleted', voidedBy: user.id, version: f.version + 1, fundsDebtId: null }); }
      await col.debts.delete(d.id); await audit(user.id, { action: 'debt.delete', entityType: 'debt', entityId: d.id, source: 'manual' });
      return { ok: true };
    });
  }));

  // ===================== goals & sinking funds =====================
  const GOAL = ['name', 'kind', 'target', 'currency', 'deadline', 'accountId', 'notes', 'icon', 'color'];
  async function goalViews(user) {
    const [st, goals, txns] = await Promise.all([col.settings.get(user.id), all(col.goals, user.id), all(col.txns, user.id)]);
    return goals.filter((g) => !g.archived).map((g) => ({ ...strip(g), progress: goalProgress(g, txns, todayIn(st.timezone)) }));
  }
  router.add('GET', `${P}/goals`, use(async ({ user }) => ({ goals: await goalViews(user) })));
  function parseGoal(b, st, existing) {
    const o = {};
    if (!existing || 'name' in b) o.name = v.string(b.name, 'name', { min: 1, max: 60 });
    if (!existing || 'kind' in b) o.kind = v.enum(b.kind ?? 'goal', 'kind', ['goal', 'sinking_fund']);
    if (!existing || 'currency' in b) o.currency = curOf(st, b.currency);
    if (!existing || 'target' in b) o.targetMinor = money(st, b.target, o.currency ?? existing.currency, 'target');
    if ('deadline' in b) o.deadline = b.deadline ? date(b.deadline, 'deadline') : null;
    if ('accountId' in b) o.accountId = b.accountId || null;
    if ('notes' in b) o.notes = v.string(b.notes ?? '', 'notes', { max: 300 });
    if ('icon' in b) o.icon = b.icon ? v.string(b.icon, 'icon', { max: 8 }) : null;
    if ('color' in b) o.color = b.color && /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : null;
    return o;
  }
  router.add('POST', `${P}/goals`, use(async ({ user, body }) => {
    const b = allowKeys(v.object(body), GOAL), st = await col.settings.get(user.id), f = parseGoal(b, st, null);
    return storage.transaction(async () => {
      if (f.accountId) await own(col.accounts, f.accountId, user.id, 'Account');
      const now = nowIso(), g = await col.goals.insert({ id: newId('goal'), schemaVersion: 1, ownerId: user.id, deadline: null, accountId: null, notes: '', archived: false, ...f, version: 1, createdAt: now, updatedAt: now });
      await audit(user.id, { action: 'goal.create', entityType: 'goal', entityId: g.id, source: 'manual' }); return reply(201, { goal: strip(g) });
    });
  }));
  router.add('PATCH', `${P}/goals/:id`, use(async ({ user, params, body }) => {
    const b = allowKeys(v.object(body), GOAL), st = await col.settings.get(user.id);
    return storage.transaction(async () => { const old = await own(col.goals, params.id, user.id, 'Goal'), f = parseGoal(b, st, old);
      if (f.accountId) await own(col.accounts, f.accountId, user.id, 'Account'); return { goal: strip(await col.goals.update(old.id, { ...f, ...bump(old) })) }; });
  }));
  router.add('DELETE', `${P}/goals/:id`, use(async ({ user, params }) => storage.transaction(async () => { const old = await own(col.goals, params.id, user.id, 'Goal'); return { goal: strip(await col.goals.update(old.id, { archived: true, ...bump(old) })) }; })));
  // Contribute = a real transfer between two of your accounts, tagged with the goal.
  router.add('POST', `${P}/goals/:id/contributions`, use(async ({ user, params, body }) => {
    const b = allowKeys(v.object(body), ['fromAccountId', 'toAccountId', 'amount', 'date', 'idempotencyKey']);
    return storage.transaction(async () => {
      const g = await own(col.goals, params.id, user.id, 'Goal'), toId = b.toAccountId || g.accountId;
      if (!toId) throw badRequest('Choose the savings account this goes into', 'unknown_account');
      const r = await txn.insertTx(user, { type: 'transfer', accountId: b.fromAccountId, toAccountId: toId, amount: b.amount, date: b.date, goalId: g.id, description: `Saving for ${g.name}` }, { key: b.idempotencyKey });
      return reply(r.replayed ? 200 : 201, { transaction: strip(r.transaction), replayed: r.replayed });
    });
  }));

  // ===================== recurring bills, subscriptions, planned expenses =====================
  const REC = ['name', 'kind', 'type', 'amount', 'currency', 'accountId', 'categoryId', 'counterparty', 'frequency', 'interval', 'nextDue', 'endDate', 'reminderDays', 'notes'];
  router.add('GET', `${P}/recurring`, use(async ({ user }) => {
    const [st, rules] = await Promise.all([col.settings.get(user.id), all(col.recurring, user.id)]), today = todayIn(st.timezone);
    const live = rules.filter((r) => !r.archived);
    const due = live.flatMap((r) => dueOccurrences(r, today, { horizonDays: r.reminderDays ?? 7, max: 6 }).map((o) => ({ ...o, name: r.name, kind: r.kind, type: r.type, amountMinor: r.amountMinor, currency: r.currency, accountId: r.accountId, categoryId: r.categoryId })));
    return { rules: live.map(strip), due: due.sort((a, b) => a.dueDate.localeCompare(b.dueDate)) };
  }));
  async function parseRule(b, st, user, existing) {
    const o = {};
    if (!existing || 'name' in b) o.name = v.string(b.name, 'name', { min: 1, max: 60 });
    if (!existing || 'kind' in b) o.kind = v.enum(b.kind ?? 'bill', 'kind', ['bill', 'subscription', 'income', 'planned']);
    if (!existing || 'type' in b) o.type = v.enum(b.type ?? (o.kind === 'income' ? 'income' : 'expense'), 'type', ['expense', 'income']);
    if (!existing || 'accountId' in b) { const a = await own(col.accounts, b.accountId, user.id, 'Account'); o.accountId = a.id; o.currency = a.currency; }
    if (!existing || 'amount' in b) o.amountMinor = money(st, b.amount, o.currency ?? existing.currency, 'amount');
    if ('categoryId' in b) { if (b.categoryId) { const c = await own(col.cats, b.categoryId, user.id, 'Category'); if (c.kind !== (o.type ?? existing.type)) throw badRequest('The category type does not match'); o.categoryId = c.id; } else o.categoryId = null; }
    if ('counterparty' in b) o.counterparty = v.string(b.counterparty ?? '', 'counterparty', { max: 100 });
    if (!existing || 'frequency' in b) o.frequency = v.enum(b.frequency ?? 'monthly', 'frequency', FREQUENCIES);
    if ('interval' in b) { if (!Number.isInteger(b.interval) || b.interval < 1 || b.interval > 52) throw badRequest('interval must be 1 to 52'); o.interval = b.interval; }
    if (!existing || 'nextDue' in b) o.nextDue = date(b.nextDue, 'nextDue');
    if ('endDate' in b) o.endDate = b.endDate ? date(b.endDate, 'endDate') : null;
    if ('reminderDays' in b) { if (!Number.isInteger(b.reminderDays) || b.reminderDays < 0 || b.reminderDays > 60) throw badRequest('reminderDays must be 0 to 60'); o.reminderDays = b.reminderDays; }
    if ('notes' in b) o.notes = v.string(b.notes ?? '', 'notes', { max: 300 });
    return o;
  }
  router.add('POST', `${P}/recurring`, use(async ({ user, body }) => {
    const b = allowKeys(v.object(body), REC), st = await col.settings.get(user.id);
    return storage.transaction(async () => { const f = await parseRule(b, st, user, null), now = nowIso();
      const r = await col.recurring.insert({ id: newId('rec'), schemaVersion: 1, ownerId: user.id, interval: 1, reminderDays: 7, categoryId: null, counterparty: '', notes: '', endDate: null, archived: false, ...f, version: 1, createdAt: now, updatedAt: now });
      await audit(user.id, { action: 'recurring.create', entityType: 'recurring', entityId: r.id, source: 'manual' }); return reply(201, { rule: strip(r) }); });
  }));
  router.add('PATCH', `${P}/recurring/:id`, use(async ({ user, params, body }) => {
    const b = allowKeys(v.object(body), REC), st = await col.settings.get(user.id);
    return storage.transaction(async () => { const old = await own(col.recurring, params.id, user.id, 'Recurring item'), f = await parseRule(b, st, user, old); return { rule: strip(await col.recurring.update(old.id, { ...f, ...bump(old) })) }; });
  }));
  router.add('DELETE', `${P}/recurring/:id`, use(async ({ user, params }) => storage.transaction(async () => { const old = await own(col.recurring, params.id, user.id, 'Recurring item'); await col.recurring.delete(old.id); return { ok: true }; })));
  // Post (or skip) ONE due occurrence. The key is derived from rule + due date, so double-taps and retries cannot post it twice.
  for (const action of ['post', 'skip']) {
    router.add('POST', `${P}/recurring/:id/${action}`, use(async ({ user, params, body }) => {
      const b = allowKeys(v.object(body), ['dueDate', 'amount', 'accountId', 'date']);
      return storage.transaction(async () => {
        const r = await own(col.recurring, params.id, user.id, 'Recurring item'), due = date(b.dueDate, 'dueDate');
        const prior = await col.idem.get(txn.idemId(user.id, `rule:${r.id}:${due}`));
        if (prior) return { transaction: strip(await col.txns.get(prior.resultId)), replayed: true };
        if (r.nextDue !== due) throw conflict('That occurrence was already handled. Reload to see the current schedule.', 'not_due');
        let out = { skipped: true };
        if (action === 'post') {
          const st = await col.settings.get(user.id);
          const t = await txn.insertTx(user, { type: r.type, accountId: b.accountId || r.accountId, amountMinor: b.amount !== undefined ? money(st, b.amount, r.currency) : r.amountMinor, categoryId: r.categoryId, description: r.name, counterparty: r.counterparty, date: b.date || due }, { key: `rule:${r.id}:${due}`, source: 'recurring' });
          out = { transaction: strip(t.transaction), replayed: false };
        }
        const next = nextDate(due, r.frequency, r.interval || 1);
        await col.recurring.update(r.id, next && (!r.endDate || next <= r.endDate) ? { nextDue: next, ...bump(r) } : { nextDue: null, archived: true, ...bump(r) });
        return out;
      });
    }));
  }

  // ===================== net worth =====================
  router.add('GET', `${P}/networth`, use(async ({ user }) => {
    const [st, accounts, txns, debts, items] = await Promise.all([col.settings.get(user.id), all(col.accounts, user.id), all(col.txns, user.id), all(col.debts, user.id), all(col.items, user.id)]);
    const today = todayIn(st.timezone), bal = accountBalances(accounts, txns), states = new Map(debts.filter((d) => !d.archived).map((d) => [d.id, debtState(d, txns, today)]));
    return { byCurrency: netWorth({ accounts, balances: bal, debts: debts.filter((d) => !d.archived), debtStates: states, items }), items: items.map(strip),
      explanation: 'Net worth = balances of your accounts (unless excluded) + money owed to you - money you owe + assets you list here - liabilities you list here. Each currency is shown separately; nothing is converted.' };
  }));
  const NWI = ['name', 'kind', 'value', 'currency', 'notes'];
  router.add('POST', `${P}/networth/items`, use(async ({ user, body }) => {
    const b = allowKeys(v.object(body), NWI), st = await col.settings.get(user.id), currency = curOf(st, b.currency);
    return storage.transaction(async () => { const now = nowIso(), i = await col.items.insert({ id: newId('nwi'), schemaVersion: 1, ownerId: user.id, name: v.string(b.name, 'name', { min: 1, max: 60 }), kind: v.enum(b.kind, 'kind', ['asset', 'liability']), valueMinor: money(st, b.value, currency, 'value'), currency, notes: v.string(b.notes ?? '', 'notes', { max: 200 }), asOf: todayIn(st.timezone), version: 1, createdAt: now, updatedAt: now }); return reply(201, { item: strip(i) }); });
  }));
  router.add('PATCH', `${P}/networth/items/:id`, use(async ({ user, params, body }) => {
    const b = allowKeys(v.object(body), NWI), st = await col.settings.get(user.id);
    return storage.transaction(async () => { const old = await own(col.items, params.id, user.id, 'Item'), f = {};
      if ('name' in b) f.name = v.string(b.name, 'name', { min: 1, max: 60 }); if ('value' in b) { f.valueMinor = money(st, b.value, old.currency, 'value'); f.asOf = todayIn(st.timezone); }
      if ('notes' in b) f.notes = v.string(b.notes ?? '', 'notes', { max: 200 }); return { item: strip(await col.items.update(old.id, { ...f, ...bump(old) })) }; });
  }));
  router.add('DELETE', `${P}/networth/items/:id`, use(async ({ user, params }) => storage.transaction(async () => { const old = await own(col.items, params.id, user.id, 'Item'); await col.items.delete(old.id); return { ok: true }; })));
}
