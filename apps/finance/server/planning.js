// Goals, recurring bills and net worth. All derived from real transactions and accounts; nothing is typed in twice.
import { addDays, addMonths, daysBetween } from './dates.js';
import { isPosted } from './ledger.js';

// A goal's progress is made of transactions tagged with its id: money moved in (transfer/income) minus money taken out (expense).
export function goalProgress(goal, txns, today) {
  let saved = 0;
  for (const t of txns) {
    if (t.goalId !== goal.id || !isPosted(t)) continue;
    if (t.type === 'transfer') saved += t.toAmountMinor ?? t.amountMinor;
    else if (t.type === 'income') saved += t.amountMinor;
    else if (t.type === 'expense') saved -= t.amountMinor;
  }
  saved = Math.max(0, saved);
  const remaining = Math.max(0, goal.targetMinor - saved);
  const percent = goal.targetMinor ? Math.min(100, Math.floor((saved / goal.targetMinor) * 1000) / 10) : 0;
  let monthsLeft = null, suggestedMonthlyMinor = null;
  if (goal.deadline && remaining > 0) {
    const [y1, m1, d1] = today.split('-').map(Number), [y2, m2, d2] = goal.deadline.split('-').map(Number);
    let months = (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0); // whole calendar months, rounded up if days are left over
    if (addMonths(today, months) < goal.deadline) months++;
    monthsLeft = Math.max(1, months);
    if (goal.deadline < today) { monthsLeft = 0; suggestedMonthlyMinor = remaining; } else suggestedMonthlyMinor = Math.ceil(remaining / monthsLeft);
  }
  return { savedMinor: saved, remainingMinor: remaining, percent, reached: saved >= goal.targetMinor, monthsLeft, suggestedMonthlyMinor, overdue: !!goal.deadline && goal.deadline < today && remaining > 0 };
}

export const FREQUENCIES = ['once', 'daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];
export function nextDate(date, frequency, interval = 1) {
  switch (frequency) {
    case 'daily': return addDays(date, interval); case 'weekly': return addDays(date, 7 * interval); case 'biweekly': return addDays(date, 14 * interval);
    case 'monthly': return addMonths(date, interval); case 'quarterly': return addMonths(date, 3 * interval); case 'yearly': return addMonths(date, 12 * interval);
    default: return null;
  }
}
// Rules never post by themselves (there is no background worker on Vercel). They list what is DUE; the user posts it,
// and the posting key `${ruleId}:${dueDate}` makes posting the same occurrence twice impossible.
export function dueOccurrences(rule, today, { horizonDays = 0, max = 24 } = {}) {
  if (rule.archived || !rule.nextDue) return [];
  const out = []; let d = rule.nextDue; const limit = addDays(today, horizonDays);
  for (let i = 0; i < max && d && d <= limit; i++) {
    if (rule.endDate && d > rule.endDate) break;
    out.push({ ruleId: rule.id, dueDate: d, overdue: d < today, key: `${rule.id}:${d}` });
    d = nextDate(d, rule.frequency, rule.interval || 1);
  }
  return out;
}

// Net worth = balances of accounts marked "include" + money owed to you - money you owe + manual assets - manual liabilities.
export function netWorth({ accounts, balances, debts, debtStates, items }) {
  const byCur = {}; const C = (c) => (byCur[c] ??= { assets: 0, liabilities: 0, netWorth: 0, lines: [] });
  const add = (cur, kind, label, minor) => { if (!minor) return; const c = C(cur); c[kind === 'asset' ? 'assets' : 'liabilities'] += minor; c.lines.push({ kind, label, minor }); };
  for (const a of accounts) {
    if (a.excludeFromNetWorth) continue;
    const bal = balances.get(a.id) || 0;
    if (a.archived && bal === 0) continue;
    if (bal >= 0) add(a.currency, 'asset', `Account: ${a.name}`, bal); else add(a.currency, 'liability', `Account overdrawn: ${a.name}`, -bal);
  }
  for (const d of debts) {
    const o = debtStates.get(d.id)?.outstandingMinor || 0;
    if (d.direction === 'lent') add(d.currency, 'asset', `Owed to you by ${d.counterparty}`, o); else add(d.currency, 'liability', `You owe ${d.counterparty}`, o);
  }
  for (const i of items) add(i.currency, i.kind, `${i.kind === 'asset' ? 'Asset' : 'Liability'}: ${i.name}`, i.valueMinor);
  for (const c of Object.values(byCur)) c.netWorth = c.assets - c.liabilities;
  return byCur;
}
