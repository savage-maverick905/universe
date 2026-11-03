// Orbit's "smart" layer: plain, checkable maths over your own transactions. No AI provider is involved and nothing leaves the server,
// so it works without an API key and behind the PIN like everything else. It learns from how YOU record things.
import { addDays, addMonths, daysBetween, endOfMonth, startOfMonth } from './dates.js';
import { formatMoney } from './money.js';
import { budgetStatus } from './budgets.js';
import { byId, pathOf } from './categories.js';

const norm = (s) => String(s || '').toLowerCase().replace(/[0-9]+/g, ' ').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
const live = (t) => t.status !== 'voided';
const spendOf = (t) => (t.type === 'expense' ? t.amountMinor : t.type === 'refund' ? -t.amountMinor : 0);
const median = (xs) => { const a = [...xs].sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const top = (map) => [...map.entries()].sort((a, b) => b[1] - a[1])[0];

// Best guess for what a new transaction is, from what you called similar ones before.
export function suggest(txns, q, type = 'expense') {
  const key = norm(q); if (key.length < 3) return null;
  const words = key.split(' ').filter((w) => w.length > 2);
  const pool = txns.filter((t) => live(t) && t.type === type && (t.description || t.counterparty));
  let hits = pool.filter((t) => norm(t.description || t.counterparty) === key);
  if (!hits.length) hits = pool.filter((t) => { const d = norm(`${t.description} ${t.counterparty || ''}`); return words.length && words.every((w) => d.includes(w)); });
  if (!hits.length) return null;
  const cat = new Map(), acc = new Map(), cur = new Map();
  for (const t of hits) { if (t.categoryId) cat.set(t.categoryId, (cat.get(t.categoryId) || 0) + 1); acc.set(t.accountId, (acc.get(t.accountId) || 0) + 1); cur.set(t.currency, (cur.get(t.currency) || 0) + 1); }
  return { categoryId: top(cat)?.[0] ?? null, accountId: top(acc)?.[0] ?? null, currency: top(cur)?.[0], typicalMinor: Math.round(median(hits.map((t) => t.amountMinor))), count: hits.length };
}

export function insights({ txns, cats, accounts, budgets, today, currency, custom = [], weekStartsOn = 1 }) {
  const out = [], money = (m) => formatMoney(m, currency, custom), C = byId(cats);
  const mine = txns.filter((t) => live(t) && t.currency === currency);
  const mStart = startOfMonth(today), mEnd = endOfMonth(today), pStart = startOfMonth(addMonths(mStart, -1)), pEnd = addDays(mStart, -1);
  const inR = (t, a, b) => t.localDate >= a && t.localDate <= b, days = daysBetween(mStart, mEnd) + 1, elapsed = daysBetween(mStart, today) + 1;
  const spent = mine.filter((t) => inR(t, mStart, today)).reduce((s, t) => s + spendOf(t), 0);
  const prevSpent = mine.filter((t) => inR(t, pStart, pEnd)).reduce((s, t) => s + spendOf(t), 0);
  const income = mine.filter((t) => inR(t, mStart, today) && t.type === 'income').reduce((s, t) => s + t.amountMinor, 0);

  // 1. Where this month is heading
  if (spent > 0 && elapsed >= 3) {
    const pace = Math.round((spent / elapsed) * days);
    const vs = prevSpent > 0 ? (pace > prevSpent * 1.1 ? `, about ${Math.round(((pace - prevSpent) / prevSpent) * 100)}% more than last month (${money(prevSpent)})` : pace < prevSpent * 0.9 ? `, about ${Math.round(((prevSpent - pace) / prevSpent) * 100)}% less than last month (${money(prevSpent)})` : ', about the same as last month') : '';
    out.push({ kind: 'forecast', tone: prevSpent > 0 && pace > prevSpent * 1.1 ? 'warn' : 'info', title: `On pace to spend ${money(pace)} this month`, detail: `You have spent ${money(spent)} in ${elapsed} day${elapsed === 1 ? '' : 's'}${vs}.` });
  }
  // 2. Budgets close to or over their limit
  for (const b of budgets.filter((x) => !x.archived && x.currency === currency)) {
    const st = budgetStatus(b, txns, cats, today, weekStartsOn); if (st.state === 'ok') continue;
    const name = b.categoryId ? pathOf(C, b.categoryId) : 'All spending';
    out.push({ kind: 'budget', tone: st.state === 'over' ? 'bad' : 'warn', title: st.state === 'over' ? `${name} is over budget by ${money(-st.remainingMinor)}` : `${name}: ${st.percent}% of the budget used`, detail: st.daysLeft > 0 && st.remainingMinor > 0 ? `${money(st.remainingMinor)} left for ${st.daysLeft} day${st.daysLeft === 1 ? '' : 's'}, about ${money(st.dailyAllowanceMinor)} a day.` : '' });
  }
  // 3. Categories that jumped compared with last month
  const sumBy = (a, b) => { const m = new Map(); for (const t of mine) if (inR(t, a, b) && (t.type === 'expense' || t.type === 'refund')) m.set(t.categoryId || '', (m.get(t.categoryId || '') || 0) + spendOf(t)); return m; };
  const now = sumBy(mStart, today), before = sumBy(pStart, addDays(pStart, elapsed - 1 > daysBetween(pStart, pEnd) ? daysBetween(pStart, pEnd) : elapsed - 1));
  const movers = [...now.entries()].filter(([id, v]) => id && v >= 100 * 100 && (before.get(id) || 0) > 0 && v > before.get(id) * 1.25).map(([id, v]) => ({ id, v, was: before.get(id), up: v - before.get(id) })).sort((a, b) => b.up - a.up).slice(0, 2);
  for (const m of movers) out.push({ kind: 'category', tone: 'warn', title: `${pathOf(C, m.id)} is up ${Math.round((m.up / m.was) * 100)}%`, detail: `${money(m.v)} so far, against ${money(m.was)} at this point last month.` });
  // 4. Unusually large purchases this month (against what you normally spend in that category)
  const hist = new Map(); for (const t of mine) if (t.type === 'expense' && t.categoryId && t.localDate < mStart) (hist.get(t.categoryId) || hist.set(t.categoryId, []).get(t.categoryId)).push(t.amountMinor);
  const odd = mine.filter((t) => t.type === 'expense' && inR(t, addDays(today, -13), today) && t.categoryId && (hist.get(t.categoryId)?.length || 0) >= 5 && t.amountMinor > median(hist.get(t.categoryId)) * 3 && t.amountMinor >= 50 * 100)
    .sort((a, b) => b.amountMinor - a.amountMinor).slice(0, 2);
  for (const t of odd) out.push({ kind: 'unusual', tone: 'info', title: `Larger than usual: ${t.description || pathOf(C, t.categoryId)} (${money(t.amountMinor)})`, detail: `Your typical ${pathOf(C, t.categoryId)} spend is ${money(Math.round(median(hist.get(t.categoryId))))}.`, txnId: t.id });
  // 5. Things that look like subscriptions: same name, similar amount, about a month apart, at least three times
  const groups = new Map(); for (const t of mine) if (t.type === 'expense' && t.description) { const k = norm(t.description); if (k.length >= 3) (groups.get(k) || groups.set(k, []).get(k)).push(t); }
  const subs = [];
  for (const [k, list] of groups) {
    if (list.length < 3) continue; const l = [...list].sort((a, b) => (a.localDate < b.localDate ? -1 : 1)).slice(-4), gaps = l.slice(1).map((t, i) => daysBetween(l[i].localDate, t.localDate));
    const amt = median(l.map((t) => t.amountMinor));
    if (gaps.every((g) => g >= 26 && g <= 35) && l.every((t) => Math.abs(t.amountMinor - amt) <= amt * 0.1) && daysBetween(l.at(-1).localDate, today) <= 45) subs.push({ name: l.at(-1).description, amt: Math.round(amt) });
  }
  if (subs.length) out.push({ kind: 'subscriptions', tone: 'info', title: `${subs.length} repeating payment${subs.length === 1 ? '' : 's'} found: about ${money(subs.reduce((s, x) => s + x.amt, 0))} a month`, detail: subs.slice(0, 4).map((x) => `${x.name} ${money(x.amt)}`).join(', ') + '.' });
  // 6. Savings rate
  if (income > 0 && elapsed >= 7) { const kept = income - spent, pct = Math.round((kept / income) * 100); out.push({ kind: 'savings', tone: kept < 0 ? 'bad' : 'good', title: kept < 0 ? `Spending is ${money(-kept)} above income this month` : `You have kept ${pct}% of your income this month`, detail: `${money(income)} in, ${money(spent)} out.` }); }
  // 7. Tidy-up
  const loose = txns.filter((t) => live(t) && (t.type === 'expense' || t.type === 'income') && !t.categoryId).length;
  if (loose) out.push({ kind: 'tidy', tone: 'info', title: `${loose} transaction${loose === 1 ? '' : 's'} without a category`, detail: 'Categorising them makes your reports and budgets more accurate.' });
  const order = { bad: 0, warn: 1, info: 2, good: 3 };
  return out.sort((a, b) => order[a.tone] - order[b.tone]).slice(0, 8);
}
