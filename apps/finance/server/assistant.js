// Turns what the AI PROPOSED into a checked, fully resolved draft. The model only ever supplies loose text fields
// (names, an amount as written, a date); this file decides what they mean using the user's real accounts, categories
// and debts, and says exactly what is missing or ambiguous. The model never sees ids, never writes, never sets balances.
import { parseMoney, MoneyError, formatMoney, toDecimal } from './money.js';
import { isDateStr, addDays } from './dates.js';
import { matchName } from './names.js';
import { byId, pathOf } from './categories.js';
import { debtState } from './debts.js';
import { HttpError } from '../../../shared/errors.js';

export const DRAFT_TYPES = ['income', 'expense', 'transfer', 'refund', 'adjustment', 'lend', 'borrow', 'repay_received', 'repay_made'];
export const FIELD_KEYS = ['type', 'amount', 'account', 'accountId', 'toAccount', 'toAccountId', 'category', 'categoryId', 'date', 'time', 'description', 'counterparty', 'notes', 'tags', 'direction', 'fee', 'toAmount', 'debtId'];
const VAGUE_PERSON = /^(my |a |an |the |some )?(friend|friends|someone|somebody|guy|person|man|woman|colleague|coworker|brother|sister|mum|mom|dad|him|her|them|they|he|she)$/i;
const ACCOUNTING = {
  income: 'Counts as income and increases the account balance.',
  expense: 'Counts as an expense and reduces the account balance.',
  transfer: 'Moves your own money between two accounts. It is NOT income or expense (a fee, if any, counts as an expense).',
  refund: 'Money coming back for an earlier purchase. It is NOT income: it reduces your spending in that category.',
  adjustment: 'Corrects the account balance. It is NOT income or expense.',
  lend: 'Money you lent: it leaves the account and you are owed it. It is NOT an expense, and getting it back later will NOT count as income.',
  borrow: 'Money you borrowed: it arrives in the account and you owe it. It is NOT income, and paying it back will NOT count as an expense.',
  repay_received: 'Someone paying you back. It reduces what they owe you and is NOT income.',
  repay_made: 'You paying a loan back. It reduces what you owe and is NOT an expense.',
};
const clean = (x, max) => (typeof x === 'string' ? x.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');

// Merge a model proposal (or a user edit) onto the current draft fields. Only known keys, only strings.
export function mergeFields(current, patch) {
  const out = { ...current };
  for (const k of FIELD_KEYS) {
    if (patch[k] === undefined) continue;
    const val = typeof patch[k] === 'string' ? clean(patch[k], k === 'notes' ? 1000 : 200) : patch[k];
    if (typeof val !== 'string') continue;
    out[k] = val;
    // an explicit id replaces the name that was there, and vice versa, so they never disagree
    const pair = { account: 'accountId', toAccount: 'toAccountId', category: 'categoryId' };
    for (const [n, id] of Object.entries(pair)) { if (k === n && val) delete out[id]; if (k === id && val) delete out[n]; }
    if (k === 'type') delete out.debtId;
  }
  return out;
}

const resolveDate = (x, today) => {
  const s = clean(x, 20).toLowerCase();
  if (!s || s === 'today') return today; if (s === 'yesterday') return addDays(today, -1);
  return isDateStr(s) ? s : null;
};

export function resolveDraft(fields, ctx) {
  const { settings, accounts, cats, debts = [], txns = [], today } = ctx, live = accounts.filter((a) => !a.archived), A = byId(accounts), C = byId(cats);
  const f = fields, v = { type: f.type || null, missing: [], ambiguous: [], errors: [], warnings: [], assumed: [], notes: [] };
  const custom = settings.customCurrencies;
  const pickAccount = (nameKey, idKey, field, label) => {
    if (f[idKey]) { const a = A.get(f[idKey]); if (a && !a.archived) return a; v.errors.push(`${label} is not available`); return null; }
    if (!f[nameKey]) { v.missing.push({ field, question: `Which account ${label}?`, options: live.map((a) => a.name) }); return null; }
    const m = matchName(f[nameKey], live.map((a) => ({ id: a.id, names: [a.name, a.provider].filter(Boolean), a })));
    if (m.match) { if (m.matchedBy === 'partial') v.notes.push(`I matched "${f[nameKey]}" to ${m.match.a.name}.`); return m.match.a; }
    if (m.candidates.length > 1) v.ambiguous.push({ field, question: `Which account did you mean by "${f[nameKey]}"?`, options: m.candidates.map((c) => c.a.name) });
    else v.missing.push({ field, question: `I could not find an account called "${f[nameKey]}". Which one ${label}?`, options: live.map((a) => a.name) });
    return null;
  };
  const type = f.type;
  if (!DRAFT_TYPES.includes(type)) { v.missing.push({ field: 'type', question: 'Is this income, an expense, a transfer, a loan, or something else?', options: ['Income', 'Expense', 'Transfer', 'I lent money', 'I borrowed money'] }); return finish(v, f, ctx); }

  const acct = pickAccount('account', 'accountId', 'account', type === 'income' || type === 'borrow' || type === 'repay_received' || type === 'refund' ? 'did the money go into' : type === 'adjustment' ? 'is being corrected' : 'did the money come from');
  let to = null;
  if (type === 'transfer') { to = pickAccount('toAccount', 'toAccountId', 'toAccount', 'did it go to'); if (acct && to && acct.id === to.id) { v.errors.push('Choose two different accounts'); to = null; } }

  const cur = acct?.currency || settings.currency;
  let amountMinor = null;
  if (!f.amount) v.missing.push({ field: 'amount', question: 'How much?' });
  else { try { amountMinor = parseMoney(f.amount, cur, custom); if (amountMinor < 1) throw new MoneyError('Amount must be above zero'); } catch (e) { if (e instanceof MoneyError) v.missing.push({ field: 'amount', question: `I could not read the amount "${f.amount}". How much exactly?` }); else throw e; } }

  const date = resolveDate(f.date, today);
  if (date === null) v.missing.push({ field: 'date', question: `I could not read the date "${f.date}". Which day (like 2026-10-09)?` });
  if (!f.date) v.assumed.push('date');

  let category = null;
  if (['income', 'expense', 'refund'].includes(type)) {
    const kind = type === 'income' ? 'income' : 'expense', pool = cats.filter((c) => !c.archived && c.kind === kind);
    if (f.categoryId) { const c = C.get(f.categoryId); if (c && c.kind === kind && !c.archived) category = c; else v.errors.push('That category is not available'); }
    else if (f.category) {
      const m = matchName(f.category, pool.map((c) => ({ id: c.id, names: [pathOf(C, c.id), c.name], c })));
      if (m.match) category = m.match.c;
      else if (m.candidates.length > 1) v.ambiguous.push({ field: 'category', question: `Which category fits "${f.category}"?`, options: m.candidates.slice(0, 6).map((c) => pathOf(C, c.id)) });
      else v.warnings.push(`I could not find a category for "${f.category}", so it will be saved without one. You can pick one below.`);
    } else v.warnings.push('No category chosen. You can pick one below.');
  }

  let debt = null, counterparty = clean(f.counterparty, 100);
  if (type === 'lend' || type === 'borrow') {
    if (!counterparty || VAGUE_PERSON.test(counterparty)) v.missing.push({ field: 'counterparty', question: type === 'lend' ? 'Who did you lend it to? (a name or organisation)' : 'Who did you borrow it from? (a name or organisation)' });
  }
  if (type === 'repay_received' || type === 'repay_made') {
    const dir = type === 'repay_received' ? 'lent' : 'borrowed';
    const open = debts.map((d) => ({ d, s: debtState(d, txns, today) })).filter((x) => !x.d.archived && x.d.direction === dir && x.s.status === 'open' && (!acct || x.d.currency === acct.currency));
    if (f.debtId) { debt = open.find((x) => x.d.id === f.debtId)?.d || null; if (!debt) v.errors.push('That debt is not open'); }
    else if (!counterparty || VAGUE_PERSON.test(counterparty)) v.missing.push({ field: 'counterparty', question: type === 'repay_received' ? 'Who paid you back?' : 'Who did you pay back?', options: open.map((x) => x.d.counterparty) });
    else {
      const m = matchName(counterparty, open.map((x) => ({ id: x.d.id, names: [x.d.counterparty], x })));
      if (m.match) debt = m.match.x.d;
      else if (m.candidates.length > 1) v.ambiguous.push({ field: 'debtId', question: `Which debt is this for? You have more than one open with "${counterparty}".`, options: m.candidates.map((c) => `${c.x.d.counterparty} (${formatMoney(c.x.s.outstandingMinor, c.x.d.currency, custom)} outstanding)`), ids: m.candidates.map((c) => c.id) });
      else v.errors.push(`I could not find an open debt with "${counterparty}". Record the loan first, or check the name.`);
    }
    if (debt) { counterparty = debt.counterparty; const out = debtState(debt, txns, today).outstandingMinor; if (amountMinor && amountMinor > out) v.errors.push(`That is more than the ${formatMoney(out, debt.currency, custom)} still outstanding.`); }
  }
  if (type === 'adjustment' && !['increase', 'decrease'].includes(f.direction)) v.missing.push({ field: 'direction', question: 'Should the balance go up or down?', options: ['increase', 'decrease'] });

  // fee on transfers
  let feeMinor = 0;
  if (type === 'transfer' && f.fee) { try { feeMinor = parseMoney(f.fee, cur, custom); } catch { v.errors.push(`I could not read the fee "${f.fee}"`); } }
  if (type === 'transfer' && acct && to && acct.currency !== to.currency && !f.toAmount) v.missing.push({ field: 'toAmount', question: `How much arrives in ${to.name} (${to.currency})?` });

  const description = clean(f.description, 200);
  const payload = amountMinor && acct && date ? { type: type === 'lend' ? 'loan_out' : type === 'borrow' ? 'loan_in' : type === 'repay_received' ? 'repay_in' : type === 'repay_made' ? 'repay_out' : type,
    accountId: acct.id, amountMinor, date, ...(clean(f.time, 5) ? { time: clean(f.time, 5) } : {}), description, counterparty, notes: clean(f.notes, 1000),
    tags: clean(f.tags, 200).split(/[\s,;#]+/).filter(Boolean).slice(0, 20), ...(category ? { categoryId: category.id } : {}), ...(to ? { toAccountId: to.id } : {}), ...(feeMinor ? { feeMinor } : {}), ...(f.toAmount && type === 'transfer' ? { toAmount: f.toAmount } : {}), ...(f.direction ? { direction: f.direction } : {}) } : null;
  return finish(v, f, ctx, { acct, to, category, debt, amountMinor, date, payload, counterparty, description, feeMinor, cur });
}

function finish(v, f, ctx, r = {}) {
  const { settings } = ctx, custom = settings.customCurrencies, t = f.type;
  const ready = !!r.payload && !v.missing.length && !v.ambiguous.length && !v.errors.length;
  const lines = [];
  if (t) lines.push(['Type', { lend: 'Lend (money out, owed to you)', borrow: 'Borrow (money in, you owe)', repay_received: 'Repayment received', repay_made: 'Repayment made' }[t] || t[0].toUpperCase() + t.slice(1)]);
  if (r.amountMinor) lines.push(['Amount', formatMoney(r.amountMinor, r.cur, custom)]);
  if (r.acct) lines.push([t === 'transfer' ? 'From' : 'Account', r.acct.name]);
  if (r.to) lines.push(['To', r.to.name]);
  if (r.feeMinor) lines.push(['Fee', formatMoney(r.feeMinor, r.cur, custom)]);
  if (['income', 'expense', 'refund'].includes(t)) lines.push(['Category', r.category ? pathOf(byId(ctx.cats), r.category.id) : 'None']);
  if (r.counterparty) lines.push([t === 'income' ? 'From' : ['lend', 'borrow', 'repay_received', 'repay_made'].includes(t) ? 'Person' : 'Payee', r.counterparty]);
  if (r.date) lines.push(['Date', r.date]);
  if (r.description) lines.push(['Description', r.description]);
  if (f.direction) lines.push(['Direction', f.direction]);
  return { ...v, ready, lines, accounting: ACCOUNTING[t] || null, fields: f,
    resolved: { accountId: r.acct?.id ?? null, toAccountId: r.to?.id ?? null, categoryId: r.category?.id ?? null, debtId: r.debt?.id ?? null },
    amountText: r.amountMinor ? toDecimal(r.amountMinor, r.cur, custom) : '', payload: ready ? r.payload : null, debt: r.debt ?? null };
}

// The questions the user is asked, written by code (not by the model), so they are always about real, checked gaps.
export function questionsFor(view) {
  const q = [...view.errors, ...view.ambiguous.map((a) => `${a.question} ${a.options.join(', ')}?`), ...view.missing.map((m) => (m.options?.length ? `${m.question} (${m.options.slice(0, 8).join(', ')})` : m.question))];
  return q.slice(0, 2); // concise: at most two things at a time
}
