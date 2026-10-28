// Shared client state, API client, dialogs and templates for Pulsar.
import { h, toast, dialog, closer, api as call } from '/shared/ui.js';
export { h, toast, dialog, closer };
export const B = '/api/apps/pulsar';
export const S = { me: null, meta: null, nodes: [], settings: { theme: 'dark', fontSize: 16, width: 'normal', defaultTemplate: 'blank', templates: [], spellcheck: true }, onUnauthorized: () => {} };
export async function api(method, path, body) { try { return await call(method, B + path, body); } catch (e) { if (e.status === 401) S.onUnauthorized(); throw e; } }
export async function loadNodes() { S.nodes = (await api('GET', '/nodes')).nodes; return S.nodes; }
export const byId = (id) => S.nodes.find((n) => n.id === id);
export const kids = (id, kind) => S.nodes.filter((n) => (n.parentId || null) === (id || null) && n.kind !== 'entry' && !n.journalDate && (!kind || n.kind === kind)).sort((a, b) => (a.order || 0) - (b.order || 0));
export const entriesOf = (dbId) => S.nodes.filter((n) => n.kind === 'entry' && n.dbId === dbId);
export const isTop = (n) => !n.journalDate && n.kind !== 'entry';
export function descendantsOf(id) { const out = []; const walk = (i) => { for (const c of S.nodes.filter((n) => n.parentId === i)) { out.push(c); walk(c.id); } }; walk(id); return out; }
export function pathOf(n) { const out = []; let c = n, guard = 0; while (c && c.parentId && guard++ < 50) { c = byId(c.parentId); if (c) out.unshift(c); } return out; }
export const goto = (hash) => { location.hash = hash; };
export const ICONS = { collection: '🗂️', database: '🗃️', page: '📄', entry: '📄' };
export const iconOf = (n) => n.icon || (n.journalDate ? '📓' : ICONS[n.kind] || '📄');
export const ago = (iso) => { const s = (Date.now() - new Date(iso).getTime()) / 1000; if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`; if (s < 604800) return `${Math.floor(s / 86400)} d ago`; return new Date(iso).toLocaleDateString(); };
export const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const fmtDay = (s) => new Date(`${s}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
export const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-3)}`;

// ---- dialogs ----
export function ask(title, label, value = '', { multiline = false, okLabel = 'OK' } = {}) {
  return new Promise((resolve) => { let out = null;
    const inp = h(multiline ? 'textarea' : 'input', { value, rows: 3, 'aria-label': label, maxlength: 500, autocomplete: 'off' }); if (multiline) inp.value = value;
    const d = dialog(title, h('form', { onsubmit: (e) => { e.preventDefault(); out = inp.value; d.close(); } }, h('p', { class: 'sub' }, label), inp, h('div', { class: 'row actions' }, closer('Cancel'), h('button', { class: 'btn', type: 'submit' }, okLabel))));
    d.addEventListener('close', () => resolve(out)); setTimeout(() => { inp.focus(); inp.select?.(); }, 30); });
}
export function confirmBox(title, message, okLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => { let ok = false; const d = dialog(title, h('p', { class: 'sub' }, message), h('div', { class: 'row actions' }, closer('Cancel'), h('button', { class: `btn${danger ? ' danger' : ''}`, onclick: () => { ok = true; d.close(); } }, okLabel))); d.addEventListener('close', () => resolve(ok)); });
}
// Choose a page (for links, relations, moving). opts: { title, exclude:Set, kinds:[...], allowTop }
export function pickNode({ title = 'Choose a page', exclude = new Set(), kinds = null, allowTop = false, nodes = null } = {}) {
  return new Promise((resolve) => { let out;
    const list = h('div', { class: 'pick' }), q = h('input', { type: 'search', placeholder: 'Search pages…', 'aria-label': 'Search pages' });
    const all = (nodes || S.nodes).filter((n) => !exclude.has(n.id) && (!kinds || kinds.includes(n.kind)) && n.kind !== 'entry' || (kinds && kinds.includes(n.kind) && !exclude.has(n.id)));
    const draw = () => { const t = q.value.toLowerCase(); const rows = all.filter((n) => !t || (n.title || 'Untitled').toLowerCase().includes(t)).slice(0, 80);
      list.replaceChildren(allowTop ? h('button', { type: 'button', class: 'pickrow', onclick: () => { out = { id: null, title: 'Top level' }; d.close(); } }, h('span', {}, '🏠'), h('b', {}, 'Top level')) : null,
        ...rows.map((n) => h('button', { type: 'button', class: 'pickrow', onclick: () => { out = { id: n.id, title: n.title || 'Untitled' }; d.close(); } }, h('span', {}, iconOf(n)), h('b', {}, n.title || 'Untitled'), h('small', {}, pathOf(n).map((p) => p.title || 'Untitled').join(' / ')))), !rows.length && !allowTop ? h('p', { class: 'sub' }, 'No matching pages.') : null); };
    q.addEventListener('input', draw); const d = dialog(title, q, list, h('div', { class: 'row actions' }, closer('Cancel'))); d.addEventListener('close', () => resolve(out || null)); draw(); setTimeout(() => q.focus(), 30); });
}
export function menu(items, anchor) {
  document.querySelector('.pmenu')?.remove(); const r = anchor.getBoundingClientRect();
  const m = h('div', { class: 'menu pmenu', role: 'menu' }, items.map((it) => (it.sep ? h('hr') : h('button', { type: 'button', role: 'menuitem', class: it.danger ? 'danger' : '', onclick: () => { m.remove(); it.run(); } }, h('b', {}, it.label), it.hint ? h('small', {}, it.hint) : null))));
  document.body.append(m); const mr = m.getBoundingClientRect(); m.style.left = `${Math.max(8, Math.min(r.right - mr.width, innerWidth - mr.width - 8))}px`; m.style.top = `${Math.min(r.bottom + 4, innerHeight - mr.height - 8)}px`;
  const off = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', off, true); document.removeEventListener('touchstart', off, true); } }; setTimeout(() => { document.addEventListener('mousedown', off, true); document.addEventListener('touchstart', off, true); }, 0);
}

// ---- templates ----
const b = (type, html = '', extra = {}) => ({ id: uid('b'), type, html, ...extra });
const todo = (t) => b('todo', t, { checked: false });
export const TEMPLATES = [
  { id: 'blank', name: 'Blank page', icon: '📄', blocks: () => [b('p')] },
  { id: 'journal', name: 'Daily journal', icon: '📓', blocks: () => [b('h2', 'How am I feeling?'), b('p'), b('h2', 'Three things I am grateful for'), b('ol'), b('ol'), b('ol'), b('h2', 'Highlights of the day'), b('p'), b('h2', 'What could have gone better?'), b('p'), b('h2', 'Tomorrow'), todo(''), todo('')] },
  { id: 'meeting', name: 'Meeting notes', icon: '🗒️', blocks: () => [b('callout', '<b>Date:</b> &nbsp;&nbsp; <b>Attendees:</b> ', { icon: '👥' }), b('h2', 'Agenda'), b('ul'), b('h2', 'Notes'), b('p'), b('h2', 'Decisions'), b('ul'), b('h2', 'Action items'), todo(''), todo('')] },
  { id: 'study', name: 'Study notes', icon: '🎓', blocks: () => [b('callout', '<b>Subject:</b> &nbsp; <b>Source:</b> ', { icon: '📚' }), b('h2', 'Key ideas'), b('ul'), b('h2', 'Details'), b('p'), b('h2', 'Questions'), b('ul'), b('h2', 'Summary in my own words'), b('p'), b('h2', 'Review checklist'), todo('Re-read'), todo('Practice questions')] },
  { id: 'project', name: 'Project documentation', icon: '🧭', blocks: () => [b('toc'), b('h1', 'Overview'), b('p'), b('h2', 'Goals'), b('ul'), b('h2', 'Architecture'), b('p'), b('h2', 'Setup'), b('code', '', { lang: '' }), b('h2', 'Milestones'), todo(''), b('h2', 'Open questions'), b('ul')] },
  { id: 'article', name: 'Knowledge article', icon: '💡', blocks: () => [b('callout', 'One-sentence summary of this article.', { icon: '💡' }), b('h2', 'Background'), b('p'), b('h2', 'How it works'), b('p'), b('h2', 'Example'), b('code', '', { lang: '' }), b('h2', 'Related'), b('ul')] },
];
export const allTemplates = () => [...TEMPLATES, ...(S.settings.templates || []).map((t) => ({ ...t, custom: true, blocks: () => JSON.parse(JSON.stringify(t.blocks)).map((x) => ({ ...x, id: uid('b') })) }))];
export const templateBlocks = (id) => (allTemplates().find((t) => t.id === id) || TEMPLATES[0]).blocks();
export const EMOJI = ['📄', '📝', '📓', '📚', '🗂️', '🗃️', '💡', '⭐', '🎯', '🧭', '🔬', '🎓', '💼', '🏠', '🌱', '🔥', '✅', '📌', '📷', '🎨', '🎵', '✈️', '💰', '❤️'];
export const GRADS = { sunset: 'linear-gradient(135deg,#ed6627,#8e4ec6)', ocean: 'linear-gradient(135deg,#00adef,#2f4ec6)', forest: 'linear-gradient(135deg,#2f9e60,#0b5d4a)', dusk: 'linear-gradient(135deg,#34306b,#c34a6f)', sand: 'linear-gradient(135deg,#e0b872,#c97b4a)', slate: 'linear-gradient(135deg,#3c4658,#1c2230)' };
export const coverCss = (c) => (c?.startsWith('grad:') ? GRADS[c.slice(5)] || GRADS.slate : c ? `center / cover no-repeat url("${c}")` : '');

// ---- creating things ----
export async function createNode({ kind = 'page', parentId = null, title = 'Untitled', templateId = null, schema, icon, blocks }) {
  const tpl = kind === 'page' ? templateBlocks(templateId || S.settings.defaultTemplate || 'blank') : [];
  const body = { kind, parentId, title, blocks: blocks || tpl, ...(icon ? { icon } : {}) };
  if (kind === 'database') body.schema = schema || { props: [{ id: uid('pr'), name: 'Status', type: 'status', options: [{ id: uid('o'), name: 'Not started', color: '#707070' }, { id: uid('o'), name: 'In progress', color: '#2f7de1' }, { id: uid('o'), name: 'Done', color: '#2f9e60' }] }, { id: uid('pr'), name: 'Date', type: 'date', options: [] }, { id: uid('pr'), name: 'Tags', type: 'multi_select', options: [] }], views: [{ id: uid('v'), name: 'Table', type: 'table', sort: null, filters: [], groupBy: null, dateProp: null }] };
  const r = await api('POST', '/nodes', body); S.nodes.push(stripBlocks(r.node)); return r.node;
}
export const stripBlocks = ({ blocks, plain, ...m }) => ({ ...m, blockCount: (blocks || []).length });
