// Shared by Orbit's own assistant routes and the Universe-wide Nebula (hub). Pure helpers: they never decide who may call them.
import { formatMoney } from './money.js';
import { accountBalances, summarize, categoryBreakdown } from './ledger.js';
import { byId, pathOf } from './categories.js';
import { budgetStatus } from './budgets.js';
import { debtState } from './debts.js';
import { matchName } from './names.js';
import { todayIn, namedRange } from './dates.js';
import { resolveDraft, questionsFor } from './assistant.js';
import { badRequest } from '../../../shared/errors.js';

export function makeAssistantCore({ store, txn, debtOps }) {
  const { col, all } = store;
  async function loadCtx(user) {
    const [settings, accounts, cats, debts, txns, budgets] = await Promise.all([col.settings.get(user.id), all(col.accounts, user.id), all(col.cats, user.id), all(col.debts, user.id), all(col.txns, user.id), all(col.budgets, user.id)]);
    return { settings, accounts, cats, debts, txns, budgets, today: todayIn(settings.timezone) };
  }
  const viewOf = (draft, ctx) => { const r = resolveDraft(draft.fields, ctx); return { version: draft.version, status: draft.status, ...r, payload: undefined, debt: undefined, questions: questionsFor(r) }; };

  // The only figures the model may talk about: deterministic, with honest caveats.
  function runQuery(a, ctx) {
    const { settings, accounts, cats, debts, txns, today } = ctx, custom = settings.customCurrencies, cur = settings.currency, C = byId(cats);
    let range; try { range = namedRange(a.range || 'this_month', today, { weekStartsOn: settings.weekStartsOn, from: a.from, to: a.to }); } catch (e) { return { ok: false, error: e.message }; }
    const fmt = (m, c = cur) => formatMoney(m, c, custom), live = txns.filter((t) => t.status !== 'voided');
    const caveats = [];
    if (!live.length) caveats.push('There are no recorded transactions yet, so these figures are zero rather than verified.');
    else { const first = live.reduce((m, t) => (t.localDate < m ? t.localDate : m), '9999'); if (first > range.from && a.metric !== 'balance' && a.metric !== 'debts') caveats.push(`Your records only start on ${first}, so this period is incomplete.`); }
    const unc = live.filter((t) => ['income', 'expense'].includes(t.type) && !t.categoryId && t.localDate >= range.from && t.localDate <= range.to).length;
    let acct = null;
    if (a.account) { const m = matchName(a.account, accounts.map((x) => ({ id: x.id, names: [x.name], x }))); if (!m.match) return { ok: false, error: m.candidates.length ? `Which account? ${m.candidates.map((c) => c.x.name).join(', ')}` : `No account called "${a.account}"` }; acct = m.match.x; }
    const ids = acct ? [acct.id] : null, facts = [];
    if (a.metric === 'spent' || a.metric === 'earned') {
      const kind = a.metric === 'spent' ? 'expense' : 'income';
      let cat = null; if (a.category) { const m = matchName(a.category, cats.filter((c) => c.kind === kind).map((c) => ({ id: c.id, names: [pathOf(C, c.id), c.name], c }))); if (!m.match) return { ok: false, error: m.candidates.length ? `Which category? ${m.candidates.slice(0, 6).map((c) => pathOf(C, c.id)).join(', ')}` : `No ${kind} category called "${a.category}"` }; cat = m.match.c; }
      const bd = categoryBreakdown(txns, cats, { kind, range, accountIds: ids, currency: acct?.currency || cur });
      let total = bd.totalMinor, label = a.metric === 'spent' ? 'Spent' : 'Earned';
      if (cat) { const find = (n) => (n.id === cat.id ? n : n.children.map(find).find(Boolean)); total = bd.roots.map(find).find(Boolean)?.totalMinor ?? 0; label += ` on ${pathOf(C, cat.id)}`; }
      facts.push({ label: `${label} (${range.from} to ${range.to})`, value: fmt(total, acct?.currency || cur), minor: total });
      if (unc && !cat) caveats.push(`${unc} transactions in this period have no category.`);
    } else if (a.metric === 'net') {
      const sm = summarize(txns, { range, accountIds: ids || accounts.map((x) => x.id) })[acct?.currency || cur] || { income: 0, netExpense: 0, net: 0 };
      facts.push({ label: 'Income', value: fmt(sm.income), minor: sm.income }, { label: 'Spending (net of refunds)', value: fmt(sm.netExpense), minor: sm.netExpense }, { label: 'Net', value: fmt(sm.net), minor: sm.net });
    } else if (a.metric === 'balance') {
      const bal = accountBalances(accounts, txns);
      for (const x of acct ? [acct] : accounts.filter((y) => !y.archived)) facts.push({ label: x.name, value: fmt(bal.get(x.id) || 0, x.currency), minor: bal.get(x.id) || 0 });
      caveats.push('Balances are the opening balance you entered plus recorded transactions. They can differ from your bank if something is unrecorded.');
    } else if (a.metric === 'budget') {
      for (const b of ctx.budgets.filter((x) => !x.archived)) { const st = budgetStatus(b, txns, cats, today, settings.weekStartsOn); facts.push({ label: `${b.categoryId ? pathOf(C, b.categoryId) : 'All spending'} (${b.period})`, value: `${fmt(st.spentMinor, b.currency)} of ${fmt(st.availableMinor, b.currency)} (${st.percent}%)`, minor: st.spentMinor }); }
      if (!facts.length) caveats.push('No budgets are set up.');
    } else if (a.metric === 'debts') {
      for (const d of debts.filter((x) => !x.archived)) { const st = debtState(d, txns, today); if (st.status === 'open') facts.push({ label: `${d.direction === 'lent' ? 'Owed to you by' : 'You owe'} ${d.counterparty}`, value: fmt(st.outstandingMinor, d.currency), minor: st.outstandingMinor }); }
      if (!facts.length) caveats.push('No open debts are recorded.');
    }
    return { ok: true, facts, caveats, range, recordsConsidered: live.length };
  }


  // Saves a reviewed draft through the same validated, idempotent code the forms use. `chat` is the doc that holds the draft.
  async function confirmDraft(user, chat, ctx) {
    const c = chat;
    const r = resolveDraft(c.draft.fields, ctx);
    if (!r.ready) throw badRequest(`The draft is not complete: ${questionsFor(r).join(' ') || 'check the fields'}`, 'draft_incomplete');
    const key = `ai:${c.id}:${c.draft.version}`, p = r.payload, t = c.draft.fields.type; let result;
    if (t === 'lend' || t === 'borrow') {
      const d = await debtOps.createDebt(user, { direction: t === 'lend' ? 'lent' : 'borrowed', counterparty: r.fields.counterparty, principalMinor: p.amountMinor, currency: ctx.accounts.find((a) => a.id === p.accountId).currency, startDate: p.date, time: p.time, notes: p.notes, accountId: p.accountId, key, source: 'ai' });
      result = { kind: 'debt', id: d.debt.id, replayed: d.replayed };
    } else if (t === 'repay_received' || t === 'repay_made') {
      const x = await debtOps.repay(user, { debtId: r.resolved.debtId, accountId: p.accountId, amountMinor: p.amountMinor, date: p.date, time: p.time, notes: p.notes, key, source: 'ai' });
      result = { kind: 'transaction', id: x.transaction.id, replayed: x.replayed };
    } else {
      const x = await txn.create(user, p, { key, source: 'ai' });
      result = { kind: 'transaction', id: x.transaction.id, replayed: x.replayed, warnings: x.warnings };
    }
    return { result, summary: r.lines.map(([k, val]) => `${k}: ${val}`) };
  }
  return { loadCtx, viewOf, runQuery, confirmDraft };
}
