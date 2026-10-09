// Reports screen: pick a report and period, run it, optionally save it. DOM built with textContent only.
import { icon } from '/shared/icons.js';
export async function reportsView({ h, api, toast, shell }) {
  const avail = await api('GET', '/api/reports/available');
  const saved = (await api('GET', '/api/reports/saved')).reports;
  const out = h('div', {}), err = h('p', { class: 'err', role: 'alert' });
  const opt = (v, t, sel) => h('option', { value: v, selected: sel ? '' : null }, t);
  const report = h('select', { 'aria-label': 'Report' }, [opt('all', 'Everything I can see'), ...avail.reports.map((r) => opt(r.key, `${r.appName}: ${r.title}`))]);
  const names = { daily: 'Today', weekly: 'Last 7 days', monthly: 'Last 30 days', yearly: 'Last 365 days', last_days: 'Last N days', custom: 'Custom dates' };
  const period = h('select', { 'aria-label': 'Period', onchange: () => { days.hidden = period.value !== 'last_days'; custom.hidden = period.value !== 'custom'; } }, avail.periods.map((p) => opt(p, names[p], p === 'weekly')));
  const days = h('input', { type: 'number', min: 1, max: 3660, value: 17, 'aria-label': 'Number of days', hidden: '' });
  const from = h('input', { type: 'date', 'aria-label': 'From' }), to = h('input', { type: 'date', 'aria-label': 'To' });
  const custom = h('div', { class: 'row', hidden: '' }, from, to);
  const category = h('input', { placeholder: 'Only this category (optional), e.g. Electronics', 'aria-label': 'Category filter' });

  function render(r) {
    out.replaceChildren(h('h2', {}, r.title), h('p', { class: 'sub' }, `${r.range.label} (${r.range.from} to ${r.range.to})`),
      ...r.sections.map((s) => h('article', { class: 'card', style: 'margin-top:1rem' }, h('h3', {}, s.heading), s.text ? h('p', {}, s.text) : null,
        s.stats ? h('div', { class: 'stats' }, s.stats.map((x) => h('div', { class: 'stat' }, h('b', {}, String(x.value)), h('span', {}, x.label)))) : null,
        s.table ? (s.table.rows.length ? h('div', { style: 'overflow-x:auto;margin-top:.7rem' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, s.table.columns.map((c) => h('th', {}, c)))),
          h('tbody', {}, s.table.rows.map((row) => h('tr', {}, row.map((c) => h('td', {}, String(c)))))))) : h('p', { class: 'muted' }, 'Nothing to show.')) : null)));
  }
  async function run(save) {
    err.textContent = '';
    const body = { report: report.value, period: period.value, save, filters: category.value ? { category: category.value } : {} };
    if (period.value === 'last_days') body.days = Number(days.value);
    if (period.value === 'custom') { body.from = from.value; body.to = to.value; }
    try { const r = await api('POST', '/api/reports/run', body); render(r); if (save) toast('Report saved'); } catch (x) { err.textContent = x.message; }
  }
  const savedList = saved.length ? h('section', {}, h('h2', {}, 'Saved reports'), h('div', { class: 'grid' }, saved.map((r) => h('article', { class: 'card' }, h('h3', {}, r.title), h('div', { class: 'sub' }, `${r.range.label}, saved ${r.createdAt.slice(0, 10)}`),
    h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: async () => render((await api('GET', `/api/reports/saved/${r.id}`)).report) }, 'Open'),
      h('button', { class: 'btn ghost small danger', onclick: async () => { await api('DELETE', `/api/reports/saved/${r.id}`); toast('Report deleted'); location.reload(); } }, 'Delete')))))) : null;
  shell('reports', [h('section', {}, h('h1', {}, 'Reports'), h('div', { class: 'card report-form', style: 'margin-top:1rem' },
    h('label', {}, 'Report', report), h('label', {}, 'Period', period), days, custom, h('label', {}, 'Filter', category), err,
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => run(false) }, icon('file'), 'Run report'), h('button', { class: 'btn ghost', onclick: () => run(true) }, 'Run and save'))), out), savedList]);
}
