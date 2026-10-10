import { h, api, toast } from '../lib/api.js';
import { S, field, select, confirmSheet, emptyState, loadBase, acctName } from '../lib/forms.js';
import { money, decimal, day } from '../lib/fmt.js';
import { txnRow } from './home.js';
import { dialog, closer } from '/shared/ui.js';
import { icon } from '/shared/icons.js';

const KIND = { cash: 'Cash', bank: 'Bank', mobile_money: 'Mobile money', savings: 'Savings', wallet: 'Wallet', credit: 'Credit', investment: 'Investment', other: 'Other' };
export async function render({ frame, goto, rest }) {
  if (rest?.[0]) return detail({ frame, goto, id: rest[0] });
  const { accounts } = await api('GET', '/accounts?archived=true'); await loadBase();
  const live = accounts.filter((a) => !a.archived), arch = accounts.filter((a) => a.archived), totals = {};
  for (const a of live) totals[a.currency] = (totals[a.currency] || 0) + a.balanceMinor;
  const groups = {}; for (const a of live) (groups[a.group || KIND[a.kind]] ??= []).push(a);
  const row = (a) => h('a', { class: 'acc', href: `#/accounts/${a.id}` }, h('span', { class: 'ico neutral' }, icon('wallet')), h('span', { class: 'txt' }, h('b', {}, a.name), h('small', {}, [KIND[a.kind], a.provider].filter(Boolean).join(' · '))), h('b', { class: a.balanceMinor < 0 ? 'neg' : '' }, money(a.balanceMinor, a.currency)));
  frame('more', h('div', { class: 'page-head' }, h('h1', {}, 'Accounts'), h('button', { class: 'btn small', onclick: () => accountSheet(null, () => goto('#/accounts')) }, icon('plus'), 'Add')),
    h('div', { class: 'hero' }, h('small', {}, 'Total'), Object.entries(totals).map(([c, v]) => h('div', { class: 'big' }, money(v, c)))),
    live.length ? Object.entries(groups).map(([g, list]) => h('div', { class: 'card' }, h('h3', {}, g), list.map(row))) : emptyState('No accounts yet', 'Add Cash, OPay, PalmPay, Moniepoint or any account you use.', h('button', { class: 'btn small', onclick: () => accountSheet(null, () => goto('#/accounts')) }, 'Add account')),
    arch.length ? h('details', {}, h('summary', {}, `Archived (${arch.length})`), arch.map(row)) : null, h('a', { href: '#/more' }, '← Back'));
}
export function accountSheet(a, done) {
  const presets = S.meta.presets, name = h('input', { type: 'text', maxlength: 60, required: '', value: a?.name || '', list: 'presets' }), err = h('p', { class: 'err', role: 'alert' });
  const dl = h('datalist', { id: 'presets' }, presets.map((p) => h('option', { value: p.name })));
  const kind = select(Object.entries(KIND).map(([value, label]) => ({ value, label })), a?.kind || 'bank'), cur = select(S.meta.currencies.map((c) => ({ value: c.code, label: `${c.code} ${c.symbol}` })), a?.currency || S.settings.currency, a ? { disabled: '' } : {});
  const open = h('input', { type: 'text', inputmode: 'decimal', value: a ? decimal(a.openingBalanceMinor, a.currency) : '0', 'aria-label': 'Opening balance' }), group = h('input', { type: 'text', maxlength: 40, value: a?.group || '', placeholder: 'e.g. Daily spending' }), prov = h('input', { type: 'text', maxlength: 60, value: a?.provider || '' });
  name.addEventListener('change', () => { const p = presets.find((x) => x.name.toLowerCase() === name.value.toLowerCase()); if (p && !a) kind.value = p.kind; });
  const save = h('button', { class: 'btn', type: 'submit' }, 'Save');
  const d = dialog(a ? 'Edit account' : 'New account', h('form', { onsubmit: async (e) => { e.preventDefault(); save.disabled = true; err.textContent = '';
    const b = { name: name.value, kind: kind.value, openingBalance: open.value, group: group.value, provider: prov.value, ...(a ? {} : { currency: cur.value }) };
    try { await api(a ? 'PATCH' : 'POST', a ? `/accounts/${a.id}` : '/accounts', a ? { ...b, expectedVersion: a.version } : b); d.close(); toast('Saved'); await loadBase(); done(); } catch (x) { err.textContent = x.message; save.disabled = false; } } },
    dl, field('Name', name), field('Type', kind), field('Currency', cur), field('Opening balance (what it held before your first record)', open), field('Group (optional)', group), field('Provider / bank (optional)', prov), err, h('div', { class: 'actions row' }, closer('Cancel'), save)));
}
async function detail({ frame, goto, id }) {
  const [{ account: a }, hist] = await Promise.all([api('GET', `/accounts/${id}`), api('GET', `/accounts/${id}/history?limit=50`)]);
  frame('more', h('div', { class: 'page-head' }, h('h1', {}, a.name), h('button', { class: 'btn ghost small', onclick: () => accountSheet(a, () => goto(`#/accounts/${id}`)) }, icon('pencil'), 'Edit')),
    h('div', { class: 'hero' }, h('small', {}, 'Balance'), h('div', { class: 'big' }, money(a.balanceMinor, a.currency)), h('div', { class: 'chips' }, h('span', {}, `Opening ${money(a.openingBalanceMinor, a.currency)}`), h('span', {}, a.archived ? 'Archived' : 'Active'))),
    h('div', { class: 'card' }, h('h3', {}, 'History'), hist.items.length ? hist.items.map((x) => h('div', {}, txnRow({ ...x.transaction, categoryPath: '' }, { acctId: id, onclick: () => goto(`#/activity/${x.transactionId}`) }), h('small', { class: 'bal' }, `Balance after: ${money(x.balanceAfterMinor, a.currency)}`))) : h('p', { class: 'muted' }, 'No transactions on this account yet.')),
    h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => confirmSheet({ title: a.archived ? 'Restore account?' : 'Archive account?', message: a.archived ? 'It will be available for new transactions again.' : 'It is hidden from pickers but its history and totals stay.', onConfirm: async () => { await api('POST', `/accounts/${id}/${a.archived ? 'restore' : 'archive'}`, {}); await loadBase(); goto('#/accounts'); } }) }, a.archived ? 'Restore' : 'Archive')), h('a', { href: '#/accounts' }, '← All accounts'));
}
