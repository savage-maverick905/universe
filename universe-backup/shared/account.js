// Account settings panels (profile, password, install, sign out), shared by the dashboard Settings page
// and every app's own Settings page, so each app is complete on its own.
import { h, api, toast } from './ui.js';
import { icon } from './icons.js';
import { isStandalone, isIos, canPromptInstall, promptInstall, onInstallChange } from './pwa.js';

const panel = (title, ...kids) => h('section', { class: 'panel' }, h('h2', {}, title), ...kids);

// session: the object from /api/auth/me or /api/auth/login (mutated when the name changes).
export function accountPanels({ session, appName, onSignOut }) {
  const u = session.user;

  // Profile
  const name = h('input', { type: 'text', value: u.displayName, maxlength: 80, required: '', autocomplete: 'name' });
  const pErr = h('p', { class: 'err', role: 'alert' });
  const profile = panel('Profile',
    h('p', { class: 'sub' }, `Signed in as ${u.email}`),
    h('form', { onsubmit: async (e) => {
      e.preventDefault(); pErr.textContent = '';
      try { const r = await api('PATCH', '/api/me', { displayName: name.value }); u.displayName = r.user.displayName; document.querySelectorAll('.who').forEach((el) => { el.textContent = u.displayName; }); toast('Name saved'); }
      catch (x) { pErr.textContent = x.message; }
    } }, h('label', {}, 'Your name', name), pErr, h('div', { class: 'row' }, h('button', { class: 'btn small' }, 'Save name'))));

  // Password
  const cur = h('input', { type: 'password', autocomplete: 'current-password', required: '' });
  const nw = h('input', { type: 'password', autocomplete: 'new-password', required: '', minlength: 10 });
  const again = h('input', { type: 'password', autocomplete: 'new-password', required: '', minlength: 10 });
  const wErr = h('p', { class: 'err', role: 'alert' });
  const password = panel('Password',
    h('p', { class: 'sub' }, 'Changing it signs you out on your other devices.'),
    h('form', { onsubmit: async (e) => {
      e.preventDefault(); wErr.textContent = '';
      if (nw.value !== again.value) { wErr.textContent = 'The new passwords do not match.'; return; }
      try { await api('POST', '/api/auth/change-password', { currentPassword: cur.value, newPassword: nw.value }); cur.value = nw.value = again.value = ''; toast('Password changed'); }
      catch (x) { wErr.textContent = x.message; }
    } }, h('label', {}, 'Current password', cur), h('label', {}, 'New password (at least 10 characters)', nw), h('label', {}, 'Repeat new password', again),
      wErr, h('div', { class: 'row' }, h('button', { class: 'btn small' }, 'Change password'))));

  // Install
  const installBody = h('div', {});
  const drawInstall = () => {
    const kids = [];
    if (isStandalone()) kids.push(h('p', { class: 'muted' }, `You are using ${appName} as an installed app.`));
    else if (canPromptInstall()) kids.push(h('p', { class: 'sub' }, `Add ${appName} to your home screen or desktop. It opens in its own window.`),
      h('button', { class: 'btn small', onclick: async () => { if (await promptInstall()) toast(`${appName} installed`); } }, icon('download'), `Install ${appName}`));
    else if (isIos()) kids.push(h('p', { class: 'muted' }, 'On iPhone or iPad: tap the Share button in Safari, then "Add to Home Screen".'));
    else kids.push(h('p', { class: 'muted' }, 'Use your browser menu and choose "Install app" or "Add to Home screen". If you do not see it, this browser may not support installing web apps.'));
    installBody.replaceChildren(...kids);
  };
  drawInstall(); onInstallChange(drawInstall);
  const install = panel('Install', installBody);

  // Session
  const session_ = panel('Session', h('div', { class: 'row', style: 'margin-top:0' },
    h('button', { class: 'btn ghost', onclick: async () => { try { await api('POST', '/api/auth/logout'); } catch { /* already signed out */ } onSignOut(); } }, icon('logout'), 'Sign out')));

  return [profile, password, install, session_];
}
