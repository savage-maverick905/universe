// Budget maths. Spending = net expense (refunds subtract) in the budget's category, counted once per transaction.
import { addDays, addMonths, startOfWeek, startOfMonth, endOfMonth, daysBetween } from './dates.js';
import { descendantIds, byId, pathOf } from './categories.js';
import { categoryContributions, isPosted } from './ledger.js';

export const PERIODS = ['weekly', 'monthly', 'custom'];

export function periodOf(b, today, weekStartsOn = 1) {
  if (b.period === 'weekly') { const s = startOfWeek(today, weekStartsOn); return { from: s, to: addDays(s, 6) }; }
  if (b.period === 'monthly') return { from: startOfMonth(today), to: endOfMonth(today) };
  return { from: b.startDate, to: b.endDate };
}
export function previousPeriod(b, range) {
  if (b.period === 'weekly') return { from: addDays(range.from, -7), to: addDays(range.to, -7) };
  if (b.period === 'monthly') { const s = addMonths(range.from, -1); return { from: s, to: endOfMonth(s) }; }
  const len = daysBetween(range.from, range.to) + 1; return { from: addDays(range.from, -len), to: addDays(range.from, -1) };
}

export function spentIn(b, txns, cats, range) {
  const ids = b.categoryId ? (b.includeSubcategories === false ? new Set([b.categoryId]) : descendantIds(cats, b.categoryId)) : null;
  let spent = 0, count = 0;
  for (const t of txns) {
    if (!isPosted(t) || t.currency !== b.currency || t.localDate < range.from || t.localDate > range.to) continue;
    for (const c of categoryContributions(t, 'expense')) {
      if (ids && !ids.has(c.categoryId)) continue;
      spent += c.minor; count++;
    }
  }
  return { spent, count };
}

// Unspent money carries into the next period (weekly/monthly only). Overspending does not reduce the next budget.
export function rolloverFor(b, txns, cats, range, maxBack = 12) {
  if (!b.rollover || b.period === 'custom') return 0;
  let carry = 0, r = range;
  const chain = [];
  for (let i = 0; i < maxBack; i++) { r = previousPeriod(b, r); if (b.createdLocalDate && r.to < b.createdLocalDate) break; chain.unshift(r); }
  for (const p of chain) { const { spent } = spentIn(b, txns, cats, p); carry = Math.max(0, b.amountMinor + carry - spent); }
  return carry;
}

export function budgetStatus(b, txns, cats, today, weekStartsOn = 1) {
  const period = periodOf(b, today, weekStartsOn);
  const { spent, count } = spentIn(b, txns, cats, period);
  const rollover = rolloverFor(b, txns, cats, period);
  const available = b.amountMinor + rollover, remaining = available - spent;
  const percent = available > 0 ? Math.round((spent / available) * 1000) / 10 : (spent > 0 ? 100 : 0);
  const warnAt = b.warnAtPercent ?? 80;
  const state = spent > available ? 'over' : percent >= warnAt ? 'warning' : 'ok';
  const prev = previousPeriod(b, period), prevSpent = spentIn(b, txns, cats, prev).spent;
  const left = Math.max(0, daysBetween(today, period.to) + 1);
  const alerts = [];
  if (state === 'over') alerts.push({ level: 'over', message: 'Over budget' });
  else if (state === 'warning') alerts.push({ level: 'warning', message: `${percent}% of the budget used` });
  return { budgetId: b.id, period, budgetMinor: b.amountMinor, rolloverMinor: rollover, availableMinor: available, spentMinor: spent, remainingMinor: remaining,
    percent, state, alerts, transactionCount: count, daysLeft: period.from <= today && today <= period.to ? left : 0,
    dailyAllowanceMinor: remaining > 0 && left > 0 ? Math.floor(remaining / left) : 0,
    previous: { period: prev, spentMinor: prevSpent, deltaMinor: spent - prevSpent } };
}

// Overall totals use only the top-most budgets, so a "Food" budget and a "Food > Groceries" budget never count Groceries twice.
export function summarizeBudgets(budgets, statuses, cats) {
  const map = byId(cats), withCat = new Set(budgets.filter((b) => b.categoryId).map((b) => b.categoryId));
  const covered = (b) => { let cur = b.categoryId ? map.get(b.categoryId)?.parentId : null; for (let i = 0; cur && i < 50; i++) { if (withCat.has(cur)) return true; cur = map.get(cur)?.parentId; } return false; };
  const out = {};
  for (const b of budgets) {
    const st = statuses.get(b.id); if (!st || b.period === 'custom') continue;
    st.nestedUnder = covered(b); if (st.nestedUnder) continue;
    const o = (out[b.currency] ??= { budgetMinor: 0, spentMinor: 0, remainingMinor: 0 });
    o.budgetMinor += st.availableMinor; o.spentMinor += st.spentMinor; o.remainingMinor += st.remainingMinor;
  }
  for (const b of budgets) { const st = statuses.get(b.id); if (st) st.nestedUnder ??= covered(b); st && (st.categoryPath = pathOf(map, b.categoryId)); }
  return out;
}
