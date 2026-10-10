// "Clear data": per app and for every app. Own records only, password required, PIN kept, other people untouched.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, closeAll } from './helpers.js';
after(closeAll);

const PW = 'a-decent-password', PIN = '482915';
async function setup() {
  const t = await startTestApp({});
  const admin = await t.login('admin@example.com', 'correct-horse-battery');
  for (const id of ['inventory', 'finance']) assert.equal((await t.request('POST', `/api/apps/${id}/install`, { cookie: admin.cookie })).status, 200);
  const users = t.app.services.storage.collection('users');
  const mk = async (email) => {
    await t.request('POST', '/api/users', { cookie: admin.cookie, body: { email, displayName: email, password: PW, roleId: 'resident' } });
    const u = (await users.find({ where: { email } }))[0]; await users.update(u.id, { grants: ['finance.access', 'finance.export', 'finance.ai'] });
    const login = await t.login(email, PW);
    const su = await t.request('POST', '/api/apps/finance/pin/setup', { cookie: login.cookie, body: { pin: PIN, confirm: PIN } });
    const jar = `${login.cookie}; ${su.headers.get('set-cookie').split(';')[0]}`;
    return { login, jar, fin: (m, p, body) => t.request(m, `/api/apps/finance${p}`, { cookie: jar, body }), inv: (m, p, body) => t.request(m, `/api/apps/inventory${p}`, { cookie: login.cookie, body }) };
  };
  const fill = async (u) => {
    assert.equal((await u.fin('POST', '/accounts', { name: 'Cash', openingBalance: '5000' })).status, 201);
    assert.equal((await u.inv('POST', '/items', { identity: { name: 'Lamp' } })).status, 201);
  };
  return { t, admin, mk, fill };
}
const counts = async (u) => ({ accounts: (await u.fin('GET', '/accounts')).json.accounts.length, items: (await u.inv('GET', '/items')).json.items.length });

test('clear one app: needs the right password, clears only that app, only for that person', async () => {
  const { t, mk, fill } = await setup();
  const a = await mk('a@example.com'), b = await mk('b@example.com'); await fill(a); await fill(b);
  assert.equal((await t.request('POST', '/api/apps/inventory/clear-data', { cookie: a.login.cookie, body: {} })).status, 400);
  assert.equal((await t.request('POST', '/api/apps/inventory/clear-data', { cookie: a.login.cookie, body: { password: 'wrong-password-123' } })).status, 401);
  assert.equal((await t.request('POST', '/api/apps/inventory/clear-data', { cookie: undefined, body: { password: PW } })).status, 401);
  assert.equal((await t.request('POST', '/api/apps/nope/clear-data', { cookie: a.login.cookie, body: { password: PW } })).status, 404);
  const ok = await t.request('POST', '/api/apps/inventory/clear-data', { cookie: a.login.cookie, body: { password: PW } }); assert.equal(ok.status, 200, ok.text);
  assert.equal((await counts(a)).items, 0); assert.equal((await counts(a)).accounts, 1); // Orbit untouched
  assert.equal((await counts(b)).items, 1); assert.equal((await counts(b)).accounts, 1); // someone else untouched
  await t.close();
});

test('clear all apps: everything of mine goes, my Finance PIN stays, a fresh start works, it is audited', async () => {
  const { t, admin, mk, fill } = await setup();
  const a = await mk('a@example.com'), b = await mk('b@example.com'); await fill(a); await fill(b);
  const ok = await t.request('POST', '/api/apps/clear-all-data', { cookie: a.login.cookie, body: { password: PW } }); assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(await counts(a), { accounts: 0, items: 0 });
  assert.equal((await a.fin('GET', '/session')).json.hasPin, true); // PIN kept
  assert.equal((await a.fin('POST', '/accounts', { name: 'New', openingBalance: '1' })).status, 201); // starts fresh
  assert.deepEqual(await counts(b), { accounts: 1, items: 1 });
  const audit = (await t.request('GET', '/api/audit?action=app.clear_data', { cookie: admin.cookie })).json.entries; assert.equal(audit.length, 1);
  await t.close();
});
