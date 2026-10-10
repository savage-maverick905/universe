// PIN setup, unlock and recovery screens. The PIN goes only to the server; nothing about "unlocked" is ever kept in the browser.
import { h, api, toast } from '../lib/api.js';
import { icon } from '/shared/icons.js';

const brandMark = () => h('div', { class: 'mark orbit', 'aria-hidden': 'true' }, icon('wallet'));
function pinInput(label, props = {}) {
  const i = h('input', { type: 'password', inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'off', maxlength: 12, class: 'pin', 'aria-label': label, placeholder: '••••••', ...props });
  i.addEventListener('input', () => { i.value = i.value.replace(/\D/g, '').slice(0, 12); });
  return i;
}
export function lockScreen(root, { mode, notice = '', onUnlocked, onSignOut }) {
  // mode: 'setup' | 'unlock' | 'unavailable'
  let view = mode;
  function render(msg = notice) {
    const err = h('p', { class: 'err', role: 'alert' }, msg);
    const brand = h('div', { class: 'auth-brand' }, brandMark(), h('div', {}, h('h1', {}, 'Orbit'), h('p', { class: 'muted' }, 'by Universe')));
    let form;
    if (view === 'unavailable') form = h('div', {}, h('p', {}, 'Orbit needs a server secret before it can protect your finances. Ask the owner to set KEY_ENCRYPTION_SECRET (or FINANCE_SECRET) on the server.'));
    else if (view === 'setup') {
      const a = pinInput('New PIN'), b = pinInput('Repeat PIN'), go = h('button', { class: 'btn' }, 'Create PIN');
      form = h('form', { class: 'auth-form', onsubmit: async (e) => { e.preventDefault(); go.disabled = true; err.textContent = '';
        try { await api('POST', '/pin/setup', { pin: a.value, confirm: b.value }); onUnlocked(); } catch (x) { err.textContent = x.message; go.disabled = false; } } },
        h('p', { class: 'muted' }, 'Choose a Finance PIN (6 to 12 digits). It is separate from your Universe password and protects your money data on every device. Orbit cannot show you the PIN later, so remember it.'),
        h('label', {}, 'New PIN', a), h('label', {}, 'Repeat PIN', b), err, go);
    } else if (view === 'forgot') {
      const pw = h('input', { type: 'password', autocomplete: 'current-password', required: '' }), a = pinInput('New PIN'), b = pinInput('Repeat new PIN'), go = h('button', { class: 'btn' }, 'Reset PIN');
      form = h('form', { class: 'auth-form', onsubmit: async (e) => { e.preventDefault(); go.disabled = true; err.textContent = '';
        try { await api('POST', '/pin/reset', { password: pw.value, next: a.value, confirm: b.value }); onUnlocked(); } catch (x) { err.textContent = x.message; go.disabled = false; } } },
        h('p', { class: 'muted' }, 'Confirm it is you with your Universe password. Your records are not touched; every other device will be locked.'),
        h('label', {}, 'Universe password', pw), h('label', {}, 'New PIN', a), h('label', {}, 'Repeat new PIN', b), err, go,
        h('button', { type: 'button', class: 'linkish', onclick: () => { view = 'unlock'; render(''); } }, 'Back'));
    } else {
      const pin = pinInput('Finance PIN', { autofocus: '' }), go = h('button', { class: 'btn' }, icon('unlock'), 'Unlock');
      const submit = async () => { go.disabled = true; err.textContent = ''; try { await api('POST', '/unlock', { pin: pin.value }); onUnlocked(); } catch (x) { err.textContent = x.message; pin.value = ''; go.disabled = false; pin.focus(); } };
      pin.addEventListener('input', () => { if (pin.value.length >= 12) submit(); });
      form = h('form', { class: 'auth-form', onsubmit: (e) => { e.preventDefault(); submit(); } }, h('p', { class: 'muted' }, 'Orbit is locked. Enter your Finance PIN.'), pin, err, go,
        h('button', { type: 'button', class: 'linkish', onclick: () => { view = 'forgot'; render(''); } }, 'Forgot PIN?'),
        h('button', { type: 'button', class: 'linkish', onclick: onSignOut }, 'Sign out of Universe'));
    }
    root.replaceChildren(h('main', { class: 'auth lockscreen' }, brand, form, h('p', { class: 'fine' }, 'Your balances and transactions are not loaded until you unlock.')));
    root.querySelector('input')?.focus({ preventScroll: true });
  }
  render();
}
