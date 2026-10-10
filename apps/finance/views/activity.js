import { h, api, toast } from '../lib/api.js';
import { S, txnSheet, confirmSheet, emptyState, field, select, accountOptions, categoryOptions, acctName, catPath } from '../lib/forms.js';
import { money, day, TYPE_LABEL } from '../lib/fmt.js';
import { txnRow } from './home.js';
import { dialog, closer } from '/shared/ui.js';
import { icon } from '/shared/icons.js';

const F = { q: '', type: '', accountId: '', categoryId: '', range: '', sort: 'date', dir: 'desc' };
export async function render({ frame, goto, rest, openAdd }) {
  const list = h('div', { class: 'card list' }), more = h('button', { class: 'btn ghost small', type: 'button' }, 'Load more'), count = h('p', { class: 'fine' });
  let offset = 0;
  const q = (extra = {}) => new URLSearchParams(Object.entries({ ...F, limit: 40, offset, ...extra }).filter(([, v]) => v !== '' && v != null)).toString();
  async function load(reset) {
    if (reset) { offset = 0; list.replaceChildren(); }
    const r = await api('GET', `/transactions?${q()}`);
    if (reset && !r.items.length) list.append(emptyState('No transactions', F.q || F.type || F.accountId || F.range ? 'Nothing matches those filters.' : 'Tap + to record your first one.'));
    let last = '';
    for (const t of r.items) { if (t.localDate !== last) { last = t.localDate; list.append(h('div', { class: 'dayhead' }, day(t.localDate, S.today))); } list.append(txnRow(t, { onclick: () => detail(t.id) })); }
    offset += r.items.length; more.hidden = offset >= r.total; count.textContent = `${Math.min(offset, r.total)} of ${r.total}`;
  }
  const search = h('input', { type: 'search', placeholder: 'Search description, payee, tag, category…', value: F.q, 'aria-label': 'Search', maxlength: 100 });
  let tm; search.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(() => { F.q = search.value; load(true); }, 250); });
  const sel = (key, opts) => { const s = select(opts, F[key]); s.addEventListener('change', () => { F[key] = s.value; load(true); }); return s; };
  const filters = h('div', { class: 'filters' }, sel('type', [{ value: '', label: 'All types' }, ...S.meta.types.map((t) => ({ value: t, label: TYPE_LABEL[t] }))]), sel('accountId', accountOptions({ blank: 'All accounts' })),
    sel('range', [{ value: '', label: 'Any date' }, ...['today', 'this_week', 'this_month', 'last_month', 'this_year'].map((r) => ({ value: r, label: r.replace('_', ' ') }))]),
    sel('categoryId', [{ value: '', label: 'All categories' }, { value: 'none', label: 'Uncategorised' }, ...categoryOptions('expense', { blank: '—' }).slice(1), ...categoryOptions('income', { blank: '—' }).slice(1)]),
    sel('sort', [{ value: 'date', label: 'Sort: date' }, { value: 'amount', label: 'Sort: amount' }]));
  more.addEventListener('click', () => load(false));
  const add = () => txnSheet({ onDone: () => load(true) });
  frame('activity', h('div', { class: 'page-head' }, h('h1', {}, 'Activity'), h('button', { class: 'btn small', onclick: add }, icon('plus'), 'Add')), search, filters, list, h('div', { class: 'row center' }, more), count,
    h('button', { class: 'fab', 'aria-label': 'Add transaction', onclick: add }, icon('plus')));
  await load(true);
  if (openAdd) add(); if (rest?.[0]) detail(rest[0]);

  async function detail(id) {
    let r; try { r = await api('GET', `/transactions/${id}`); } catch (e) { toast(e.message); return; }
    const t = r.transaction, voided = t.status === 'voided', rows = [['Type', TYPE_LABEL[t.type]], ['Amount', money(t.amountMinor, t.currency)], ['Account', acctName(t.accountId)], t.toAccountId ? ['To', `${acctName(t.toAccountId)} (${money(t.toAmountMinor, t.toCurrency)})`] : null, t.feeMinor ? ['Fee', money(t.feeMinor, t.currency)] : null,
      t.categoryPath ? ['Category', t.categoryPath] : null, t.counterparty ? ['Payee', t.counterparty] : null, ['Date', `${t.localDate} (${new Date(t.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`], t.description ? ['Description', t.description] : null,
      t.tags?.length ? ['Tags', t.tags.join(', ')] : null, t.notes ? ['Notes', t.notes] : null, ['Source', t.source], ['Created', new Date(t.createdAt).toLocaleString()], ['Updated', `${new Date(t.updatedAt).toLocaleString()} (edit ${t.version})`], voided ? ['Voided', t.voidReason || 'yes'] : null].filter(Boolean);
    const acts = voided ? [h('button', { class: 'btn ghost danger', onclick: () => confirmSheet({ title: 'Delete permanently?', message: 'This removes the voided transaction for good.', confirmLabel: 'Delete', danger: true, onConfirm: async () => { await api('DELETE', `/transactions/${id}`, { confirm: true }); d.close(); toast('Deleted'); load(true); } }) }, icon('trash'), 'Delete')] :
      [t.type === 'expense' ? h('button', { class: 'btn ghost', onclick: () => { d.close(); txnSheet({ preset: { type: 'refund', refundOf: t.id, accountId: t.accountId, amount: '' }, onDone: () => load(true) }); } }, 'Refund') : null,
        t.debtId ? null : h('button', { class: 'btn ghost', onclick: () => { d.close(); txnSheet({ txn: t, onDone: () => load(true) }); } }, icon('pencil'), 'Edit'),
        h('button', { class: 'btn ghost danger', onclick: () => { const why = h('input', { type: 'text', placeholder: 'Reason (optional)', maxlength: 200 }); confirmSheet({ title: 'Void this transaction?', message: 'It will stop counting in balances and reports. You can delete it permanently afterwards. Its history is kept.', confirmLabel: 'Void', danger: true, extra: why, onConfirm: async () => { await api('POST', `/transactions/${id}/void`, { confirm: true, reason: why.value, expectedVersion: t.version }); d.close(); toast('Voided'); load(true); } }); } }, 'Void')].filter(Boolean);
    const d = dialog(voided ? 'Voided transaction' : 'Transaction', h('dl', { class: 'dl' }, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))]).flat()),
      r.history.length ? h('details', {}, h('summary', {}, 'History'), r.history.map((x) => h('p', { class: 'sub' }, `${new Date(x.at).toLocaleString()} · ${x.action.replace('transaction.', '')} (${x.source})`))) : null,
      h('div', { class: 'actions row' }, closer('Close'), ...acts));
  }
}
