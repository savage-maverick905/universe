// Shared form pieces: selects, the add/edit transaction sheet, and the confirm dialog.
import { h, toast, api, newKey } from './api.js';
import { dialog, closer } from '/shared/ui.js';
import { icon } from '/shared/icons.js';
import { money, decimal, TYPE_LABEL } from './fmt.js';

export const S = { me: null, meta: null, settings: null, accounts: [], cats: [], today: '' };

export async function loadBase() {
  const [meta, settings, accounts, cats] = await Promise.all([api('GET', '/meta'), api('GET', '/settings'), api('GET', '/accounts'), api('GET', '/categories')]);
  Object.assign(S, { meta, settings: settings.settings, accounts: accounts.accounts, cats: cats.categories, today: meta.today });
  return S;
}
export const acctName = (id) => S.accounts.find((a) => a.id === id)?.name || 'Unknown account';
export const acct = (id) => S.accounts.find((a) => a.id === id);
export const catPath = (id) => S.cats.find((c) => c.id === id)?.path || '';
export const defaultCurrency = () => S.settings?.currency || 'NGN';

export const field = (label, input, hint) => h('label', {}, label, input, hint ? h('span', { class: 'hint' }, hint) : null);
export function select(options, value, props = {}) {
  const s = h('select', props, options.map((o) => h('option', { value: o.value }, o.label)));
  s.value = value ?? options[0]?.value ?? ''; return s;
}
export const accountOptions = ({ include = true, blank = null, exclude = null, currency = null } = {}) =>
  [...(blank ? [{ value: '', label: blank }] : []), ...S.accounts.filter((a) => !a.archived && a.id !== exclude && (!currency || a.currency === currency)).map((a) => ({ value: a.id, label: `${a.name} · ${a.currency}` }))];
export function categoryOptions(kind, { blank = 'No category', selected = null } = {}) {
  const list = S.cats.filter((c) => c.kind === kind && (!c.archived || c.id === selected)).sort((a, b) => a.path.localeCompare(b.path));
  return [{ value: '', label: blank }, ...list.map((c) => ({ value: c.id, label: `${'\u2003'.repeat(c.depth)}${c.icon ? `${c.icon} ` : ''}${c.name}` }))];
}

// Add / edit sheet. `txn` = existing transaction to edit; `preset` = fields to start with. onDone() runs after a successful save.
export function txnSheet({ txn = null, preset = {}, onDone = () => {} } = {}) {
  const editing = !!txn, key = newKey(), base = txn || preset;
  let type = base.type || 'expense';
  const types = editing ? [txn.type] : ['expense', 'income', 'transfer', 'refund', 'adjustment'];
  const err = h('p', { class: 'err', role: 'alert' }), body = h('div', {});
  const amount = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00', class: 'big-amount', value: txn ? decimal(txn.amountMinor, txn.currency) : base.amount || '', 'aria-label': 'Amount' });
  const accountSel = select(accountOptions(), base.accountId || S.accounts.find((a) => !a.archived)?.id);
  const toSel = select(accountOptions({ blank: 'Choose…' }), base.toAccountId || '');
  const catSel = () => select(categoryOptions(type === 'income' ? 'income' : 'expense', { selected: base.categoryId }), base.categoryId || '');
  let cat = catSel();
  const date = h('input', { type: 'date', value: txn?.localDate || base.date || S.today, max: '' }), time = h('input', { type: 'time', value: '' });
  const desc = h('input', { type: 'text', maxlength: 200, value: txn?.description || base.description || '', placeholder: 'What was it for?' });
  const who = h('input', { type: 'text', maxlength: 100, value: txn?.counterparty || base.counterparty || '', placeholder: type === 'income' ? 'Who paid you?' : 'Who did you pay?' });
  const tags = h('input', { type: 'text', value: (txn?.tags || []).join(' '), placeholder: 'space-separated' }), notes = h('textarea', { rows: 2, maxlength: 1000 }, txn?.notes || '');
  const fee = h('input', { type: 'text', inputmode: 'decimal', placeholder: '0.00', value: txn?.feeMinor ? decimal(txn.feeMinor, txn.currency) : '' });
  const toAmount = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'Amount that arrives' });
  const dir = select([{ value: 'increase', label: 'Increase the balance' }, { value: 'decrease', label: 'Decrease the balance' }], txn?.direction || 'increase');
  const refundOf = h('input', { type: 'hidden', value: txn?.refundOf || base.refundOf || '' });
  const rules = h('p', { class: 'rule' });
  const RULE = { expense: 'Counts as spending.', income: 'Counts as income.', transfer: 'Moves your own money. Not income or spending (a fee counts as spending).', refund: 'Money back for a purchase. Not income: it reduces spending in that category.', adjustment: 'Corrects the balance. Not income or spending.' };
  function draw() {
    rules.textContent = RULE[type] || '';
    const needsCat = type === 'income' || type === 'expense' || (type === 'refund' && !refundOf.value);
    const cross = type === 'transfer' && acct(accountSel.value) && acct(toSel.value) && acct(accountSel.value).currency !== acct(toSel.value).currency;
    body.replaceChildren(
      field('Amount', amount),
      field(type === 'transfer' ? 'From' : type === 'income' ? 'Paid into' : 'Account', accountSel),
      type === 'transfer' ? field('To', toSel) : null, cross ? field(`Amount that arrives (${acct(toSel.value).currency})`, toAmount) : null,
      type === 'transfer' ? field('Transfer fee (optional)', fee) : null,
      type === 'adjustment' ? field('Direction', dir) : null,
      needsCat ? field('Category', cat) : null,
      ['income', 'expense', 'refund'].includes(type) ? field(type === 'income' ? 'From' : 'Payee', who) : null,
      field('Description', desc), h('div', { class: 'two' }, field('Date', date), field('Time (optional)', time)),
      h('details', {}, h('summary', {}, 'More details'), field('Tags', tags), field('Notes', notes)), rules);
  }
  const seg = h('div', { class: 'seg5', role: 'tablist' }, types.map((t) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(t === type), class: t === type ? 'on' : '', disabled: editing && t !== type ? '' : null, onclick: () => { type = t; cat = catSel(); seg.querySelectorAll('button').forEach((b, i) => { b.className = types[i] === type ? 'on' : ''; b.setAttribute('aria-selected', String(types[i] === type)); }); draw(); } }, TYPE_LABEL[t])));
  accountSel.addEventListener('change', draw); toSel.addEventListener('change', draw);
  draw();
  const save = h('button', { class: 'btn', type: 'submit' }, editing ? 'Save changes' : 'Save');
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ''; save.disabled = true; save.textContent = 'Saving…'; // disabled while in flight: a double tap cannot submit twice
    const b = { type, amount: amount.value, accountId: accountSel.value, description: desc.value, counterparty: ['income', 'expense', 'refund'].includes(type) ? who.value : '', tags: tags.value.split(/[\s,]+/).filter(Boolean), notes: notes.value };
    if (!editing || date.value !== txn.localDate) b.date = date.value; // keep the original time of day unless the date was changed
    if (time.value) b.time = time.value;
    if (type === 'income' || type === 'expense' || (type === 'refund' && !refundOf.value)) b.categoryId = cat.value || null;
    if (type === 'transfer') { b.toAccountId = toSel.value; b.fee = fee.value; if (toAmount.value) b.toAmount = toAmount.value; }
    if (type === 'adjustment') b.direction = dir.value;
    if (type === 'refund' && refundOf.value) b.refundOf = refundOf.value;
    try {
      const r = editing ? await api('PATCH', `/transactions/${txn.id}`, { ...b, type: undefined, expectedVersion: txn.version }) : await api('POST', '/transactions', { ...b, idempotencyKey: key });
      d.close(); toast(editing ? 'Changes saved' : r.replayed ? 'Already saved' : 'Saved'); (r.warnings || []).forEach((w) => toast(w.message)); await onDone(r);
    } catch (x) { err.textContent = x.status === 409 && x.code === 'stale' ? `${x.message}` : x.message; save.disabled = false; save.textContent = editing ? 'Save changes' : 'Save'; }
  } }, body, err, h('div', { class: 'actions row' }, closer('Cancel'), save));
  const d = dialog(editing ? 'Edit transaction' : 'New transaction', seg, form);
  setTimeout(() => amount.focus({ preventScroll: true }), 50);
  return d;
}

export function confirmSheet({ title, message, confirmLabel = 'Confirm', danger = false, extra = null, onConfirm }) {
  const err = h('p', { class: 'err', role: 'alert' }), go = h('button', { class: `btn ${danger ? 'danger' : ''}`, type: 'button' }, confirmLabel);
  const d = dialog(title, h('p', {}, message), extra, err, h('div', { class: 'actions row' }, closer('Cancel'), go));
  go.addEventListener('click', async () => { go.disabled = true; err.textContent = ''; try { await onConfirm(); d.close(); } catch (x) { err.textContent = x.message; go.disabled = false; } });
  return d;
}
export const emptyState = (title, text, action) => h('div', { class: 'empty' }, h('b', {}, title), h('p', { class: 'muted' }, text), action || null);
export const iconBtn = (name, label, onclick) => h('button', { class: 'btn ghost small', type: 'button', 'aria-label': label, title: label, onclick }, icon(name));
