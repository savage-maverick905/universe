import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, closeAll } from './helpers.js';
import { resolveRange } from '../core/reports.js';
after(closeAll);

const B = '/api/apps/inventory';
const NOW = new Date('2026-03-15T12:00:00Z');

test('period resolution: daily, weekly, monthly, yearly, last N days, custom, and bad input', () => {
  assert.deepEqual(resolveRange({ period: 'daily' }, NOW), { from: '2026-03-15', to: '2026-03-15', label: 'Today' });
  assert.equal(resolveRange({ period: 'weekly' }, NOW).from, '2026-03-09');
  assert.equal(resolveRange({ period: 'monthly' }, NOW).from, '2026-02-14');
  assert.equal(resolveRange({ period: 'yearly' }, NOW).from, '2025-03-16');
  assert.deepEqual(resolveRange({ period: 'last_days', days: 17 }, NOW), { from: '2026-02-27', to: '2026-03-15', label: 'Last 17 days' });
  assert.equal(resolveRange({ period: 'custom', from: '2026-01-01', to: '2026-01-31' }, NOW).label, '2026-01-01 to 2026-01-31');
  for (const bad of [{ period: 'hourly' }, {}, { period: 'last_days' }, { period: 'last_days', days: 0 }, { period: 'last_days', days: 99999 }, { period: 'last_days', days: 2.5 },
    { period: 'custom', from: '2026-02-01', to: '2026-01-01' }, { period: 'custom', from: '2026-02-30', to: '2026-03-01' }, { period: 'custom', from: 'x', to: 'y' }, { period: 'custom', from: '1900-01-01', to: '2026-01-01' }])
    assert.throws(() => resolveRange(bad, NOW), /./, JSON.stringify(bad));
});

async function setup(script, extra = {}) {
  const provider = { id: 'fake', calls: [], async chat(req) { this.calls.push(structuredClone(req)); return script ? script(req, this.calls.length) : { content: 'ok', toolCalls: [], usage: null }; } };
  const t = await startTestApp({}, { providers: { fake: provider }, ...extra });
  const admin = await t.login('admin@example.com', 'correct-horse-battery');
  const mk = async (email, roleId = 'resident') => { await t.request('POST', '/api/users', { cookie: admin.cookie, body: { email, displayName: email, password: 'a-decent-password', roleId } }); return t.login(email, 'a-decent-password'); };
  await t.request('POST', '/api/apps/inventory/install', { cookie: admin.cookie });
  const a = await mk('a@example.com'), b = await mk('b@example.com'), g = await mk('g@example.com', 'guest');
  const run = (u, body) => t.request('POST', '/api/reports/run', { cookie: u.cookie, body });
  const add = async (u, item) => (await t.request('POST', `${B}/items`, { cookie: u.cookie, body: item })).json.item;
  return { t, admin, a, b, g, run, add, provider };
}
const section = (r, name) => r.json.sections.find((s) => s.heading.startsWith(name));
const stat = (sec, label) => sec.stats.find((x) => x.label === label).value;

test('inventory report: overview, activity in period, attention, by category', async () => {
  const { t, a, run, add } = await setup();
  const cats = (await t.request('GET', `${B}/categories`, { cookie: a.cookie })).json.categories;
  const electronics = cats.find((c) => c.name === 'Electronics').id;
  const phone = await add(a, { identity: { name: 'Phone', categoryId: electronics }, acquisition: { price: 100, currency: 'NGN' } });
  await add(a, { identity: { name: 'Chair' }, status: { state: 'damaged', reason: 'Broken leg' } });
  await t.request('PATCH', `${B}/items/${phone.id}`, { cookie: a.cookie, body: { status: { state: 'lost', reason: 'Bus' } } });
  const r = await run(a, { period: 'weekly' });
  assert.equal(r.status, 200); assert.equal(r.json.title, 'Inventory overview');
  const ov = section(r, 'Current overview');
  assert.equal(stat(ov, 'Total items'), 2); assert.equal(stat(ov, 'Lost'), 1); assert.equal(stat(ov, 'Needs attention'), 2); assert.equal(stat(ov, 'Estimated value'), 'NGN 100');
  const act = section(r, 'Activity');
  assert.equal(stat(act, 'Items added'), 2); assert.equal(stat(act, 'Status changes'), 1);
  assert.deepEqual(act.table.rows[0].slice(1, 3), ['Phone', 'status changed']);
  assert.deepEqual(section(r, 'Needs attention').table.rows.map((x) => x[0]).sort(), ['Chair', 'Phone']);
  assert.deepEqual(section(r, 'By category').table.rows, [['Electronics', 1], ['No category', 1]]);
  // "a report on my electronics"
  const e = await run(a, { period: 'yearly', filters: { category: 'electronics' } });
  assert.equal(stat(section(e, 'Current overview'), 'Total items'), 1);
  const none = await run(a, { period: 'daily', filters: { category: 'Spaceships' } });
  assert.match(section(none, 'Filter').text, /no category named/);
  // a window in the past excludes today's activity
  const past = await run(a, { period: 'custom', from: '2020-01-01', to: '2020-01-31' });
  assert.equal(stat(section(past, 'Activity'), 'Items added'), 0);
  assert.equal(stat(section(past, 'Current overview'), 'Total items'), 2); // overview is "as of now"
  await t.close();
});

test('report window uses item dates: old items fall outside a recent range', async () => {
  const { t, a, run, add } = await setup();
  const old = await add(a, { identity: { name: 'Old thing' } });
  const col = t.app.services.storage.collection('inventory_items');
  await col.upsert({ ...(await col.get(old.id)), createdAt: '2025-01-10T00:00:00.000Z', history: [{ date: '2025-01-10', event: 'created', reason: '' }, { date: '2025-01-12', event: 'note', reason: 'x' }] });
  await add(a, { identity: { name: 'New thing' } });
  const r = await run(a, { period: 'last_days', days: 17 });
  assert.equal(stat(section(r, 'Activity'), 'Items added'), 1); assert.equal(r.json.range.label, 'Last 17 days');
  const jan = await run(a, { period: 'custom', from: '2025-01-01', to: '2025-01-31' });
  assert.equal(stat(section(jan, 'Activity'), 'Items added'), 1); assert.equal(stat(section(jan, 'Activity'), 'Notes'), 1);
  await t.close();
});

test('reports are private, permission-gated and app-state-aware', async () => {
  const { t, admin, a, b, g, run, add } = await setup();
  await add(a, { identity: { name: 'Secret of A' } });
  const rb = await run(b, { period: 'yearly' });
  assert.equal(stat(section(rb, 'Current overview'), 'Total items'), 0);
  assert.ok(!JSON.stringify(rb.json).includes('Secret of A'));
  assert.deepEqual((await t.request('GET', '/api/reports/available', { cookie: g.cookie })).json.reports, []); // guest: nothing
  assert.equal((await run(g, { period: 'daily', report: 'inventory.inventory-overview' })).status, 404);
  assert.equal((await run(g, { period: 'daily' })).json.sections[0].heading, 'Nothing to report');
  assert.equal((await run(a, { period: 'daily', report: 'nope.nope' })).status, 404);
  assert.equal((await t.request('GET', '/api/reports/available', { cookie: a.cookie })).json.reports[0].key, 'inventory.inventory-overview');
  await t.request('POST', '/api/apps/inventory/disable', { cookie: admin.cookie });
  assert.deepEqual((await t.request('GET', '/api/reports/available', { cookie: a.cookie })).json.reports, []);
  assert.equal((await run(a, { period: 'daily', report: 'inventory.inventory-overview' })).status, 404);
  // validation
  assert.equal((await run(a, { period: 'custom', from: '2026-02-01', to: '2026-01-01' })).status, 400);
  assert.equal((await run(a, { period: 'daily', filters: { owner: 'x' } })).status, 400);
  assert.equal((await run(a, { period: 'daily', userId: 'user_x' })).status, 400);
  assert.equal((await t.request('POST', '/api/reports/run', { body: { period: 'daily' } })).status, 401);
  await t.close();
});

test('ecosystem-wide scope and one-app scope', async () => {
  const { t, a, run } = await setup();
  const all = await run(a, { period: 'daily' });
  assert.equal(all.json.title, 'Inventory overview'); // only one report exists, so it is shown as itself
  const app = await run(a, { period: 'daily', app: 'inventory' });
  assert.equal(app.status, 200);
  assert.equal((await run(a, { period: 'daily', app: 'finance' })).status, 404);
  await t.close();
});

test('saved reports: owner only, capped, deletable', async () => {
  const { t, a, b, run } = await setup();
  const r = await run(a, { period: 'weekly', save: true });
  assert.ok(r.json.savedId);
  const list = (await t.request('GET', '/api/reports/saved', { cookie: a.cookie })).json.reports;
  assert.equal(list.length, 1); assert.equal(list[0].range.label, 'Last 7 days');
  assert.equal((await t.request('GET', `/api/reports/saved/${r.json.savedId}`, { cookie: a.cookie })).status, 200);
  assert.equal((await t.request('GET', `/api/reports/saved/${r.json.savedId}`, { cookie: b.cookie })).status, 404);
  assert.equal((await t.request('DELETE', `/api/reports/saved/${r.json.savedId}`, { cookie: b.cookie })).status, 404);
  for (let i = 0; i < 52; i++) await run(a, { period: 'daily', save: true });
  assert.equal((await t.request('GET', '/api/reports/saved', { cookie: a.cookie })).json.reports.length, 50);
  assert.equal((await t.request('DELETE', `/api/reports/saved/${r.json.savedId}`, { cookie: a.cookie })).status, 404); // oldest was dropped
  await t.close();
});

test('AI: "report for the last 17 days" goes through reports.generate with the callers permissions', async () => {
  const script = (req, n) => (n === 1 ? { content: '', toolCalls: [{ id: 'c1', name: 'reports.generate', arguments: JSON.stringify({ period: 'last_days', days: 17, app: 'inventory' }) }], usage: null } : { content: 'Here is your report', toolCalls: [], usage: null });
  const { t, a, b, provider, add } = await setup(script);
  await add(a, { identity: { name: 'Phone of A' } }); await add(b, { identity: { name: 'Phone of B' } });
  const chat = (u) => t.request('POST', '/api/ai/chat', { cookie: u.cookie, body: { message: 'Give me a report for the last 17 days' } });
  assert.equal((await chat(a)).json.toolsUsed[0], 'reports.generate');
  const out = JSON.parse(provider.calls[1].messages.find((m) => m.role === 'tool').content);
  assert.equal(out.range.label, 'Last 17 days');
  assert.equal(stat(out.sections.find((s) => s.heading === 'Current overview'), 'Total items'), 1); // A's items only
  provider.calls.length = 0;
  await chat(b);
  const outB = provider.calls[1].messages.find((m) => m.role === 'tool').content;
  assert.ok(!outB.includes('Phone of A'));
  await t.close();
});
