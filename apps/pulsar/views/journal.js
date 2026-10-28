import { h, toast, S, api, goto, todayStr, fmtDay, templateBlocks, allTemplates, loadNodes, stripBlocks, iconOf, confirmBox } from '../lib/state.js';
import { quickExport } from './page.js';
export async function openDay(date) {
  try { const tpl = S.settings.defaultTemplate && allTemplates().find((t) => t.id === S.settings.defaultTemplate && (t.id === 'journal' || t.custom)) ? S.settings.defaultTemplate : 'journal'; const r = await api('POST', `/journal/${date}`, { title: fmtDay(date), blocks: templateBlocks(tpl) }); if (r.created) S.nodes.push(stripBlocks(r.node)); goto(`#/p/${r.node.id}`); }
  catch (e) { toast(e.message); }
}
export async function journalView(arg, ctx) {
  if (arg) { await openDay(arg === 'today' ? todayStr() : arg); return; }
  ctx.setCrumbs([{ label: '📓 Journal' }]); await loadNodes();
  let month = new Date(); month.setDate(1); let q = ''; const entries = () => S.nodes.filter((n) => n.journalDate && !n.trashedAt).sort((a, b) => b.journalDate.localeCompare(a.journalDate));
  const cal = h('div'), list = h('div'), search = h('input', { type: 'search', placeholder: 'Search entries…', 'aria-label': 'Search journal', oninput: (e) => { q = e.target.value.trim(); drawList(); } });
  function drawCal() {
    const y = month.getFullYear(), m = month.getMonth(), first = new Date(y, m, 1).getDay(), dim = new Date(y, m + 1, 0).getDate(), have = new Set(entries().map((e) => e.journalDate)); const cells = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => h('span', { class: 'dn' }, d));
    for (let i = 0; i < first; i++) cells.push(h('span', {}));
    for (let d = 1; d <= dim; d++) { const ds = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`; cells.push(h('button', { type: 'button', class: `${have.has(ds) ? 'has ' : ''}${ds === todayStr() ? 'tdy' : ''}`, 'aria-label': `${fmtDay(ds)}${have.has(ds) ? ', has entry' : ''}`, onclick: () => openDay(ds) }, d)); }
    cal.replaceChildren(h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:.4rem' }, h('button', { class: 'tb', type: 'button', 'aria-label': 'Previous month', onclick: () => { month = new Date(y, m - 1, 1); drawCal(); } }, '←'), h('b', {}, month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })), h('button', { class: 'tb', type: 'button', 'aria-label': 'Next month', onclick: () => { month = new Date(y, m + 1, 1); drawCal(); } }, '→')), h('div', { class: 'jcal' }, cells));
  }
  let tm; async function drawList() {
    clearTimeout(tm); tm = setTimeout(async () => { let rows = entries(); let snip = new Map();
      if (q) { try { const r = await api('GET', `/search?q=${encodeURIComponent(q)}&journal=1`); rows = r.nodes; r.nodes.forEach((n) => snip.set(n.id, n.snippet)); } catch (e) { toast(e.message); } }
      list.replaceChildren(...(rows.length ? rows.slice(0, 200).map((e) => h('a', { class: 'entry', href: `#/p/${e.id}` }, h('b', {}, `${iconOf(e)} ${fmtDay(e.journalDate)}`), h('small', {}, snip.get(e.id) || e.title || ''))) : [h('div', { class: 'empty' }, q ? 'No entries match your search.' : 'No journal entries yet. Start with today.')])); }, q ? 200 : 0);
  }
  ctx.main(h('div', { class: 'content' }, h('h1', { class: 'pt' }, '📓 Journal'), h('p', { class: 'sub' }, '🔒 Entries are private to your account and are left out of workspace exports unless you include them.'),
    h('div', { class: 'row', style: 'margin:.6rem 0 1rem' }, h('button', { class: 'btn', type: 'button', onclick: () => openDay(todayStr()) }, "Write today's entry"), h('button', { class: 'btn ghost', type: 'button', onclick: () => goto('#/export?journal=1') }, 'Export entries…')),
    h('div', { class: 'jgrid' }, h('div', { class: 'panel2' }, cal), h('div', {}, search, h('div', { style: 'margin-top:.5rem' }, list))))); drawCal(); drawList();
}
