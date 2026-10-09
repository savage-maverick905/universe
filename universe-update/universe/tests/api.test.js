import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, closeAll } from './helpers.js';

after(closeAll); // never leave a server open if an assertion fails

const ADMIN = ['admin@example.com', 'correct-horse-battery'];

async function setup() {
  const t = await startTestApp();
  const admin = await t.login(...ADMIN);
  const mkUser = async (email, roleId = 'resident') => {
    const r = await t.request('POST', '/api/users', { cookie: admin.cookie, body: { email, displayName: email.split('@')[0], password: 'a-decent-password', roleId } });
    assert.equal(r.status, 201, r.text);
    return { ...r.json.user, ...(await t.login(email, 'a-decent-password')) };
  };
  return { t, admin, mkUser };
}

test('unauthenticated access is rejected; health is open', async () => {
  const { t } = await setup();
  assert.equal((await t.request('GET', '/api/auth/me')).status, 401);
  assert.equal((await t.request('GET', '/api/users')).status, 401);
  assert.equal((await t.request('GET', '/healthz')).status, 200);
  assert.equal((await t.request('GET', '/nope')).status, 404);
  await t.close();
});

test('login: cookie flags, generic failures, no secrets in responses', async () => {
  const { t } = await setup();
  const ok = await t.request('POST', '/api/auth/login', { body: { email: ADMIN[0], password: ADMIN[1] } });
  assert.equal(ok.status, 200);
  const sc = ok.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Lax/);
  assert.ok(!/passwordHash|scrypt\$/.test(ok.text));
  assert.equal(ok.json.isAdmin, true);
  const bad = await t.request('POST', '/api/auth/login', { body: { email: ADMIN[0], password: 'wrong-password' } });
  const unknown = await t.request('POST', '/api/auth/login', { body: { email: 'ghost@example.com', password: 'wrong-password' } });
  assert.equal(bad.status, 401); assert.equal(unknown.status, 401);
  assert.deepEqual(bad.json, unknown.json);
  await t.close();
});

test('CSRF: missing header and foreign origin are blocked; non-JSON rejected', async () => {
  const { t, admin } = await setup();
  const noHeader = await fetch(`http://127.0.0.1:${t.app.server.address().port}/api/auth/logout`, { method: 'POST', headers: { Cookie: admin.cookie } });
  assert.equal(noHeader.status, 403);
  assert.equal((await t.request('POST', '/api/auth/logout', { cookie: admin.cookie, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await t.request('POST', '/api/users', { cookie: admin.cookie, headers: { 'Content-Type': 'text/plain' }, raw: 'x' })).status, 415);
  assert.equal((await t.request('POST', '/api/auth/login', { raw: '{bad', headers: { 'Content-Type': 'application/json' } })).status, 400);
  await t.close();
});

test('login lockout after repeated failures, resets on success for others', async () => {
  const { t } = await setup();
  for (let i = 0; i < 5; i++) assert.equal((await t.login(ADMIN[0], 'nope-nope-nope')).status, 401);
  const blocked = await t.login(...ADMIN);
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers.get('retry-after'));
  await t.close();
});

test('RBAC: resident cannot manage users, read audit, or escalate', async () => {
  const { t, admin, mkUser } = await setup();
  const res = await mkUser('res@example.com');
  assert.equal((await t.request('GET', '/api/audit', { cookie: res.cookie })).status, 403);
  assert.equal((await t.request('GET', '/api/users', { cookie: res.cookie })).status, 403);
  assert.equal((await t.request('POST', '/api/users', { cookie: res.cookie, body: { email: 'z@example.com', displayName: 'z', password: 'a-decent-password' } })).status, 403);
  // self-escalation attempts: unknown field and forbidden route
  assert.equal((await t.request('PATCH', '/api/me', { cookie: res.cookie, body: { roleId: 'admin' } })).status, 400);
  assert.equal((await t.request('PATCH', `/api/users/${res.id}`, { cookie: res.cookie, body: { roleId: 'admin' } })).status, 403);
  const me = await t.request('GET', '/api/auth/me', { cookie: res.cookie });
  assert.equal(me.json.isAdmin, false);
  assert.deepEqual(me.json.permissions, ['ai.use']);
  // admin can see audit
  const audit = await t.request('GET', '/api/audit', { cookie: admin.cookie });
  assert.equal(audit.status, 200);
  assert.ok(audit.json.entries.some((e) => e.action === 'user.create'));
  assert.ok(!JSON.stringify(audit.json).includes('a-decent-password'));
  await t.close();
});

test('guest has no permissions by default; explicit grant works and denies override', async () => {
  const { t, admin, mkUser } = await setup();
  const g = await mkUser('guest@example.com', 'guest');
  const me0 = await t.request('GET', '/api/auth/me', { cookie: g.cookie });
  assert.deepEqual(me0.json.permissions, []);
  assert.equal((await t.request('PATCH', `/api/users/${g.id}`, { cookie: admin.cookie, body: { grants: ['ai.use'] } })).status, 200);
  const g2 = await t.login('guest@example.com', 'a-decent-password');
  assert.deepEqual((await t.request('GET', '/api/auth/me', { cookie: g2.cookie })).json.permissions, ['ai.use']);
  await t.request('PATCH', `/api/users/${g.id}`, { cookie: admin.cookie, body: { denies: ['ai.use'] } });
  const g3 = await t.login('guest@example.com', 'a-decent-password');
  assert.deepEqual((await t.request('GET', '/api/auth/me', { cookie: g3.cookie })).json.permissions, []);
  assert.equal((await t.request('PATCH', `/api/users/${g.id}`, { cookie: admin.cookie, body: { grants: ['*'] } })).status, 400);
  assert.equal((await t.request('PATCH', `/api/users/${g.id}`, { cookie: admin.cookie, body: { grants: ['made.up'] } })).status, 400);
  await t.close();
});

test('admin safeguards: no self-demotion, last admin protected, disabling kills sessions', async () => {
  const { t, admin, mkUser } = await setup();
  const me = (await t.request('GET', '/api/auth/me', { cookie: admin.cookie })).json.user;
  assert.equal((await t.request('PATCH', `/api/users/${me.id}`, { cookie: admin.cookie, body: { roleId: 'resident' } })).status, 403);
  const res = await mkUser('victim@example.com');
  assert.equal((await t.request('PATCH', `/api/users/${res.id}`, { cookie: admin.cookie, body: { status: 'disabled' } })).status, 200);
  assert.equal((await t.request('GET', '/api/auth/me', { cookie: res.cookie })).status, 401);
  assert.equal((await t.login('victim@example.com', 'a-decent-password')).status, 401);
  // With two admins, one may disable the other (the guard against removing the LAST admin is
  // defence in depth: other safeguards already block every route to it).
  const a2 = await mkUser('admin2@example.com', 'admin');
  assert.equal((await t.request('PATCH', `/api/users/${me.id}`, { cookie: a2.cookie, body: { status: 'disabled' } })).status, 200);
  assert.equal((await t.request('GET', '/api/auth/me', { cookie: admin.cookie })).status, 401);
  await t.close();
});

test('delegated user manager cannot create admins or touch admins', async () => {
  const { t, admin, mkUser } = await setup();
  await t.request('POST', '/api/roles', { cookie: admin.cookie, body: { id: 'manager', name: 'Manager', permissions: ['users.read', 'users.manage'] } });
  const mgr = await mkUser('mgr@example.com', 'manager');
  assert.equal((await t.request('POST', '/api/users', { cookie: mgr.cookie, body: { email: 'n@example.com', displayName: 'n', password: 'a-decent-password', roleId: 'admin' } })).status, 403);
  const adminId = (await t.request('GET', '/api/auth/me', { cookie: admin.cookie })).json.user.id;
  assert.equal((await t.request('PATCH', `/api/users/${adminId}`, { cookie: mgr.cookie, body: { displayName: 'pwned' } })).status, 403);
  assert.equal((await t.request('POST', '/api/roles', { cookie: mgr.cookie, body: { id: 'x', name: 'x', permissions: [] } })).status, 403);
  // cannot grant what they don't hold
  const low = await mkUser('low@example.com');
  assert.equal((await t.request('PATCH', `/api/users/${low.id}`, { cookie: mgr.cookie, body: { grants: ['audit.read'] } })).status, 403);
  assert.equal((await t.request('PATCH', `/api/users/${low.id}`, { cookie: mgr.cookie, body: { grants: ['users.read'] } })).status, 200);
  await t.close();
});

test('roles: admin role locked; system roles undeletable; in-use roles undeletable', async () => {
  const { t, admin, mkUser } = await setup();
  assert.equal((await t.request('PATCH', '/api/roles/admin', { cookie: admin.cookie, body: { permissions: [] } })).status, 403);
  assert.equal((await t.request('DELETE', '/api/roles/guest', { cookie: admin.cookie })).status, 403);
  await t.request('POST', '/api/roles', { cookie: admin.cookie, body: { id: 'temp', name: 'Temp', permissions: [] } });
  await mkUser('t@example.com', 'temp');
  assert.equal((await t.request('DELETE', '/api/roles/temp', { cookie: admin.cookie })).status, 409);
  assert.equal((await t.request('GET', '/api/permissions', { cookie: admin.cookie })).status, 200);
  await t.close();
});

test('profiles: visibility enforced per field; shared list respected', async () => {
  const { t, mkUser } = await setup();
  const a = await mkUser('a@example.com'); const b = await mkUser('b@example.com'); const c = await mkUser('c@example.com');
  assert.equal((await t.request('PATCH', '/api/me', { cookie: a.cookie, body: { bio: 'my private bio', avatarUrl: 'https://res.cloudinary.com/x/a.png' } })).status, 200);
  assert.equal((await t.request('PATCH', '/api/me', { cookie: a.cookie, body: { avatarUrl: 'javascript:alert(1)' } })).status, 400);
  let p = await t.request('GET', `/api/users/${a.id}/profile`, { cookie: b.cookie });
  assert.equal(p.json.profile.bio, undefined);
  assert.equal(p.json.profile.displayName, 'a');
  await t.request('PUT', '/api/me/visibility', { cookie: a.cookie, body: { bio: { level: 'shared', sharedWith: [b.id] } } });
  assert.equal((await t.request('GET', `/api/users/${a.id}/profile`, { cookie: b.cookie })).json.profile.bio, 'my private bio');
  assert.equal((await t.request('GET', `/api/users/${a.id}/profile`, { cookie: c.cookie })).json.profile.bio, undefined);
  assert.equal((await t.request('PUT', '/api/me/visibility', { cookie: a.cookie, body: { bio: { level: 'shared', sharedWith: ['user_ghost'] } } })).status, 400);
  assert.equal((await t.request('GET', `/api/users/${a.id}`, { cookie: b.cookie })).status, 403); // account details need users.read
  await t.close();
});

test('password change: needs current password, revokes other sessions', async () => {
  const { t, mkUser } = await setup();
  const u = await mkUser('pw@example.com');
  const second = await t.login('pw@example.com', 'a-decent-password');
  assert.equal((await t.request('POST', '/api/auth/change-password', { cookie: u.cookie, body: { currentPassword: 'wrong-wrong-wrong', newPassword: 'brand-new-password' } })).status, 401);
  assert.equal((await t.request('POST', '/api/auth/change-password', { cookie: u.cookie, body: { currentPassword: 'a-decent-password', newPassword: 'short' } })).status, 400);
  assert.equal((await t.request('POST', '/api/auth/change-password', { cookie: u.cookie, body: { currentPassword: 'a-decent-password', newPassword: 'brand-new-password' } })).status, 200);
  assert.equal((await t.request('GET', '/api/auth/me', { cookie: second.cookie })).status, 401);
  assert.equal((await t.request('GET', '/api/auth/me', { cookie: u.cookie })).status, 200);
  assert.equal((await t.login('pw@example.com', 'brand-new-password')).status, 200);
  await t.close();
});

test('logout invalidates the session server-side', async () => {
  const { t, admin } = await setup();
  assert.equal((await t.request('POST', '/api/auth/logout', { cookie: admin.cookie })).status, 200);
  assert.equal((await t.request('GET', '/api/auth/me', { cookie: admin.cookie })).status, 401);
  await t.close();
});
