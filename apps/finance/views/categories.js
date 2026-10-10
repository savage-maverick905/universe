import { h, api, toast } from '../lib/api.js';
import { S, field, select, confirmSheet, loadBase, categoryOptions } from '../lib/forms.js';
import { dialog, closer } from '/shared/ui.js';
import { icon } from '/shared/icons.js';

export async function render({ frame, goto }) {
  const { categories } = await api('GET', '/categories?archived=true'); await loadBase();
  const kids = (id) => categories.filter((c) => (c.parentId || null) === id), kind = (k) => kids(null).filter((c) => c.kind === k);
  const node = (c) => h('div', { class: `cat ${c.archived ? 'arch' : ''}`, style: `margin-left:${c.depth * 14}px` }, h('div', { class: 'line' }, h('span', {}, `${c.icon || '•'} ${c.name}`, c.archived ? h('span', { class: 'badge off' }, 'archived') : null),
    h('span', { class: 'row tight' }, h('button', { class: 'btn ghost small', 'aria-label': `Add subcategory under ${c.name}`, onclick: () => sheet({ parent: c }) }, icon('plus')), h('button', { class: 'btn ghost small', 'aria-label': `Edit ${c.name}`, onclick: () => sheet({ cat: c }) }, icon('pencil')))), ...kids(c.id).map(node));
  function sheet({ cat = null, parent = null, kindDefault = 'expense' }) {
    const name = h('input', { type: 'text', maxlength: 60, required: '', value: cat?.name || '' }), ic = h('input', { type: 'text', maxlength: 8, value: cat?.icon || '', placeholder: '🍲' }), color = h('input', { type: 'color', value: cat?.color || '#ED6627' }), err = h('p', { class: 'err', role: 'alert' });
    const k = select([{ value: 'expense', label: 'Expense' }, { value: 'income', label: 'Income' }], cat?.kind || parent?.kind || kindDefault, cat || parent ? { disabled: '' } : {});
    const parents = select([{ value: '', label: 'Top level' }, ...categories.filter((c) => !c.archived && c.id !== cat?.id && c.kind === (cat?.kind || parent?.kind || kindDefault)).map((c) => ({ value: c.id, label: c.path }))], cat ? cat.parentId || '' : parent?.id || '');
    const save = h('button', { class: 'btn', type: 'submit' }, 'Save');
    const extra = cat ? [h('button', { type: 'button', class: 'btn ghost', onclick: () => { d.close(); archive(cat); } }, cat.archived ? 'Restore' : 'Archive'), h('button', { type: 'button', class: 'btn ghost danger', onclick: () => { d.close(); remove(cat); } }, 'Delete…')] : [];
    const d = dialog(cat ? 'Edit category' : parent ? `New subcategory in ${parent.name}` : 'New category', h('form', { onsubmit: async (e) => { e.preventDefault(); save.disabled = true; err.textContent = '';
      try { const b = { name: name.value, icon: ic.value, color: color.value, parentId: parents.value || null }; if (cat) await api('PATCH', `/categories/${cat.id}`, b); else await api('POST', '/categories', { ...b, kind: k.value }); d.close(); toast('Saved'); goto('#/categories'); } catch (x) { err.textContent = x.message; save.disabled = false; } } },
      field('Name', name), field('Icon (emoji)', ic), field('Colour', color), field('Type', k), field('Parent', parents), err, h('div', { class: 'actions row' }, closer('Cancel'), ...extra, save)));
  }
  const archive = (c) => confirmSheet({ title: c.archived ? 'Restore category?' : 'Archive category?', message: c.archived ? 'It can be chosen again.' : 'It disappears from pickers but old transactions keep it. Subcategories are archived with it.', onConfirm: async () => { await api('POST', `/categories/${c.id}/${c.archived ? 'restore' : 'archive'}`, { cascade: true }); goto('#/categories'); } });
  function remove(c) {
    const target = select(categoryOptions(c.kind, { blank: 'Choose a category…' }).filter((o) => o.value !== c.id), '');
    confirmSheet({ title: `Delete "${c.name}"?`, message: 'Anything using it is moved to the category you choose, so no history is lost. If nothing uses it you can leave this empty.', confirmLabel: 'Delete', danger: true, extra: field('Move everything to', target),
      onConfirm: async () => { await api('DELETE', `/categories/${c.id}${target.value ? `?reassignTo=${target.value}` : ''}`); toast('Deleted'); goto('#/categories'); } });
  }
  frame('more', h('div', { class: 'page-head' }, h('h1', {}, 'Categories'), h('button', { class: 'btn small', onclick: () => sheet({}) }, icon('plus'), 'New')),
    h('div', { class: 'card' }, h('h3', {}, 'Expenses'), kind('expense').map(node)), h('div', { class: 'card' }, h('h3', {}, 'Income'), kind('income').map(node)), h('a', { href: '#/more' }, '← Back'));
}
