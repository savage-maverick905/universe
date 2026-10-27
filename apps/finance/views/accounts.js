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
  for (const a of live) if (!a.parentId || a.countsInParent) totals[a.currency] = (totals[a.currency] || 0) + a.balanceMinor;
  const subsOf = (id) => live.filter((x) => x.parentId === id), liveIds = new Set(live.map((x) => x.id));
  const tops = live.filter((a) => !a.parentId || !liveIds.has(a.parentId));
  const groups = {}; for (const a of tops) (groups[a.group || KIND[a.kind]] ??= []).push(a);
  const row = (a, sub = false) => {
    const kids = sub ? [] : subsOf(a.id), inc = kids.filter((k) => k.countsInParent).reduce((t, k) => t + k.balanceMinor, 0), shown = a.balanceMinor + inc;
    const note = sub ? (a.countsInParent ? 'In balance' : 'Kept separate') : kids.length ? `${kids.length} sub-account${kids.length > 1 ? 's' : ''}` : '';
    return h('div', { class: sub ? 'subacc' : '' },
      h('a', { class: 'acc', href: `#/accounts/${a.id}` }, h('span', { class: 'ico neutral' }, icon('wallet')), h('span', { class: 'txt' }, h('b', {}, a.name), h('small', {}, [sub ? null : KIND[a.kind], sub ? null : a.provider, note].filter(Boolean).join(' · '))), h('b', { class: shown < 0 ? 'neg' : '' }, money(shown, a.currency))),
      kids.map((k) => row(k, true)));
  };
  frame('more', h('div', { class: 'page-head' }, h('h1', {}, 'Accounts'), h('button', { class: 'btn small', onclick: () => accountSheet(null, () => goto('#/accounts')) }, icon('plus'), 'Add')),
    h('div', { class: 'hero' }, h('small', {}, 'Total'), Object.entries(totals).map(([c, v]) => h('div', { class: 'big' }, money(v, c)))),
    live.length ? Object.entries(groups).map(([g, list]) => h('div', { class: 'card' }, h('h3', {}, g), list.map((a) => row(a)))) : emptyState('No accounts yet', 'Add Cash, OPay, PalmPay, Moniepoint or any account you use.', h('button', { class: 'btn small', onclick: () => accountSheet(null, () => goto('#/accounts')) }, 'Add account')),
    arch.length ? h('details', {}, h('summary', {}, `Archived (${arch.length})`), arch.map((a) => row(a))) : null, h('a', { href: '#/more', class: 'backlink' }, icon('back', 16), 'Back'));
}
export function accountSheet(a, done, preset = {}) {
  const presets = S.meta.presets, name = h('input', { type: 'text', maxlength: 60, required: '', value: a?.name || '', list: 'presets' }), err = h('p', { class: 'err', role: 'alert' });
  const dl = h('datalist', { id: 'presets' }, presets.map((p) => h('option', { value: p.name })));
  const kind = select(Object.entries(KIND).map(([value, label]) => ({ value, label })), a?.kind || 'bank'), cur = select(S.meta.currencies.map((c) => ({ value: c.code, label: `${c.code} ${c.symbol}` })), a?.currency || S.accounts.find((x) => x.id === preset.parentId)?.currency || S.settings.currency, a ? { disabled: '' } : {});
  const open = h('input', { type: 'text', inputmode: 'decimal', value: a ? decimal(a.openingBalanceMinor, a.currency) : '0', 'aria-label': 'Opening balance' }), group = h('input', { type: 'text', maxlength: 40, value: a?.group || '', placeholder: 'e.g. Daily spending' }), prov = h('input', { type: 'text', maxlength: 60, value: a?.provider || '' });
  name.addEventListener('change', () => { const p = presets.find((x) => x.name.toLowerCase() === name.value.toLowerCase()); if (p && !a) kind.value = p.kind; });
  const canNest = !a || !S.accounts.some((x) => x.parentId === a.id && !x.archived);
  const parentSel = h('select', { 'data-sheet': '', 'aria-label': 'Sits inside' }), counts = select([{ value: 'yes', label: 'Yes, part of its balance' }, { value: 'no', label: 'No, kept separate' }], (a ? a.countsInParent : preset.countsInParent ?? true) ? 'yes' : 'no', { 'data-sheet': '', 'aria-label': 'Counts in parent balance' });
  const countsField = field("Counts in the parent's balance and totals?", counts, 'Turn off for money you want tracked but not counted, like locked savings.');
  const fillParents = () => { const keep = parentSel.options.length ? parentSel.value : (a?.parentId || preset.parentId || ''); parentSel.replaceChildren(h('option', { value: '' }, 'None (top-level account)'), ...S.accounts.filter((x) => !x.archived && !x.parentId && x.id !== a?.id && x.currency === cur.value).map((x) => h('option', { value: x.id }, x.name))); parentSel.value = [...parentSel.options].some((o) => o.value === keep) ? keep : ''; countsField.hidden = !parentSel.value; };
  fillParents(); cur.addEventListener('change', fillParents); parentSel.addEventListener('change', () => { countsField.hidden = !parentSel.value; });
  const save = h('button', { class: 'btn', type: 'submit' }, 'Save');
  const d = dialog(a ? 'Edit account' : preset.parentId ? 'New sub-account' : 'New account', h('form', { onsubmit: async (e) => { e.preventDefault(); save.disabled = true; err.textContent = '';
    const b = { name: name.value, kind: kind.value, openingBalance: open.value, group: group.value, provider: prov.value, parentId: canNest ? (parentSel.value || null) : undefined, countsInParent: parentSel.value ? counts.value === 'yes' : false, ...(a ? {} : { currency: cur.value }) };
    if (b.parentId === undefined) delete b.parentId;
    try { await api(a ? 'PATCH' : 'POST', a ? `/accounts/${a.id}` : '/accounts', a ? { ...b, expectedVersion: a.version } : b); d.close(); toast('Saved'); await loadBase(); done(); } catch (x) { err.textContent = x.message; save.disabled = false; } } },
    dl, field('Name', name), field('Type', kind), field('Currency', cur), ...(canNest ? [field('Sits inside another account? (optional)', parentSel), countsField] : []), field('Opening balance (what it held before your first record)', open), field('Group (optional)', group), field('Provider / bank (optional)', prov), err, h('div', { class: 'actions row' }, closer('Cancel'), save)));
}
async function detail({ frame, goto, id }) {
  const [{ account: a }, hist] = await Promise.all([api('GET', `/accounts/${id}`), api('GET', `/accounts/${id}/history?limit=50`)]); await loadBase();
  const subs = S.accounts.filter((x) => x.parentId === id && !x.archived);
  const dissolve = () => {
    const opts = S.accounts.filter((x) => !x.archived && x.id !== id && x.currency === a.currency && x.parentId !== id).map((x) => ({ value: x.id, label: acctName(x.id) }));
    const dest = select(opts, a.parentId && opts.some((o) => o.value === a.parentId) ? a.parentId : opts[0]?.value, { 'data-sheet': '', 'aria-label': 'Move remaining money to' }), err = h('p', { class: 'err', role: 'alert' });
    const go = h('button', { class: 'btn danger', type: 'button', onclick: async () => { go.disabled = true; err.textContent = ''; try { const r = await api('POST', `/accounts/${id}/dissolve`, { toAccountId: dest.value || undefined }); dlg.close(); toast(r.moved ? `Dissolved, ${money(r.moved.amountMinor, a.currency)} moved` : 'Dissolved'); await loadBase(); goto(a.parentId ? `#/accounts/${a.parentId}` : '#/accounts'); } catch (x) { err.textContent = x.message; go.disabled = false; } } }, 'Dissolve');
    const dlg = dialog('Dissolve account', h('p', { class: 'muted' }, 'Its money moves to the account you pick, then it is archived. Its history stays in your records.'), field('Move remaining money to', dest), err, h('div', { class: 'actions row' }, closer('Cancel'), go));
  };
  frame('more', h('div', { class: 'page-head' }, h('h1', {}, a.name), h('div', { class: 'row tight' }, !a.parentId && !a.archived ? h('button', { class: 'btn ghost small', onclick: () => accountSheet(null, () => goto(`#/accounts/${id}`), { parentId: id, countsInParent: true }) }, icon('plus'), 'Sub') : null, h('button', { class: 'btn ghost small', onclick: () => accountSheet(a, () => goto(`#/accounts/${id}`)) }, icon('pencil'), 'Edit'))),
    h('div', { class: 'hero' }, h('small', {}, a.parentId ? `Inside ${acctName(a.parentId)}` : 'Balance'), h('div', { class: 'big' }, money(a.balanceMinor, a.currency)), h('div', { class: 'chips' }, h('span', {}, `Opening ${money(a.openingBalanceMinor, a.currency)}`), h('span', {}, a.archived ? 'Archived' : 'Active'), a.parentId ? h('span', {}, a.countsInParent ? 'Counts in parent' : 'Kept separate') : null)),
    subs.length ? h('div', { class: 'card' }, h('h3', {}, 'Sub-accounts'), subs.map((k) => h('a', { class: 'acc', href: `#/accounts/${k.id}` }, h('span', { class: 'ico neutral' }, icon('wallet')), h('span', { class: 'txt' }, h('b', {}, k.name), h('small', {}, k.countsInParent ? 'In balance' : 'Kept separate')), h('b', {}, money(k.balanceMinor, k.currency)))), h('div', { class: 'line total' }, h('span', {}, 'With sub-accounts that count'), h('b', {}, money(a.balanceMinor + subs.filter((k) => k.countsInParent).reduce((t, k) => t + k.balanceMinor, 0), a.currency)))) : null,
    h('div', { class: 'card' }, h('h3', {}, 'History'), hist.items.length ? hist.items.map((x) => h('div', {}, txnRow({ ...x.transaction, categoryPath: '' }, { acctId: id, onclick: () => goto(`#/activity/${x.transactionId}`) }), h('small', { class: 'bal' }, `Balance after: ${money(x.balanceAfterMinor, a.currency)}`))) : h('p', { class: 'muted' }, 'No transactions on this account yet.')),
    h('div', { class: 'row' }, !a.archived && !subs.length ? h('button', { class: 'btn ghost danger', onclick: dissolve }, 'Dissolve') : null, h('button', { class: 'btn ghost', onclick: () => confirmSheet({ title: a.archived ? 'Restore account?' : 'Archive account?', message: a.archived ? 'It will be available for new transactions again.' : 'It is hidden from pickers but its history and totals stay.', onConfirm: async () => { await api('POST', `/accounts/${id}/${a.archived ? 'restore' : 'archive'}`, {}); await loadBase(); goto('#/accounts'); } }) }, a.archived ? 'Restore' : 'Archive')), h('a', { href: '#/accounts' }, 'Back to All accounts'));
}
