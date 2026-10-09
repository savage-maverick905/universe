// Settings page: your account for everyone; sign-up rules and people for admins.
import { h, api, toast, dialog, closer, initial } from '/shared/ui.js';
import { accountPanels } from '/shared/account.js';

export async function settingsView({ me, shell, onSignOut }) {
  const can = (p) => me.isAdmin || me.permissions.includes(p);
  const kids = [h('h1', { class: 'page-title' }, 'Settings'), ...accountPanels({ session: me, appName: 'Universe', onSignOut })];
  let roles = [];
  if (can('users.read')) { try { roles = (await api('GET', '/api/roles')).roles; } catch { /* roles are optional here */ } }
  if (can('config.manage')) kids.push(await signupPanel(roles));
  if (can('users.manage') || can('users.read')) kids.push(await peoplePanel(me, roles, can('users.manage')));
  shell('settings', h('div', { class: 'settings' }, kids));
}

const plainRoles = (roles) => roles.filter((r) => !r.permissions.includes('*'));

async function signupPanel(roles) {
  const { settings: s } = await api('GET', '/api/admin/signup');
  const open = h('input', { type: 'checkbox', checked: s.signupEnabled ? '' : null });
  const ai = h('input', { type: 'checkbox', checked: s.signupAllowAi ? '' : null });
  const options = plainRoles(roles);
  const role = h('select', { 'aria-label': 'Role for new accounts' }, options.map((r) => h('option', { value: r.id, selected: r.id === s.signupRoleId ? '' : null }, r.name)));
  const err = h('p', { class: 'err', role: 'alert' });
  return h('section', { class: 'panel' }, h('h2', {}, 'Sign-ups'),
    h('p', { class: 'sub' }, 'Whether new visitors can create their own account on the sign-in screen.'),
    h('label', { class: 'toggle-row' }, open, 'Anyone can create an account'),
    options.length ? h('label', {}, 'New accounts get this role', role) : null,
    h('label', { class: 'toggle-row' }, ai, 'New accounts can use the AI assistant (uses your shared key)'),
    err, h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: async () => {
      err.textContent = '';
      try { await api('PUT', '/api/admin/signup', { signupEnabled: open.checked, signupAllowAi: ai.checked, ...(options.length ? { signupRoleId: role.value } : {}) }); toast('Sign-up settings saved'); }
      catch (x) { err.textContent = x.message; }
    } }, 'Save sign-up settings')));
}

async function peoplePanel(me, roles, canManage) {
  const box = h('ul', { class: 'people' });
  const roleName = (id) => roles.find((r) => r.id === id)?.name || id;
  async function draw() {
    const { users } = await api('GET', '/api/users');
    box.replaceChildren(...users.map((u) => h('li', {},
      h('div', { class: 'avatar', 'aria-hidden': 'true' }, initial(u.displayName)),
      h('div', { class: 'info' }, h('b', {}, u.id === me.user.id ? `${u.displayName} (you)` : u.displayName), h('small', {}, u.email)),
      h('span', { class: u.status === 'active' ? 'badge' : 'badge off' }, u.status === 'active' ? roleName(u.roleId) : 'Disabled'),
      canManage && u.id !== me.user.id ? h('button', { class: 'btn ghost small', onclick: () => person(u) }, 'Manage') : null)));
  }
  function person(u) {
    const role = h('select', {}, roles.map((r) => h('option', { value: r.id, selected: r.id === u.roleId ? '' : null }, r.name)));
    const active = h('input', { type: 'checkbox', checked: u.status === 'active' ? '' : null });
    const ai = h('input', { type: 'checkbox', checked: u.denies.includes('ai.use') ? null : '' });
    const err = h('p', { class: 'err', role: 'alert' });
    const pw = h('input', { type: 'password', autocomplete: 'new-password', minlength: 10, placeholder: 'At least 10 characters' });
    const pwErr = h('p', { class: 'err', role: 'alert' });
    const d = dialog(u.displayName, h('p', { class: 'sub' }, u.email),
      h('label', {}, 'Role', role),
      h('label', { class: 'toggle-row' }, active, 'Account is active (untick to block sign-in)'),
      h('label', { class: 'toggle-row' }, ai, 'Can use the AI assistant'),
      err,
      h('h3', { style: 'margin-top:1.5rem' }, 'Set a new password'),
      h('p', { class: 'sub' }, 'Use this if they forgot theirs. It signs them out everywhere. Tell them the new password yourself.'),
      h('label', {}, 'New password', pw), pwErr,
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn ghost small', onclick: async () => {
        pwErr.textContent = '';
        try { await api('POST', `/api/users/${u.id}/password`, { newPassword: pw.value }); pw.value = ''; toast('Password set'); } catch (x) { pwErr.textContent = x.message; }
      } }, 'Set password')),
      h('div', { class: 'row actions' }, h('button', { type: 'button', class: 'btn', onclick: async () => {
        err.textContent = '';
        const patch = {};
        if (role.value !== u.roleId) patch.roleId = role.value;
        if (active.checked !== (u.status === 'active')) patch.status = active.checked ? 'active' : 'disabled';
        const denies = ai.checked ? u.denies.filter((x) => x !== 'ai.use') : [...new Set([...u.denies, 'ai.use'])];
        if (denies.length !== u.denies.length) patch.denies = denies;
        try { if (Object.keys(patch).length) await api('PATCH', `/api/users/${u.id}`, patch); d.close(); toast('Saved'); await draw(); }
        catch (x) { err.textContent = x.message; }
      } }, 'Save'), closer()));
  }
  function add() {
    const name = h('input', { type: 'text', required: '', maxlength: 80 });
    const email = h('input', { type: 'email', required: '', autocapitalize: 'none' });
    const pw = h('input', { type: 'password', required: '', minlength: 10, autocomplete: 'new-password' });
    const role = h('select', {}, plainRoles(roles).map((r) => h('option', { value: r.id, selected: r.id === 'resident' ? '' : null }, r.name)));
    const err = h('p', { class: 'err', role: 'alert' });
    const d = dialog('Add a person', h('form', { onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      try { await api('POST', '/api/users', { displayName: name.value, email: email.value, password: pw.value, roleId: role.value }); d.close(); toast('Account created'); await draw(); }
      catch (x) { err.textContent = x.message; }
    } }, h('label', {}, 'Name', name), h('label', {}, 'Email', email), h('label', {}, 'Password (at least 10 characters)', pw), h('label', {}, 'Role', role), err,
      h('div', { class: 'row actions' }, h('button', { class: 'btn' }, 'Create account'), closer())));
  }
  await draw();
  return h('section', { class: 'panel' }, h('h2', {}, 'People'),
    h('p', { class: 'sub' }, 'Everyone who has an account on this server.'), box,
    canManage ? h('div', { class: 'row' }, h('button', { class: 'btn ghost small', onclick: add }, 'Add a person')) : null);
}
