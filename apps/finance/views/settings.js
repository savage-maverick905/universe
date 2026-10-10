// "More" hub and Settings (PIN, lock timers, preferences, import / backup).
import { h, api, toast, newKey } from '../lib/api.js';
import { S, field, select, confirmSheet, loadBase } from '../lib/forms.js';
import { accountPanels } from '/shared/account.js';
import { api as rootApi, dialog, closer } from '/shared/ui.js';
import { icon } from '/shared/icons.js';

const tile = (href, ic, t, s) => h('a', { class: 'tile', href }, icon(ic), h('span', {}, h('b', {}, t), h('small', {}, s)));
export async function render({ frame, goto, state, page }) {
  if (page === 'settings') return settings({ frame, goto, state });
  frame('more', h('div', { class: 'page-head' }, h('h1', {}, 'More')), h('div', { class: 'tiles' },
    tile('#/accounts', 'wallet', 'Accounts', 'Cash, banks, mobile money'), tile('#/categories', 'folder', 'Categories', 'Nested, editable'), tile('#/reports', 'chart', 'Reports', 'Totals, trends, export'), tile('#/settings', 'settings', 'Settings', 'PIN, lock, import, backup')));
}
const num = (v) => h('input', { type: 'number', min: '0', value: String(v) });

async function settings({ frame, goto, state }) {
  const lock = await api('GET', '/session'), set = S.settings;
  const err1 = h('p', { class: 'err', role: 'alert' }), cur = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: 12 }), n1 = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: 12 }), n2 = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: 12 });
  const pinPanel = h('section', { class: 'panel' }, h('h2', {}, 'Finance PIN'), h('p', { class: 'sub' }, 'Changing it locks Orbit on your other devices.'), h('form', { onsubmit: async (e) => { e.preventDefault(); err1.textContent = '';
    try { await api('POST', '/pin/change', { current: cur.value, next: n1.value, confirm: n2.value }); cur.value = n1.value = n2.value = ''; toast('PIN changed'); } catch (x) { err1.textContent = x.message; } } },
    field('Current PIN', cur), field('New PIN (6-12 digits)', n1), field('Repeat new PIN', n2), err1, h('div', { class: 'row' }, h('button', { class: 'btn small' }, 'Change PIN'))));
  const idle = num(lock.idleMinutes), away = num(lock.lockWhenHiddenSec);
  const lockPanel = h('section', { class: 'panel' }, h('h2', {}, 'Auto-lock'), h('p', { class: 'sub' }, 'The server enforces these limits on every request, so a stolen tab cannot keep reading your data.'),
    field('Lock after this many idle minutes (1-60)', idle), field('Lock when I leave the app for this many seconds (0 = immediately)', away),
    h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: async () => { try { const r = await api('PUT', '/lock-settings', { idleMinutes: Number(idle.value), lockWhenHiddenSec: Number(away.value) }); state.session = { ...state.session, ...r }; toast('Saved'); } catch (x) { toast(x.message); } } }, 'Save'), h('button', { class: 'btn small ghost', onclick: () => document.querySelector('.me .btn')?.click() }, icon('lock'), 'Lock now')));
  const currency = select(S.meta.currencies.map((c) => ({ value: c.code, label: `${c.code} ${c.symbol}` })), set.currency), tz = h('input', { type: 'text', value: set.timezone, list: 'tzs' }), wk = select([{ value: '1', label: 'Monday' }, { value: '0', label: 'Sunday' }, { value: '6', label: 'Saturday' }], String(set.weekStartsOn)), show = h('input', { type: 'checkbox' });
  show.checked = !!set.showOnDashboard;
  const prefs = h('section', { class: 'panel' }, h('h2', {}, 'Preferences'), h('datalist', { id: 'tzs' }, ['Africa/Lagos', 'Africa/Accra', 'Africa/Nairobi', 'Europe/London', 'America/New_York'].map((z) => h('option', { value: z }))),
    field('Main currency', currency), field('Time zone', tz), field('Week starts on', wk), h('label', { class: 'check' }, show, 'Show balances on the Universe home widget (hidden by default)'),
    h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: async () => { try { await api('PATCH', '/settings', { currency: currency.value, timezone: tz.value, weekStartsOn: Number(wk.value), showOnDashboard: show.checked }); await loadBase(); toast('Saved'); } catch (x) { toast(x.message); } } }, 'Save')));
  const data = h('section', { class: 'panel' }, h('h2', {}, 'Import & backup'), h('p', { class: 'sub' }, 'Your data is stored in your private GitHub repository. Every save is also a commit there, so history exists even beyond these exports.'),
    h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: importSheet }, icon('upload'), 'Import CSV'), h('button', { class: 'btn small ghost', onclick: backup }, icon('download'), 'Download backup'), h('button', { class: 'btn small ghost', onclick: restore }, 'Restore backup')));
  frame('more', h('div', { class: 'page-head' }, h('h1', {}, 'Settings')), h('div', { class: 'settings' }, pinPanel, lockPanel, prefs, data, ...accountPanels({ session: state.me, appName: 'Orbit', onSignOut: () => location.reload() })), h('a', { href: '#/more' }, '← Back'));
}
const download = (name, text, type) => { const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name }); document.body.append(a); a.click(); a.remove(); };
async function backup() { try { const b = await api('GET', '/export/backup'); download(`orbit-backup-${b.exportedAt.slice(0, 10)}.json`, JSON.stringify(b), 'application/json'); toast('Backup downloaded. It contains your financial data: keep it private.'); } catch (e) { toast(e.message); } }
function restore() {
  const file = h('input', { type: 'file', accept: 'application/json,.json' }), out = h('div', {}); let parsed = null;
  const d = dialog('Restore backup', h('p', { class: 'sub' }, 'Adds records from a backup. Existing records are never overwritten.'), file, out, h('div', { class: 'actions row' }, closer('Close'), h('button', { class: 'btn', id: 'go', disabled: '', onclick: async () => { try { const r = await api('POST', '/restore', { backup: parsed, confirm: true }); toast(r.applied ? 'Restored' : 'Nothing changed'); d.close(); await loadBase(); } catch (e) { out.textContent = e.message; } } }, 'Restore')));
  file.addEventListener('change', async () => { try { parsed = JSON.parse(await file.files[0].text()); const r = await api('POST', '/restore', { backup: parsed, dryRun: true }); out.replaceChildren(...Object.entries(r.plan).map(([k, v]) => h('p', { class: 'line' }, `${k}: add ${v.add}, already present ${v.skip}`))); d.querySelector('#go').disabled = false; } catch (e) { out.textContent = e.message || 'Not a valid backup file'; } });
}
function importSheet() {
  const file = h('input', { type: 'file', accept: '.csv,text/csv' }), out = h('div', {}), maps = h('div', {}); let csv = '', headers = [];
  const acc = select(S.accounts.filter((a) => !a.archived).map((a) => ({ value: a.id, label: a.name })), ''), pos = select([{ value: 'income', label: 'Positive amounts are income' }, { value: 'expense', label: 'Positive amounts are expenses' }], 'income'), batch = newKey();
  const sels = {}; for (const k of ['date', 'amount', 'description', 'type', 'category', 'counterparty']) sels[k] = select([{ value: '', label: '— none —' }], '');
  const mapping = () => Object.fromEntries(Object.entries(sels).filter(([, s]) => s.value).map(([k, s]) => [k, s.value])), payload = () => ({ csv, mapping: mapping(), defaults: { accountId: acc.value, positiveIs: pos.value } });
  const preview = h('button', { class: 'btn ghost', type: 'button', disabled: '' }, 'Preview'), go = h('button', { class: 'btn', type: 'button', disabled: '' }, 'Import');
  const d = dialog('Import CSV', h('p', { class: 'sub' }, 'Choose a bank or wallet export. Check the columns, preview, then confirm. Rows that look like ones you already have are skipped.'), file, maps, field('Account for rows without one', acc), field('Sign', pos), out, h('div', { class: 'actions row' }, closer('Close'), preview, go));
  file.addEventListener('change', async () => { csv = await file.files[0].text(); headers = csv.split(/\r?\n/, 1)[0].split(',').map((x) => x.replace(/^"|"$/g, '').trim());
    maps.replaceChildren(...Object.entries(sels).map(([k, s]) => { s.replaceChildren(...[{ value: '', label: '— none —' }, ...headers.map((x) => ({ value: x, label: x }))].map((o) => h('option', { value: o.value }, o.label))); const guess = headers.find((x) => x.toLowerCase().includes(k === 'description' ? 'narr' : k)) || (k === 'description' ? headers.find((x) => /desc|detail|remark/i.test(x)) : ''); s.value = guess || ''; return field(`${k} column`, s); })); preview.disabled = false; });
  preview.addEventListener('click', async () => { out.textContent = ''; try { const r = await api('POST', '/import/preview', payload()); out.replaceChildren(h('p', {}, `${r.total} rows: ${r.valid} ready, ${r.duplicates} look like duplicates, ${r.invalid} with problems.`), ...r.preview.filter((x) => x.errors.length).slice(0, 5).map((x) => h('p', { class: 'err' }, `Row ${x.row}: ${x.errors[0]}`))); go.disabled = r.invalid > 0 || r.valid === 0; } catch (e) { out.replaceChildren(h('p', { class: 'err' }, e.message)); } });
  go.addEventListener('click', async () => { go.disabled = true; try { const r = await api('POST', '/import/confirm', { ...payload(), batchId: batch, confirm: true, skipDuplicates: true }); toast(`Imported ${r.created}, skipped ${r.skippedDuplicates} duplicates`); d.close(); } catch (e) { out.replaceChildren(h('p', { class: 'err' }, e.message)); go.disabled = false; } });
}
