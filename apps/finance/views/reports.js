import { icon, catIcon } from '/shared/icons.js';
import { h, api, toast } from '../lib/api.js';
import { S, select, accountOptions, acctName } from '../lib/forms.js';
import { downloadPdf } from '/shared/pdf.js';
import { money, axisMoney, monthLabel, signedFor, TYPE_LABEL } from '../lib/fmt.js';
import { barChart, lineChart, donutChart, colorAt } from '../lib/charts.js';

const RANGES = [['today', 'Today'], ['this_week', 'This week'], ['last_week', 'Last week'], ['this_month', 'This month'], ['last_month', 'Last month'], ['last_30_days', 'Last 30 days'], ['this_year', 'This year'], ['custom', 'Custom']];
const dayCount = (r) => (r?.from && r?.to ? Math.max(1, Math.round((Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / 864e5) + 1) : 1);
const validHex = (c) => (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : null);
const empty = (text) => h('p', { class: 'muted nodata' }, text);

// A donut with a ranked list next to it. Percentages are shares of the listed categories (display only);
// every amount shown comes from the server.
function breakdownCard(title, r, cur, word) {
  const roots = r.roots.filter((n) => n.totalMinor > 0).sort((a, b) => b.totalMinor - a.totalMinor);
  const items = roots.map((n, i) => ({ label: n.name, icon: n.icon, minor: n.totalMinor, color: validHex(n.color) || colorAt(i), children: n.children.filter((c) => c.totalMinor > 0).sort((a, b) => b.totalMinor - a.totalMinor) }));
  if (r.uncategorisedMinor > 0) items.push({ label: 'Uncategorised', minor: r.uncategorisedMinor, color: '#707070', children: [] });
  const base = items.reduce((s, x) => s + x.minor, 0) || 1; // only used for the ratios below
  if (!items.length) return h('div', { class: 'card' }, h('h3', {}, title), empty('Nothing in this period.'));
  items.forEach((x) => { x.share = x.minor / base; x.pct = x.share >= 0.1 ? Math.round(x.share * 100) : Math.round(x.share * 1000) / 10; });
  const row = (x) => {
    const head = h('div', { class: 'crow-h' }, h('i', { class: 'dot', style: `background:${x.color}` }), h('span', { class: 'cn' }, x.icon ? h('span', { class: 'cico', style: `color:${x.color}` }, catIcon(x.icon, 16)) : null, x.label), h('span', { class: 'cp' }, `${x.pct}%`), h('b', { class: 'ca' }, money(x.minor, cur)));
    const bar = h('div', { class: 'cbar' }, h('i', { style: `width:${Math.max(2, x.share * 100)}%;background:${x.color}` }));
    if (!x.children.length) return h('div', { class: 'crow' }, head, bar);
    return h('details', { class: 'crow' }, h('summary', {}, head, bar), h('div', { class: 'subs' }, x.children.map((c) => h('div', { class: 'line' }, h('span', {}, c.name), h('span', {}, h('small', { class: 'muted' }, `${Math.round((c.totalMinor / x.minor) * 100)}% · `), h('b', {}, money(c.totalMinor, cur)))))));
  };
  const shown = items.slice(0, 6), rest = items.slice(6);
  return h('div', { class: 'card' }, h('h3', {}, title),
    h('div', { class: 'donut-wrap' }, donutChart(items.map((x) => ({ label: x.label, share: x.share, color: x.color, text: `${x.pct}% · ${money(x.minor, cur)}` })), { centre: axisMoney(r.totalMinor, cur), caption: word })),
    h('div', { class: 'crows' }, shown.map(row), rest.length ? h('details', { class: 'more' }, h('summary', {}, `Show ${rest.length} more`), rest.map(row)) : null),
    h('div', { class: 'line total' }, h('span', {}, 'Total'), h('b', {}, money(r.totalMinor, cur))));
}
const stat = (label, value, cls, sub) => h('div', { class: 'card stat2' }, h('span', {}, label), h('b', { class: cls }, value), sub ? h('small', { class: 'sub2' }, sub) : null);
const legend = () => h('div', { class: 'legend' }, h('i', { class: 'b' }), 'Income', h('i', { class: 'o' }), 'Spent');

export async function render({ frame }) {
  const st = { range: 'this_month', from: S.today.slice(0, 8) + '01', to: S.today, accountId: '', kind: 'expense', g: 'day' }, out = h('div', {});
  const qs = (x = {}) => new URLSearchParams({ range: st.range, ...(st.range === 'custom' ? { from: st.from, to: st.to } : {}), ...(st.accountId ? { accountIds: st.accountId } : {}), currency: S.settings.currency, ...x }).toString();
  const range = select(RANGES.map(([value, label]) => ({ value, label })), st.range), acc = select(accountOptions({ blank: 'All accounts' }), ''), from = h('input', { type: 'date', value: st.from }), to = h('input', { type: 'date', value: st.to }), gran = select(['day', 'week', 'month'].map((v) => ({ value: v, label: `By ${v}` })), 'day');
  const bar = h('div', { class: 'filters' }, range, acc, gran, h('span', { class: 'row tight', hidden: '' }, from, to));
  const customRow = bar.lastChild;
  let last = null;
  const go = async () => {
    st.range = range.value; st.accountId = acc.value; st.from = from.value; st.to = to.value; customRow.hidden = st.range !== 'custom'; out.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
    try {
      const cur = S.settings.currency, [sum, cat, inc, tr, accts, cf] = await Promise.all([api('GET', `/reports/summary?${qs()}`), api('GET', `/reports/categories?${qs({ kind: 'expense' })}`), api('GET', `/reports/categories?${qs({ kind: 'income' })}`), api('GET', `/reports/trend?${qs({ granularity: gran.value })}`), api('GET', `/reports/accounts?${qs()}`), api('GET', `/reports/cashflow?${qs({ granularity: gran.value })}`)]);
      const s = sum.byCurrency[cur] || { income: 0, expense: 0, refunds: 0, netExpense: 0, net: 0, transfersIn: 0, transfersOut: 0, adjustments: 0, debt: { net: 0 }, balanceChange: 0 };
      last = { sum, cat, inc, tr, accts, cur, s, range: sum.range };
      const days = dayCount(sum.range), perDay = Math.round(s.netExpense / days), saved = s.income > 0 ? Math.round((s.net / s.income) * 100) : null;
      const top = [...cat.roots].filter((n) => n.totalMinor > 0).sort((a, b) => b.totalMinor - a.totalMinor)[0];
      out.replaceChildren(
        h('div', { class: 'grid3' }, stat('Income', money(s.income, cur), 'pos'), stat('Spent', money(s.netExpense, cur), 'neg', s.netExpense ? `≈ ${money(perDay, cur)} a day` : ''), stat('Net', money(s.net, cur, { sign: true }), s.net >= 0 ? 'pos' : 'neg', saved == null ? '' : saved >= 0 ? `${saved}% of income kept` : 'Spent more than earned')),
        top ? h('div', { class: 'insight' }, h('i', { class: 'dot', style: `background:${top.color && /^#[0-9a-fA-F]{6}$/.test(top.color) ? top.color : colorAt(0)}` }), h('span', {}, `Biggest spend: ${top.name}`), h('b', {}, money(top.totalMinor, cur))) : null,
        h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', {}, 'Income vs spending'), legend()), tr.points.length ? barChart(tr.points, cur) : empty('No transactions in this period.')),
        h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h3', {}, 'Running total'), h('small', { class: 'muted' }, 'income minus spending')), cf.points.length ? lineChart(cf.points, cur) : empty('No transactions in this period.')),
        breakdownCard('Where your money went', cat, cur, 'spent'), breakdownCard('Where your money came from', inc, cur, 'earned'),
        h('div', { class: 'card' }, h('h3', {}, 'How the numbers add up'), h('div', { class: 'line' }, h('span', {}, 'Refunds (reduce spending)'), h('b', {}, money(s.refunds, cur))), h('div', { class: 'line' }, h('span', {}, 'Transfers in / out of selection'), h('b', {}, `${money(s.transfersIn, cur)} / ${money(s.transfersOut, cur)}`)), h('div', { class: 'line' }, h('span', {}, 'Loans and repayments (net)'), h('b', {}, money(s.debt.net, cur, { sign: true }))), h('div', { class: 'line' }, h('span', {}, 'Balance adjustments'), h('b', {}, money(s.adjustments, cur, { sign: true }))), h('div', { class: 'line total' }, h('span', {}, 'Balance change'), h('b', {}, money(s.balanceChange, cur, { sign: true }))), h('p', { class: 'fine' }, sum.rules)),
        h('div', { class: 'card' }, h('h3', {}, 'Accounts compared'), accts.accounts.filter((a) => !a.archived || a.balanceChangeMinor).map((a) => h('div', { class: 'line' }, h('span', {}, a.name), h('span', {}, h('small', { class: 'muted' }, `in ${money(a.incomeMinor, a.currency)} · out ${money(a.netExpenseMinor, a.currency)} · `), h('b', {}, money(a.balanceMinor, a.currency)))))),
        sum.coverage.uncategorised ? h('p', { class: 'fine' }, `${sum.coverage.uncategorised} transactions have no category: category totals leave them in "Uncategorised".`) : null);
    } catch (e) { out.replaceChildren(h('p', { class: 'err' }, e.message)); }
  };
  for (const c of [range, acc, from, to, gran]) c.addEventListener('change', go);
  const pct = (n, base) => `${base ? Math.round((n / base) * 1000) / 10 : 0}%`;
  const catRows = (r, cur) => { const list = r.roots.filter((n) => n.totalMinor > 0).sort((a, b) => b.totalMinor - a.totalMinor).map((n) => [n.name, n.totalMinor]); if (r.uncategorisedMinor > 0) list.push(['Uncategorised', r.uncategorisedMinor]); const base = list.reduce((t, x) => t + x[1], 0); return list.map(([name, v]) => [name, pct(v, base), money(v, cur)]); };
  async function allTransactions() {
    const items = []; let offset = 0;
    for (let i = 0; i < 30; i++) {
      const page = await api('GET', `/transactions?${new URLSearchParams({ ...(st.range === 'custom' ? { range: 'custom', from: st.from, to: st.to } : { range: st.range }), ...(st.accountId ? { accountId: st.accountId } : {}), sort: 'date', dir: 'asc', limit: 100, offset })}`);
      items.push(...page.items); offset += page.items.length; if (!page.items.length || offset >= (page.total ?? 0)) break;
    }
    return items;
  }
  const pdfBtn = h('button', { class: 'btn small', onclick: async () => {
    if (!last) return; pdfBtn.disabled = true; pdfBtn.textContent = 'Preparing…';
    try {
      const { sum, cat, inc, tr, accts, cur, s, range: rg } = last, txns = await allTransactions(), who = S.me?.user?.displayName || '';
      downloadPdf({ title: 'Orbit financial statement', subtitle: `${rg.from} to ${rg.to}${st.accountId ? ` · ${acctName(st.accountId)}` : ' · All accounts'}${who ? ` · ${who}` : ''}`, brand: 'Orbit by Universe', footer: `Orbit statement ${rg.from} to ${rg.to}  |  Generated ${S.today}`,
        sections: [
          { heading: 'Summary', stats: [{ label: 'Income', value: money(s.income, cur), tone: 'pos' }, { label: 'Spent', value: money(s.netExpense, cur), tone: 'neg' }, { label: 'Net', value: money(s.net, cur, { sign: true }), tone: s.net >= 0 ? 'pos' : 'neg' }, { label: 'Balance change', value: money(s.balanceChange, cur, { sign: true }) }] },
          ...(tr.points.length ? [{ heading: 'Income vs spending', bars: { names: ['Income', 'Spent'], items: tr.points.map((p) => ({ label: monthLabel(p.key), a: p.income, b: p.expense })) } }] : []),
          { heading: 'Spending by category', table: { columns: ['Category', 'Share', 'Amount'], rows: catRows(cat, cur) } },
          { heading: 'Income by category', table: { columns: ['Category', 'Share', 'Amount'], rows: catRows(inc, cur) } },
          { heading: 'Accounts', table: { columns: ['Account', 'Money in', 'Money out', 'Balance'], rows: accts.accounts.filter((a) => !a.archived || a.balanceChangeMinor).map((a) => [a.name, money(a.incomeMinor, a.currency), money(a.netExpenseMinor, a.currency), money(a.balanceMinor, a.currency)]) } },
          { heading: `Transactions (${txns.length})`, table: { columns: ['Date', 'Description', 'Category', 'Account', 'Amount'], rows: txns.map((t) => [t.localDate, t.description || t.counterparty || TYPE_LABEL[t.type], t.categoryPath || TYPE_LABEL[t.type], t.type === 'transfer' ? `${acctName(t.accountId)} > ${acctName(t.toAccountId)}` : acctName(t.accountId), money(signedFor(t, st.accountId || null), t.currency, { sign: true })]) } },
          { heading: 'Notes', text: sum.rules }] },
        `orbit-statement-${rg.from}-to-${rg.to}.pdf`);
      toast('Statement downloaded');
    } catch (e) { toast(e.message); }
    pdfBtn.disabled = false; pdfBtn.textContent = 'Download PDF';
  } }, 'Download PDF');
  const exportCsv = h('button', { class: 'btn ghost small', onclick: async () => { try { const r = await api('GET', `/export/transactions.csv${st.range === 'custom' ? `?from=${st.from}&to=${st.to}` : ''}`); const a = h('a', { href: URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' })), download: r.filename }); document.body.append(a); a.click(); a.remove(); toast(`${r.rows} rows exported`); } catch (e) { toast(e.message); } } }, 'Export CSV');
  frame('more', h('div', { class: 'page-head' }, h('h1', {}, 'Reports'), h('div', { class: 'row tight' }, pdfBtn, exportCsv)), bar, out, h('a', { href: '#/more', class: 'backlink' }, icon('back', 16), 'Back'));
  await go();
}
