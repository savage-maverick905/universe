// Runs the documented example app (docs/examples/tasks) through the REAL registry, installer, loader,
// widgets, AI tools and reports, plus checks that a broken app cannot take other apps down.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { startTestApp, closeAll } from './helpers.js';
after(() => { closeAll(); rmSync(TMP, { recursive: true, force: true }); });

// Must sit inside the repo so the example's relative imports (../../../shared/...) resolve like in apps/<id>/server.
const TMP = new URL('../.tmp-example-apps/', import.meta.url).pathname;
const B = '/api/apps/tasks';

async function setup(withBroken = false) {
  rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true });
  cpSync(new URL('../docs/examples/tasks', import.meta.url).pathname, `${TMP}/tasks`, { recursive: true });
  if (withBroken) {
    mkdirSync(`${TMP}/crashy/server`, { recursive: true }); mkdirSync(`${TMP}/wrongid`, { recursive: true });
    const base = { manifestVersion: 1, version: '1.0.0', description: 'd', entry: 'index.html' };
    writeFileSync(`${TMP}/crashy/manifest.json`, JSON.stringify({ ...base, id: 'crashy', name: 'Crashy' }));
    writeFileSync(`${TMP}/crashy/server/index.js`, "export function register() { throw new Error('boom on load'); }");
    writeFileSync(`${TMP}/wrongid/manifest.json`, JSON.stringify({ ...base, id: 'something_else', name: 'Wrong' }));
  }
  const logs = [];
  const t = await startTestApp({}, { appsDir: TMP.replace(/\/$/, ''), providers: { fake: { id: 'fake', calls: [], async chat(req) { this.calls.push(structuredClone(req)); return this.script(req, this.calls.length); }, script: () => ({ content: 'ok', toolCalls: [], usage: null }) } } });
  const fakeP = t.app.services.ai.providers.get('fake');
  const admin = await t.login('admin@example.com', 'correct-horse-battery');
  const mk = async (email, roleId = 'resident') => { await t.request('POST', '/api/users', { cookie: admin.cookie, body: { email, displayName: email, password: 'a-decent-password', roleId } }); return email; };
  await mk('a@example.com'); await mk('b@example.com'); await mk('g@example.com', 'guest');
  return { t, admin, fakeP, logs, login: (e) => t.login(e, 'a-decent-password') };
}

test('example app: discovered, installable, private, with widget, AI tool and report', async () => {
  const { t, admin, fakeP, login } = await setup();
  assert.deepEqual((await t.request('GET', '/api/apps', { cookie: admin.cookie })).json.apps.map((a) => [a.id, a.status]), [['tasks', 'available']]);
  const a0 = await login('a@example.com');
  assert.equal((await t.request('GET', `${B}/items`, { cookie: a0.cookie })).status, 404); // not installed yet
  assert.equal((await t.request('POST', '/api/apps/tasks/install', { cookie: admin.cookie })).status, 200);
  const a = await login('a@example.com'), b = await login('b@example.com'), g = await login('g@example.com');
  const made = await t.request('POST', `${B}/items`, { cookie: a.cookie, body: { title: 'Buy milk' } });
  assert.equal(made.status, 201);
  assert.equal((await t.request('POST', `${B}/items`, { cookie: a.cookie, body: { title: 'x', ownerId: 'user_b' } })).status, 400);
  assert.equal((await t.request('PATCH', `${B}/items/${made.json.item.id}`, { cookie: b.cookie, body: { done: true } })).status, 404); // isolation
  assert.equal((await t.request('GET', `${B}/items`, { cookie: g.cookie })).status, 403);                                       // guest has no grant
  assert.equal((await t.request('PATCH', `${B}/items/${made.json.item.id}`, { cookie: a.cookie, body: { done: true } })).json.item.done, true);
  // widget
  const w = (await t.request('GET', '/api/dashboard/widgets', { cookie: a.cookie })).json.widgets;
  assert.equal(w[0].appId, 'tasks');
  assert.deepEqual((await t.request('GET', w[0].dataEndpoint, { cookie: a.cookie })).json.stats, [{ label: 'Open', value: 0 }, { label: 'Done', value: 1 }]);
  assert.deepEqual((await t.request('GET', '/api/dashboard/widgets', { cookie: g.cookie })).json.widgets, []);
  // AI tool
  fakeP.script = (req, n) => (n === 1 ? { content: '', toolCalls: [{ id: 'c', name: 'tasks.list', arguments: '{"openOnly":false}' }], usage: null } : { content: 'ok', toolCalls: [], usage: null });
  await t.request('POST', '/api/ai/chat', { cookie: a.cookie, body: { message: 'what are my tasks?' } });
  assert.match(fakeP.calls[1].messages.find((m) => m.role === 'tool').content, /Buy milk/);
  fakeP.calls.length = 0;
  await t.request('POST', '/api/ai/chat', { cookie: b.cookie, body: { message: 'what are my tasks?' } });
  assert.ok(!fakeP.calls[1].messages.find((m) => m.role === 'tool').content.includes('Buy milk'));
  // report
  const rep = await t.request('POST', '/api/reports/run', { cookie: a.cookie, body: { period: 'daily', report: 'tasks.tasks-overview' } });
  assert.equal(rep.json.sections[1].stats[0].value, 1);
  // static files while active; server code never
  const get = async (p) => (await fetch(`http://127.0.0.1:${t.app.server.address().port}${p}`)).status;
  assert.equal(await get('/apps/tasks/'), 200); assert.equal(await get('/apps/tasks/app.js'), 200); assert.equal(await get('/apps/tasks/server/index.js'), 404);
  // disable: everything goes quiet; data survives uninstall and reinstall
  await t.request('POST', '/api/apps/tasks/disable', { cookie: admin.cookie });
  assert.equal((await t.request('GET', `${B}/items`, { cookie: a.cookie })).status, 404);
  assert.deepEqual((await t.request('GET', '/api/dashboard/widgets', { cookie: a.cookie })).json.widgets, []);
  assert.equal(await get('/apps/tasks/'), 404);
  await t.request('POST', '/api/apps/tasks/uninstall', { cookie: admin.cookie });
  assert.equal(await t.app.services.storage.collection('tasks_items').count(), 1); // uninstall never deletes data
  await t.request('POST', '/api/apps/tasks/install', { cookie: admin.cookie });
  assert.equal((await t.request('GET', `${B}/items`, { cookie: a.cookie })).json.items[0].title, 'Buy milk');
  await t.close();
});

test('a broken or misnamed app is skipped or contained and does not affect other apps', async () => {
  const { t, admin, login } = await setup(true);
  const apps = (await t.request('GET', '/api/apps', { cookie: admin.cookie })).json.apps.map((a) => a.id).sort();
  assert.deepEqual(apps, ['crashy', 'tasks']); // "wrongid" was rejected by manifest validation
  await t.request('POST', '/api/apps/tasks/install', { cookie: admin.cookie });
  const a = await login('a@example.com');
  assert.equal((await t.request('POST', `${B}/items`, { cookie: a.cookie, body: { title: 'still works' } })).status, 201);
  await t.close();
});
