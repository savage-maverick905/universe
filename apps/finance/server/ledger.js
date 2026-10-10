// Deterministic accounting. Pure functions: no storage, no clock, no network. Everything the app shows as a total,
// balance or report is computed here from posted transactions, never by the AI and never trusted from the browser.
//
// ACCOUNTING RULES (also shown to the user in the UI):
//  income      money in; counts as income.
//  expense     money out; counts as expense.
//  transfer    moves money between two of YOUR accounts. NOT income, NOT expense. One document touches both accounts,
//              so it can never be half applied. An optional fee is taken from the source account and counts as an expense.
//  refund      money back for an earlier expense. NOT income: it REDUCES expense (in the category of the original purchase).
//  adjustment  corrects an account balance (found/lost cash, reconciliation). NOT income or expense; reported separately.
//  loan_out    you lend money: cash leaves, you are owed it. NOT an expense.   repay_in:  someone pays you back. NOT income.
//  loan_in     you borrow money: cash arrives, you owe it. NOT income.         repay_out: you pay a loan back. NOT an expense.
// Gifts are ordinary income / expense with a category (they are not debts). Voided transactions are ignored everywhere.
export const TYPES = ['income', 'expense', 'transfer', 'refund', 'adjustment', 'loan_out', 'loan_in', 'repay_in', 'repay_out'];
export const DEBT_TYPES = ['loan_out', 'loan_in', 'repay_in', 'repay_out'];

export const isPosted = (t) => t.status !== 'voided';

// Signed balance changes caused by one transaction: [{ accountId, currency, deltaMinor }]
export function postings(t) {
  if (!isPosted(t)) return [];
  const a = t.amountMinor, cur = t.currency;
  switch (t.type) {
    case 'income': case 'refund': case 'loan_in': case 'repay_in': return [{ accountId: t.accountId, currency: cur, deltaMinor: a }];
    case 'expense': case 'loan_out': case 'repay_out': return [{ accountId: t.accountId, currency: cur, deltaMinor: -a }];
    case 'adjustment': return [{ accountId: t.accountId, currency: cur, deltaMinor: t.direction === 'decrease' ? -a : a }];
    case 'transfer': return [
      { accountId: t.accountId, currency: cur, deltaMinor: -(a + (t.feeMinor || 0)) },
      { accountId: t.toAccountId, currency: t.toCurrency || cur, deltaMinor: t.toAmountMinor ?? a },
    ];
    default: return [];
  }
}

export function accountBalances(accounts, txns, { asOf = null } = {}) {
  const bal = new Map(accounts.map((a) => [a.id, a.openingBalanceMinor || 0]));
  for (const t of txns) {
    if (asOf && t.localDate > asOf) continue;
    for (const p of postings(t)) if (bal.has(p.accountId)) bal.set(p.accountId, bal.get(p.accountId) + p.deltaMinor);
  }
  return bal;
}

const inRange = (t, r) => !r || ((!r.from || t.localDate >= r.from) && (!r.to || t.localDate <= r.to));
const zero = () => ({ income: 0, expense: 0, refunds: 0, fees: 0, netExpense: 0, net: 0, transfersIn: 0, transfersOut: 0,
  adjustments: 0, debt: { borrowed: 0, lent: 0, repaymentsReceived: 0, repaymentsMade: 0, net: 0 }, balanceChange: 0, count: 0 });

// Totals per currency for a date range and (optionally) a set of accounts.
// Identity (tested): balanceChange = net + debt.net + adjustments + (transfersIn - transfersOut)
export function summarize(txns, { range = null, accountIds = null } = {}) {
  const sel = accountIds ? new Set(accountIds) : null, inSel = (id) => !sel || sel.has(id);
  const out = {};
  const S = (cur) => (out[cur] ??= zero());
  for (const t of txns) {
    if (!isPosted(t) || !inRange(t, range)) continue;
    const touches = postings(t).some((p) => inSel(p.accountId));
    if (!touches) continue;
    const s = S(t.currency); s.count++;
    const a = t.amountMinor;
    switch (t.type) {
      case 'income': s.income += a; break;
      case 'expense': s.expense += a; break;
      case 'refund': s.refunds += a; break;
      case 'adjustment': s.adjustments += t.direction === 'decrease' ? -a : a; break;
      case 'loan_in': s.debt.borrowed += a; break;
      case 'loan_out': s.debt.lent += a; break;
      case 'repay_in': s.debt.repaymentsReceived += a; break;
      case 'repay_out': s.debt.repaymentsMade += a; break;
      case 'transfer': {
        if (inSel(t.accountId) && (t.feeMinor || 0)) { s.fees += t.feeMinor; s.expense += t.feeMinor; }
        if (inSel(t.accountId) && !inSel(t.toAccountId)) s.transfersOut += a;
        if (inSel(t.toAccountId) && !inSel(t.accountId)) S(t.toCurrency || t.currency).transfersIn += t.toAmountMinor ?? a;
        break;
      }
    }
    for (const p of postings(t)) if (inSel(p.accountId)) S(p.currency).balanceChange += p.deltaMinor;
  }
  for (const s of Object.values(out)) {
    s.netExpense = s.expense - s.refunds; s.net = s.income - s.netExpense;
    s.debt.net = s.debt.borrowed + s.debt.repaymentsReceived - s.debt.lent - s.debt.repaymentsMade;
  }
  return out;
}

// What each transaction contributes to a category, for category reports and budgets.
// Expenses add, refunds subtract (from the original purchase's category), transfer fees add to the fee category.
export function categoryContributions(t, kind) {
  if (!isPosted(t)) return [];
  if (kind === 'income') return t.type === 'income' ? [{ categoryId: t.categoryId ?? null, minor: t.amountMinor }] : [];
  const out = [];
  if (t.type === 'expense') out.push({ categoryId: t.categoryId ?? null, minor: t.amountMinor });
  if (t.type === 'refund') out.push({ categoryId: t.categoryId ?? null, minor: -t.amountMinor });
  if (t.type === 'transfer' && t.feeMinor) out.push({ categoryId: t.feeCategoryId ?? null, minor: t.feeMinor });
  return out;
}

// Category totals, each transaction counted ONCE in its own category; a parent's total = own + all descendants.
// roots[].totalMinor therefore sums to the overall total with nothing double counted (tested).
export function categoryBreakdown(txns, cats, { kind = 'expense', range = null, accountIds = null, currency }) {
  const sel = accountIds ? new Set(accountIds) : null;
  const own = new Map();
  for (const t of txns) {
    if (!inRange(t, range) || t.currency !== currency) continue;
    if (sel && !sel.has(t.accountId)) continue;
    for (const c of categoryContributions(t, kind)) own.set(c.categoryId, (own.get(c.categoryId) || 0) + c.minor);
  }
  const wanted = cats.filter((c) => c.kind === kind);
  const kids = new Map(); for (const c of wanted) { const k = wanted.some((p) => p.id === c.parentId) ? c.parentId : null; (kids.get(k) ?? kids.set(k, []).get(k)).push(c); }
  const byOrder = (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name);
  const node = (c, path) => {
    const p = path ? `${path} › ${c.name}` : c.name;
    const children = (kids.get(c.id) || []).sort(byOrder).map((k) => node(k, p));
    const ownMinor = own.get(c.id) || 0;
    return { id: c.id, name: c.name, path: p, color: c.color, icon: c.icon, archived: !!c.archived, ownMinor, totalMinor: ownMinor + children.reduce((s, k) => s + k.totalMinor, 0), children };
  };
  const roots = (kids.get(null) || []).sort(byOrder).map((c) => node(c, ''));
  const known = new Set(wanted.map((c) => c.id));
  let uncategorised = own.get(null) || 0;
  for (const [id, m] of own) if (id !== null && !known.has(id)) uncategorised += m; // category of the other kind / removed: never lose money
  const total = roots.reduce((s, r) => s + r.totalMinor, 0) + uncategorised;
  return { currency, kind, roots, uncategorisedMinor: uncategorised, totalMinor: total };
}

export function trend(txns, { granularity = 'month', range = null, accountIds = null, currency, weekStartsOn = 1, bucketKey }) {
  const sel = accountIds ? new Set(accountIds) : null, rows = new Map();
  for (const t of txns) {
    if (!isPosted(t) || !inRange(t, range) || t.currency !== currency) continue;
    if (sel && !sel.has(t.accountId)) continue;
    const k = bucketKey(t.localDate, granularity, weekStartsOn), r = rows.get(k) || { key: k, income: 0, expense: 0, net: 0 };
    if (t.type === 'income') r.income += t.amountMinor;
    for (const c of categoryContributions(t, 'expense')) r.expense += c.minor;
    r.net = r.income - r.expense; rows.set(k, r);
  }
  return [...rows.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}

// ---- listing: search, filters, sorting, pagination ----
export function queryTransactions(txns, f = {}, { categoryPath = () => '', accountName = () => '' } = {}) {
  const q = (f.q || '').trim().toLowerCase();
  const cats = f.categoryIds ? new Set(f.categoryIds) : null, types = f.types ? new Set(f.types) : null;
  const tag = f.tag ? f.tag.toLowerCase() : null;
  let list = txns.filter((t) => {
    if (f.status === 'voided' ? t.status !== 'voided' : f.status === 'all' ? false : t.status === 'voided') return false;
    if (types && !types.has(t.type)) return false;
    if (f.accountId && t.accountId !== f.accountId && t.toAccountId !== f.accountId) return false;
    if (cats && !cats.has(t.categoryId ?? null)) return false;
    if (f.from && t.localDate < f.from) return false; if (f.to && t.localDate > f.to) return false;
    if (f.minMinor != null && t.amountMinor < f.minMinor) return false; if (f.maxMinor != null && t.amountMinor > f.maxMinor) return false;
    if (tag && !(t.tags || []).includes(tag)) return false;
    if (f.debtId && t.debtId !== f.debtId) return false; if (f.goalId && t.goalId !== f.goalId) return false;
    if (q && ![t.description, t.counterparty, t.notes, (t.tags || []).join(' '), categoryPath(t.categoryId), accountName(t.accountId), accountName(t.toAccountId)].some((x) => x && String(x).toLowerCase().includes(q))) return false;
    return true;
  });
  const dir = f.dir === 'asc' ? 1 : -1, key = { amount: (t) => t.amountMinor, created: (t) => t.createdAt, date: (t) => `${t.localDate}|${t.occurredAt}` }[f.sort] || ((t) => `${t.localDate}|${t.occurredAt}`);
  list.sort((a, b) => (key(a) > key(b) ? 1 : key(a) < key(b) ? -1 : a.id < b.id ? -1 : 1) * dir);
  const limit = Math.min(Math.max(parseInt(f.limit, 10) || 50, 1), 200), offset = Math.max(parseInt(f.offset, 10) || 0, 0);
  return { total: list.length, limit, offset, items: list.slice(offset, offset + limit) };
}

// Running balance for one account's history (oldest to newest), returned newest first.
export function accountHistory(account, txns) {
  const rows = txns.filter((t) => isPosted(t) && postings(t).some((p) => p.accountId === account.id))
    .sort((a, b) => (`${a.localDate}|${a.occurredAt}|${a.id}` < `${b.localDate}|${b.occurredAt}|${b.id}` ? -1 : 1));
  let bal = account.openingBalanceMinor || 0;
  const out = rows.map((t) => { const d = postings(t).filter((p) => p.accountId === account.id).reduce((s, p) => s + p.deltaMinor, 0); bal += d; return { transactionId: t.id, deltaMinor: d, balanceAfterMinor: bal }; });
  return out.reverse();
}
