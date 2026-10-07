// Sign-in / create-account screen, shared by the dashboard and every app so each can stand alone.
// The session cookie is per-site, so signing in anywhere signs you in everywhere on this server.
import { h, api } from './ui.js';

// brand: { name, blurb, mark: () => Node }.  Resolves with the signed-in session ({ user, permissions, isAdmin }).
export function showAuth({ root, brand, note = '' }) {
  return new Promise((resolve) => {
    let signupEnabled = false, mode = 'signin';

    function render(message = note) {
      const err = h('p', { class: 'err', role: 'alert' }, message);
      const name = h('input', { type: 'text', placeholder: 'Your name', autocomplete: 'name', maxlength: 80 });
      const email = h('input', { type: 'email', placeholder: 'Email', autocomplete: 'username', required: '', autocapitalize: 'none' });
      const pw = h('input', { type: 'password', placeholder: mode === 'signup' ? 'Password (at least 10 characters)' : 'Password', autocomplete: mode === 'signup' ? 'new-password' : 'current-password', required: '', minlength: mode === 'signup' ? 10 : null });
      const toggle = h('button', { type: 'button', class: 'pw-toggle', 'aria-label': 'Show password', onclick: () => {
        const show = pw.type === 'password'; pw.type = show ? 'text' : 'password'; toggle.textContent = show ? 'Hide' : 'Show'; toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      } }, 'Show');
      const submit = h('button', { class: 'btn' }, mode === 'signup' ? 'Create account' : 'Sign in');
      const form = h('form', { class: 'auth-form', onsubmit: async (e) => {
        e.preventDefault(); err.textContent = ''; submit.disabled = true;
        try {
          const session = mode === 'signup'
            ? await api('POST', '/api/auth/register', { email: email.value, password: pw.value, ...(name.value.trim() ? { displayName: name.value.trim() } : {}) })
            : await api('POST', '/api/auth/login', { email: email.value, password: pw.value });
          resolve(session);
        } catch (x) { err.textContent = x.message; submit.disabled = false; }
      } }, mode === 'signup' ? name : null, email, h('div', { class: 'pw' }, pw, toggle), err, submit);

      const tab = (id, label) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(mode === id), class: mode === id ? 'on' : '', onclick: () => { mode = id; render(''); } }, label);
      root.replaceChildren(h('main', { class: 'auth' },
        h('div', { class: 'auth-brand' }, brand.mark(), h('div', {}, h('h1', {}, brand.name), h('p', { class: 'muted' }, brand.blurb))),
        signupEnabled ? h('div', { class: 'seg', role: 'tablist' }, tab('signin', 'Sign in'), tab('signup', 'Create account')) : null,
        form,
        mode === 'signup' ? h('p', { class: 'fine' }, 'Your account works across all Universe apps.') : (signupEnabled ? null : h('p', { class: 'fine' }, 'New accounts are created by an admin.'))));
      (mode === 'signup' ? name : email).focus({ preventScroll: true });
    }

    api('GET', '/api/auth/config').then((c) => { signupEnabled = !!c.signupEnabled; }).catch(() => {}).finally(() => render());
  });
}
