import { h, api } from '../lib/api.js';
import { S, txnSheet, emptyState, acctName } from '../lib/forms.js';
import { money, day, signedFor, TYPE_LABEL } from '../lib/fmt.js';
import { barChart } from '../lib/charts.js';
import { progress } from '../lib/charts.js';
import { icon } from '/shared/icons.js';

export const txnRow = (t, { onclick, acctId } = {}) => {
  const v = signedFor(t, acctId), cls = t.type === 'transfer' ? 'neutral' : v > 0 ? 'pos' : 'neg';
  return h('button', { class: 'txn', type: 'button', onclick }, h('span', { class: `ico ${cls}` }, icon(t.type === 'transfer' ? 'swap' : v > 0 ? 'down' : 'up')),
    h('span', { class: 'txt' }, h('b', {}, t.description || t.counterparty || TYPE_LABEL[t.type]), h('small', {}, [t.categoryPath || TYPE_LABEL[t.type], t.type === 'transfer' ? `${acctName(t.accountId)} → ${acctName(t.toAccountId)}` : acctName(t.accountId), day(t.localDate, S.today)].filter(Boolean).join(' · '))),
    h('span', { class: `amt ${cls}` }, money(v, acctId && t.toAccountId === acctId ? t.toCurrency : t.currency, { sign: true })));
};
export async function render({ frame, goto, openAdd }) {
  const range = 'this_month';
  const [d, tr] = await Promise.all([api('GET', `/dashboard?range=${range}`), api('GET', '/reports/trend?range=last_30_days&granularity=day')]);
  const cur = S.settings.currency, sum = d.summary[cur] || { income: 0, netExpense: 0, net: 0 };
  const totals = Object.entries(d.totalBalances);
  const hero = h('section', { class: 'hero' }, h('small', {}, 'Total balance'), totals.length ? totals.map(([c, v]) => h('div', { class: 'big' }, money(v, c))) : h('div', { class: 'big' }, money(0, cur)),
    h('div', { class: 'chips' }, h('span', {}, `${d.range.from} → ${d.range.to}`), h('span', {}, `${d.coverage.transactions} transactions`)));
  const stats = h('div', { class: 'grid3' }, [['Income', sum.income, 'pos'], ['Spent', sum.netExpense, 'neg'], ['Net', sum.net, sum.net >= 0 ? 'pos' : 'neg']].map(([l, v, c]) => h('div', { class: 'card stat2' }, h('span', {}, l), h('b', { class: c }, money(v, cur)))));
  const empty = !S.accounts.length ? emptyState('Start with an account', 'Add the places your money lives: cash, OPay, PalmPay, Moniepoint, your bank.', h('a', { class: 'btn small', href: '#/accounts' }, 'Add account')) : null;
  const chart = h('div', { class: 'card' }, h('h3', {}, 'Last 30 days'), h('div', { class: 'legend' }, h('i', { class: 'b' }), 'Income', h('i', { class: 'o' }), 'Spent'), tr.points.length ? barChart(tr.points, cur) : h('p', { class: 'muted' }, 'No activity in this period yet.'));
  const budgets = d.budgets.length ? h('div', { class: 'card' }, h('h3', {}, 'Budgets'), d.budgets.map((b) => h('div', { class: 'brow' }, h('div', { class: 'line' }, h('span', {}, b.categoryPath), h('b', { class: b.state }, `${money(b.spentMinor, b.currency)} / ${money(b.availableMinor, b.currency)}`)), progress(b.percent, b.state)))) : null;
  const upcoming = d.upcoming.length ? h('div', { class: 'card' }, h('h3', {}, 'Coming up'), d.upcoming.map((u) => h('div', { class: 'line' }, h('span', {}, `${u.name} · ${u.dueDate}`), h('b', { class: u.overdue ? 'neg' : '' }, money(u.amountMinor, u.currency))))) : null;
  const debts = Object.entries(d.debts).length ? h('div', { class: 'card' }, h('h3', {}, 'Debts'), Object.entries(d.debts).map(([c, x]) => h('div', {}, h('div', { class: 'line' }, h('span', {}, 'Owed to you'), h('b', { class: 'pos' }, money(x.owedToYouMinor, c))), h('div', { class: 'line' }, h('span', {}, 'You owe'), h('b', { class: 'neg' }, money(x.youOweMinor, c))), x.overdue ? h('span', { class: 'badge bad' }, `${x.overdue} overdue`) : null))) : null;
  const goals = d.goals.length ? h('div', { class: 'card' }, h('h3', {}, 'Goals'), d.goals.map((g) => h('div', { class: 'brow' }, h('div', { class: 'line' }, h('span', {}, g.name), h('b', {}, `${g.percent}%`)), progress(g.percent)))) : null;
  const recent = h('div', { class: 'card' }, h('div', { class: 'line' }, h('h3', {}, 'Recent'), h('a', { href: '#/activity' }, 'See all')), d.recent.length ? d.recent.map((t) => txnRow(t, { onclick: () => goto(`#/activity/${t.id}`) })) : h('p', { class: 'muted' }, 'Nothing yet. Tap + to add your first transaction.'));
  const note = d.coverage.uncategorised ? h('p', { class: 'fine' }, `${d.coverage.uncategorised} transactions have no category, so category reports are incomplete.`) : null;
  frame('home', h('div', { class: 'page-head' }, h('h1', {}, 'Orbit')), hero, empty, stats, h('div', { class: 'grid' }, chart, budgets, upcoming, debts, goals, recent), note,
    S.accounts.length ? h('button', { class: 'fab', 'aria-label': 'Add transaction', onclick: () => txnSheet({ onDone: () => goto('#/') }) }, icon('plus')) : null);
}
