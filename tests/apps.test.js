import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { startTestApp, closeAll } from './helpers.js';
import { validateManifest } from '../core/registry.js';
after(closeAll);

const ADMIN = ['admin@example.com', 'correct-horse-battery'];
async function setup() {
  const t = await startTestApp();
  const admin = await t.login(...ADMIN);
  const mk = async (email, roleId) => {
    await t.request('POST', '/api/users', { cookie: admin.cookie, body: { email, displayName: 'u', password: 'a-decent-password', roleId } });
    return t.login(email, 'a-decent-password');
  };
  return { t, admin, mk };
}
const rawGet = (t, path) => new Promise((res) => http.get({ host: '127.0.0.1', port: t.app.server.address().port, path }, (r) => { r.resume(); res(r.statusCode); }));

test('manifest validation enforces namespacing', () => {
  const good = { manifestVersion: 1, id: 'tasks', name: 'T', version: '1.0.0', description: 'd', entry: 'index.html' };
  assert.deepEqual(validateManifest(good, 'tasks'), []);
  assert.ok(validateManifest({ ...good, id: 'other' }, 'tasks').length);
  assert.ok(validateManifest({ ...good, permissions: ['users.manage'] }, 'tasks').length);
  assert.ok(validateManifest({ ...good, dataResources: ['inventory_items'] }, 'tasks').length);
  assert.ok(validateManifest({ ...good, widgets: [{ id: 'w', type: 'stat', dataEndpoint: '/api/users' }] }, 'tasks').length);
  assert.ok(validateManifest({ ...good, entry: '../x' }, 'tasks').length);
});

test('install lifecycle: available -> installed -> disabled -> uninstalled, source kept', async () => {
  const { t, admin, mk } = await setup();
  const res = await mk('res@example.com', 'resident');
  let apps = (await t.request('GET', '/api/apps', { cookie: res.cookie })).json.apps;
  const inv = () => apps.find((a) => a.id === 'inventory');
  assert.equal(inv().status, 'available'); assert.equal(inv().openUrl, null);
  assert.equal((await t.request('POST', '/api/apps/inventory/install', { cookie: res.cookie })).status, 403);
  assert.equal(await rawGet(t, '/apps/inventory/'), 404); // not installed, not served
  assert.equal((await t.request('POST', '/api/apps/inventory/install', { cookie: admin.cookie })).status, 200);
  assert.equal((await t.request('POST', '/api/apps/inventory/install', { cookie: admin.cookie })).status, 409);
  assert.equal((await t.request('POST', '/api/apps/nope/install', { cookie: admin.cookie })).status, 404);
  apps = (await t.request('GET', '/api/apps', { cookie: res.cookie })).json.apps;
  assert.equal(inv().status, 'enabled'); assert.equal(inv().openUrl, '/apps/inventory/');
  assert.equal(await rawGet(t, '/apps/inventory/'), 200);
  await t.request('POST', '/api/apps/inventory/disable', { cookie: admin.cookie });
  assert.equal(await rawGet(t, '/apps/inventory/'), 404);
  assert.equal((await t.request('GET', '/api/apps', { cookie: res.cookie })).json.apps.find((a) => a.id === 'inventory').status, 'disabled');
  await t.request('POST', '/api/apps/inventory/enable', { cookie: admin.cookie });
  await t.request('POST', '/api/apps/inventory/uninstall', { cookie: admin.cookie });
  assert.equal((await t.request('GET', '/api/apps', { cookie: res.cookie })).json.apps.find((a) => a.id === 'inventory').status, 'available');
  assert.ok(existsSync(new URL('../apps/inventory/manifest.json', import.meta.url)));
  assert.equal((await t.request('POST', '/api/apps/inventory/enable', { cookie: admin.cookie })).status, 409);
  await t.close();
});

test('install grants default permissions; widgets are per-user and per-app-state', async () => {
  const { t, admin, mk } = await setup();
  const res = await mk('r@example.com', 'resident'); const guest = await mk('g@example.com', 'guest');
  const widgets = async (u) => (await t.request('GET', '/api/dashboard/widgets', { cookie: u.cookie })).json.widgets;
  assert.deepEqual(await widgets(res), []);
  await t.request('POST', '/api/apps/inventory/install', { cookie: admin.cookie });
  const r2 = await t.login('r@example.com', 'a-decent-password');
  assert.ok((await t.request('GET', '/api/auth/me', { cookie: r2.cookie })).json.permissions.includes('inventory.item.read'));
  assert.equal((await widgets(r2)).length, 4);
  assert.deepEqual(await widgets(guest), []); // guests get nothing by default
  await t.request('POST', '/api/apps/inventory/disable', { cookie: admin.cookie });
  assert.deepEqual(await widgets(r2), []);
  const audit = (await t.request('GET', '/api/audit?action=app.install', { cookie: admin.cookie })).json.entries;
  assert.equal(audit.length, 1);
  await t.close();
});

test('static: dashboard served, traversal and server-side files blocked', async () => {
  const { t } = await setup();
  assert.equal(await rawGet(t, '/'), 200);
  assert.equal(await rawGet(t, '/shared/theme.css'), 200);
  assert.equal(await rawGet(t, '/shared/%2e%2e/config/env.js'), 404);
  assert.equal(await rawGet(t, '/dashboard/%2e%2e/.env'), 404);
  assert.equal(await rawGet(t, '/dashboard/../http/server.js'), 404);
  assert.equal(await rawGet(t, '/apps/%2e%2e/package.json'), 404);
  await t.close();
});

test('dashboard modules are served', async () => {
  const { t } = await setup();
  for (const f of ['/dashboard/app.js', '/dashboard/assistant.js', '/dashboard/reports.js', '/dashboard/styles.css']) assert.equal(await rawGet(t, f), 200, f);
  await t.close();
});
