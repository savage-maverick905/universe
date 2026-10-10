import { h, api, toast } from '../lib/api.js';
import { S, select, accountOptions } from '../lib/forms.js';
import { money, TYPE_LABEL } from '../lib/fmt.js';
import { barChart, lineChart } from '../lib/charts.js';

const RANGES = [['today', 'Today'], ['this_week', 'This week'], ['last_week', 'Last week'], ['this_month', 'This month'], ['last_month', 'Last month'], ['last_30_days', 'Last 30 days'], ['this_year', 'This year'], ['custom', 'Custom']];
export async function render({ frame }) {
  const st = { range: 'this_month', from: S.today.slice(0, 8) + '01', to: S.today, accountId: '', kind: 'expense', g: 'day' }, out = h('div', {});
  const qs = (x = {}) => new URLSearchParams({ range: st.range, ...(st.range === 'custom' ? { from: st.from, to: st.to } : {}), ...(st.accountId ? { accountIds: st.accountId } : {}), currency: S.settings.currency, ...x }).toString();
  const range = select(RANGES.map(([value, label]) => ({ value, label })), st.range), acc = select(accountOptions({ blank: 'All accounts' }), ''), from = h('input', { type: 'date', value: st.from }), to = h('input', { type: 'date', value: st.to }), gran = select(['day', 'week', 'month'].map((v) => ({ value: v, label: `By ${v}` })), 'day');
  const bar = h('div', { class: 'filters' }, range, acc, gran, h('span', { class: 'row tight', hidden: '' }, from, to));
  const customRow = bar.lastChild;
  const go = async () => {
    st.range = range.value; st.accountId = acc.value; st.from = from.value; st.to = to.value; customRow.hidden = st.range !== 'custom'; out.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
    try {
      const cur = S.settings.currency, [sum, cat, inc, tr, accts, cf] = await Promise.all([api('GET', `/reports/summary?${qs()}`), api('GET', `/reports/categories?${qs({ kind: 'expense' })}`), api('GET', `/reports/categories?${qs({ kind: 'income' })}`), api('GET', `/reports/trend?${qs({ granularity: gran.value })}`), api('GET', `/reports/accounts?${qs()}`), api('GET', `/reports/cashflow?${qs({ granularity: gran.value })}`)]);
      const s = sum.byCurrency[cur] || { income: 0, expense: 0, refunds: 0, netExpense: 0, net: 0, transfersIn: 0, transfersOut: 0, adjustments: 0, debt: { net: 0 }, balanceChange: 0 };
      const tree = (n, depth = 0) => [h('div', { class: 'line', style: `margin-left:${depth * 12}px` }, h('span', {}, `${n.icon || ''} ${n.name}`), h('b', {}, money(n.totalMinor, cur))), ...n.children.filter((c) => c.totalMinor !== 0 || c.ownMinor !== 0).flatMap((c) => tree(c, depth + 1))];
      const catCard = (title, r) => h('div', { class: 'card' }, h('h3', {}, title), r.roots.filter((n) => n.totalMinor).length || r.uncategorisedMinor ? [...r.roots.filter((n) => n.totalMinor).flatMap((n) => tree(n)), r.uncategorisedMinor ? h('div', { class: 'line' }, h('span', {}, 'Uncategorised'), h('b', {}, money(r.uncategorisedMinor, cur))) : null, h('div', { class: 'line total' }, h('span', {}, 'Total'), h('b', {}, money(r.totalMinor, cur)))] : h('p', { class: 'muted' }, 'Nothing in this period.'));
      out.replaceChildren(
        h('div', { class: 'grid3' }, [['Income', s.income, 'pos'], ['Spent', s.netExpense, 'neg'], ['Net', s.net, s.net >= 0 ? 'pos' : 'neg']].map(([l, v, c]) => h('div', { class: 'card stat2' }, h('span', {}, l), h('b', { class: c }, money(v, cur))))),
        h('div', { class: 'card' }, h('h3', {}, 'Where the money went'), h('div', { class: 'line' }, h('span', {}, 'Refunds (reduce spending)'), h('b', {}, money(s.refunds, cur))), h('div', { class: 'line' }, h('span', {}, 'Transfers in / out of selection'), h('b', {}, `${money(s.transfersIn, cur)} / ${money(s.transfersOut, cur)}`)), h('div', { class: 'line' }, h('span', {}, 'Loans and repayments (net)'), h('b', {}, money(s.debt.net, cur, { sign: true }))), h('div', { class: 'line' }, h('span', {}, 'Balance adjustments'), h('b', {}, money(s.adjustments, cur, { sign: true }))), h('div', { class: 'line total' }, h('span', {}, 'Balance change'), h('b', {}, money(s.balanceChange, cur, { sign: true }))), h('p', { class: 'fine' }, sum.rules)),
        h('div', { class: 'card' }, h('h3', {}, 'Income vs spending'), tr.points.length ? barChart(tr.points, cur) : h('p', { class: 'muted' }, 'No data.')), h('div', { class: 'card' }, h('h3', {}, 'Cumulative cash flow'), cf.points.length ? lineChart(cf.points.map((p) => p.cumulativeMinor)) : h('p', { class: 'muted' }, 'No data.')),
        catCard('Spending by category', cat), catCard('Income by category', inc),
        h('div', { class: 'card' }, h('h3', {}, 'Accounts compared'), accts.accounts.filter((a) => !a.archived || a.balanceChangeMinor).map((a) => h('div', { class: 'line' }, h('span', {}, a.name), h('span', {}, h('small', { class: 'muted' }, `in ${money(a.incomeMinor, a.currency)} · out ${money(a.netExpenseMinor, a.currency)} · `), h('b', {}, money(a.balanceMinor, a.currency)))))),
        sum.coverage.uncategorised ? h('p', { class: 'fine' }, `${sum.coverage.uncategorised} transactions have no category: category totals leave them in "Uncategorised".`) : null);
    } catch (e) { out.replaceChildren(h('p', { class: 'err' }, e.message)); }
  };
  for (const c of [range, acc, from, to, gran]) c.addEventListener('change', go);
  const exportCsv = h('button', { class: 'btn ghost small', onclick: async () => { try { const r = await api('GET', `/export/transactions.csv${st.range === 'custom' ? `?from=${st.from}&to=${st.to}` : ''}`); const a = h('a', { href: URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' })), download: r.filename }); document.body.append(a); a.click(); a.remove(); toast(`${r.rows} rows exported`); } catch (e) { toast(e.message); } } }, 'Export CSV');
  frame('more', h('div', { class: 'page-head' }, h('h1', {}, 'Reports'), exportCsv), bar, out, h('a', { href: '#/more' }, '← Back'));
  await go();
}
