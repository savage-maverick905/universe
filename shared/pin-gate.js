// A small Finance-PIN prompt for Universe screens that touch Orbit (Nebula, the home widget, reports).
// The PIN goes straight to the server through `action` and is never kept. Resolves to the action's result, or null if cancelled.
import { h, dialog, closer } from './ui.js';
export function askFinancePin({ title = 'Enter your Finance PIN', note = '', label = 'Unlock', action }) {
  return new Promise((resolve) => {
    let result = null;
    const pin = h('input', { type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: 12, autocomplete: 'off', required: '', 'aria-label': 'Finance PIN' });
    const err = h('p', { class: 'err', role: 'alert' }), go = h('button', { class: 'btn', type: 'submit' }, label);
    const d = dialog(title, note ? h('p', { class: 'sub' }, note) : null, h('form', { onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''; go.disabled = true;
      try { result = (await action(pin.value)) ?? true; pin.value = ''; d.close(); } catch (x) { err.textContent = x.message; go.disabled = false; pin.select(); }
    } }, h('label', {}, 'Finance PIN', pin), err, h('div', { class: 'actions row' }, closer('Cancel'), go)));
    d.addEventListener('close', () => resolve(result));
    pin.focus();
  });
}
export const unlockOrbit = (api) => (pin) => api('POST', '/api/apps/finance/hub/unlock', { pin });
