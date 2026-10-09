import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startTestApp, closeAll } from './helpers.js';

const ADMIN = ['admin@example.com', 'correct-horse-battery'];
const signup = (t, body) => t.request('POST', '/api/auth/register', { body });

test('anyone can create an account: signed in at once, resident role, no shared-AI access by default', async () => {
  const t = await startTestApp();
  assert.equal((await t.request('GET', '/api/auth/config')).json.signupEnabled, true); // readable before signing in
  const r = await signup(t, { email: 'New@Example.com', displayName: 'Newbie', password: 'a-decent-password' });
  assert.equal(r.status, 201);
  assert.equal(r.json.user.email, 'new@example.com');
  assert.equal(r.json.user.roleId, 'resident');
  assert.equal(r.json.isAdmin, false);
  assert.ok(!r.json.permissions.includes('ai.use')); // the admin's shared key is not handed out
  const cookie = r.headers.get('set-cookie').split(';')[0];
  assert.equal((await t.request('GET', '/api/auth/me', { cookie })).status, 200);
  assert.equal((await t.login('new@example.com', 'a-decent-password')).status, 200);
  await t.close();
});

test('sign-up validates input and refuses duplicates', async () => {
  const t = await startTestApp();
  assert.equal((await signup(t, { email: 'a@example.com', password: 'short' })).status, 400);
  assert.equal((await signup(t, { email: 'not-an-email', password: 'a-decent-password' })).status, 400);
  assert.equal((await signup(t, { email: 'a@example.com', password: 'a-decent-password', roleId: 'admin' })).status, 400); // unknown fields rejected
  assert.equal((await signup(t, { email: 'a@example.com', password: 'a-decent-password' })).status, 201);
  assert.equal((await signup(t, { email: 'A@example.com', password: 'a-decent-password' })).status, 409);
  assert.equal((await signup(t, { email: ADMIN[0], password: 'a-decent-password' })).status, 409);
  await t.close();
});

test('sign-up is rate limited per IP', async () => {
  const t = await startTestApp({ rateLimits: { signup: { windowMs: 60000, max: 2 } } });
  assert.equal((await signup(t, { email: 'a@example.com', password: 'a-decent-password' })).status, 201);
  assert.equal((await signup(t, { email: 'b@example.com', password: 'a-decent-password' })).status, 201);
  assert.equal((await signup(t, { email: 'c@example.com', password: 'a-decent-password' })).status, 429);
  await t.close();
});

test('an admin can close sign-ups, change the role, and allow the AI; nobody else can', async () => {
  const t = await startTestApp();
  const admin = await t.login(...ADMIN);
  const u = await signup(t, { email: 'u@example.com', password: 'a-decent-password' });
  const userCookie = u.headers.get('set-cookie').split(';')[0];
  assert.equal((await t.request('GET', '/api/admin/signup', { cookie: userCookie })).status, 403);
  assert.equal((await t.request('PUT', '/api/admin/signup', { cookie: userCookie, body: { signupEnabled: true } })).status, 403);
  assert.equal((await t.request('PUT', '/api/admin/signup', { cookie: admin.cookie, body: { signupRoleId: 'admin' } })).status, 400); // never an admin role
  assert.equal((await t.request('PUT', '/api/admin/signup', { cookie: admin.cookie, body: { signupEnabled: 'yes' } })).status, 400);
  const put = await t.request('PUT', '/api/admin/signup', { cookie: admin.cookie, body: { signupEnabled: false } });
  assert.equal(put.json.settings.signupEnabled, false);
  assert.equal((await t.request('GET', '/api/auth/config')).json.signupEnabled, false);
  assert.equal((await signup(t, { email: 'x@example.com', password: 'a-decent-password' })).status, 403);
  await t.request('PUT', '/api/admin/signup', { cookie: admin.cookie, body: { signupEnabled: true, signupAllowAi: true, signupRoleId: 'guest' } });
  const g = await signup(t, { email: 'g@example.com', password: 'a-decent-password' });
  assert.equal(g.json.user.roleId, 'guest');
  assert.deepEqual(g.json.user.denies, []);
  await t.close();
});

test('SIGNUP_ENABLED=false in the environment starts with sign-ups closed', async () => {
  const t = await startTestApp({ signup: { enabled: false, roleId: 'resident', allowAi: false } });
  assert.equal((await signup(t, { email: 'a@example.com', password: 'a-decent-password' })).status, 403);
  await t.close();
});

test('an admin can reset someone\'s password; that signs them out and the old password stops working', async () => {
  const t = await startTestApp();
  const admin = await t.login(...ADMIN);
  const u = await signup(t, { email: 'u@example.com', password: 'a-decent-password' });
  const cookie = u.headers.get('set-cookie').split(';')[0];
  const id = u.json.user.id;
  assert.equal((await t.request('POST', `/api/users/${id}/password`, { cookie, body: { newPassword: 'whatever-long-enough' } })).status, 403); // not an admin
  assert.equal((await t.request('POST', `/api/users/${id}/password`, { cookie: admin.cookie, body: { newPassword: 'short' } })).status, 400);
  const adminId = (await t.request('GET', '/api/auth/me', { cookie: admin.cookie })).json.user.id;
  assert.equal((await t.request('POST', `/api/users/${adminId}/password`, { cookie: admin.cookie, body: { newPassword: 'whatever-long-enough' } })).status, 400); // own password: use Settings
  assert.equal((await t.request('POST', `/api/users/${id}/password`, { cookie: admin.cookie, body: { newPassword: 'brand-new-password' } })).status, 200);
  assert.equal((await t.request('GET', '/api/auth/me', { cookie })).status, 401);
  assert.equal((await t.login('u@example.com', 'a-decent-password')).status, 401);
  assert.equal((await t.login('u@example.com', 'brand-new-password')).status, 200);
  const audit = (await t.request('GET', '/api/audit?action=user.password_reset', { cookie: admin.cookie })).json.entries;
  assert.equal(audit.length, 1);
  await t.close();
});

test('people can change their own password and name', async () => {
  const t = await startTestApp();
  const u = await signup(t, { email: 'u@example.com', password: 'a-decent-password' });
  const cookie = u.headers.get('set-cookie').split(';')[0];
  assert.equal((await t.request('POST', '/api/auth/change-password', { cookie, body: { currentPassword: 'wrong-password-here', newPassword: 'another-long-password' } })).status, 401);
  assert.equal((await t.request('POST', '/api/auth/change-password', { cookie, body: { currentPassword: 'a-decent-password', newPassword: 'another-long-password' } })).status, 200);
  assert.equal((await t.login('u@example.com', 'another-long-password')).status, 200);
  assert.equal((await t.request('PATCH', '/api/me', { cookie, body: { displayName: 'Renamed' } })).json.user.displayName, 'Renamed');
  await t.close();
});

test('both apps are installable: manifests, icons and service workers are served with the right types', async () => {
  const t = await startTestApp();
  const admin = await t.login(...ADMIN);
  await t.request('POST', '/api/apps/inventory/install', { cookie: admin.cookie });
  const get = async (p) => { const r = await t.request('GET', p); return r; };
  for (const [base, scope] of [['/dashboard', '/dashboard/'], ['/apps/inventory', '/apps/inventory/']]) {
    const m = await get(`${base}/app.webmanifest`);
    assert.equal(m.status, 200); assert.match(m.headers.get('content-type'), /manifest\+json/);
    assert.equal(m.json.scope, scope); assert.equal(m.json.start_url, scope); assert.equal(m.json.display, 'standalone');
    assert.ok(m.json.icons.some((i) => i.sizes === '192x192' && i.purpose === 'any'));
    assert.ok(m.json.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
    for (const i of m.json.icons) { const r = await t.request('GET', `${base}/${i.src}`); assert.equal(r.status, 200, i.src); }
    const sw = await get(`${base}/sw.js`); assert.equal(sw.status, 200); assert.match(sw.headers.get('content-type'), /javascript/);
    assert.equal((await get(`${base}/icons/apple-touch-icon.png`)).status, 200);
  }
  // the two scopes never overlap, so each installs as its own app
  assert.ok(!'/apps/inventory/'.startsWith('/dashboard/') && !'/dashboard/'.startsWith('/apps/inventory/'));
  assert.equal((await get('/shared/sw-core.js')).status, 200);
  assert.equal((await get('/shared/pwa.js')).status, 200);
  await t.close();
});

test('every file a service worker precaches really exists (a 404 would break offline start)', async () => {
  for (const [file, dir] of [['dashboard/sw.js', ''], ['apps/inventory/sw.js', '']]) {
    const src = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    const urls = [...src.matchAll(/'(\/[^']+)'/g)].map((m) => m[1]).filter((u) => !u.endsWith('sw-core.js'));
    assert.ok(urls.length > 5);
    for (const u0 of urls) { const u = u0.endsWith('/') ? `${u0}index.html` : u0; await readFile(new URL(`..${u}`, import.meta.url)).catch(() => assert.fail(`${file} lists ${u} but it does not exist`)); }
  }
});
