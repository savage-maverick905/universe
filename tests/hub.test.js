// Orbit inside Universe: Nebula (hub) reads and drafts behind the Finance PIN; saving needs the PIN typed again; reports and widget too.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, closeAll } from './helpers.js';
after(() => closeAll());
const B = '/api/apps/finance', PIN = '482915', call = (name, args) => ({ content: '', toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) }], usage: null });

async function setup() {
  const script = [], fake = { id: 'fake', calls: [], async chat(req) { this.calls.push(structuredClone(req)); return script.shift() || { content: 'ok', toolCalls: [], usage: null }; } };
  const t = await startTestApp({}, { providers: { fake } });
  const admin = await t.login('admin@example.com', 'correct-horse-battery');
  assert.equal((await t.request('POST', `${B}/install`, { cookie: admin.cookie })).status, 200);
  const su = await t.request('POST', `${B}/pin/setup`, { cookie: admin.cookie, body: { pin: PIN, confirm: PIN } }); assert.equal(su.status, 201);
  const orbit = `${admin.cookie}; ${su.headers.get('set-cookie').split(';')[0]}`;
  assert.equal((await t.request('POST', `${B}/accounts`, { cookie: orbit, body: { name: 'Moniepoint', openingBalance: '1,234' } })).status, 201);
  const chat = (cookie, message, conversationId) => t.request('POST', '/api/ai/chat', { cookie, body: { message, conversationId } });
  const unlockHub = async (pin = PIN) => { const r = await t.request('POST', `${B}/hub/unlock`, { cookie: admin.cookie, body: { pin } }); return { r, jar: r.status === 200 ? `${admin.cookie}; ${r.headers.get('set-cookie').split(';')[0]}` : null }; };
  return { t, admin, orbit, fake, script, chat, unlockHub };
}

test('Nebula needs the PIN before it can see money, and never asks for it in the chat', async () => {
  const { admin, fake, script, chat } = await setup();
  script.push(call('finance.query', { metric: 'balance' }));
  const r = await chat(admin.cookie, 'what is my balance?'); assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.gates, [{ app: 'finance', code: 'locked' }]); assert.match(r.json.reply.content, /Finance PIN/);
  assert.ok(!/1,234/.test(JSON.stringify(fake.calls)), 'no figures reached the model while locked'); assert.equal(fake.calls.length, 1, 'the app answered; the model was not called again');
  assert.ok(fake.calls[0].messages[0].content.includes('NEVER ask the user to type their PIN into the chat'));
});

test('hub unlock: wrong PIN refused; then Nebula reads real figures; hub and Orbit unlocks are separate', async () => {
  const { t, admin, orbit, fake, script, chat, unlockHub } = await setup();
  assert.equal((await unlockHub('111222')).r.status, 401);
  const { jar } = await unlockHub(); assert.ok(jar);
  script.push(call('finance.query', { metric: 'balance' }), { content: 'You have it.', toolCalls: [], usage: null });
  const r = await chat(jar, 'what is my balance?'); assert.equal(r.status, 200, r.text); assert.equal(r.json.gates.length, 0);
  const toolMsg = fake.calls[1].messages.find((m) => m.role === 'tool'); assert.match(toolMsg.content, /₦1,234\.00/);
  assert.equal((await t.request('GET', `${B}/accounts`, { cookie: jar })).status, 423, 'the hub unlock does not open Orbit itself');
  assert.equal((await chat(orbit, 'hi')).json.gates.length, 0); script.push(call('finance.query', { metric: 'balance' }));
  assert.equal((await chat(orbit, 'balance?')).json.gates.length, 1, 'the Orbit unlock does not open Nebula');
  assert.equal((await t.request('GET', `${B}/hub/status`, { cookie: jar })).json.unlocked, true);
  await t.request('POST', `${B}/lock`, { cookie: orbit }); // locking Orbit locks Universe too
  assert.equal((await t.request('GET', `${B}/hub/status`, { cookie: jar })).json.unlocked, false);
});

test('Nebula prepares a draft; saving needs the PIN typed again; one draft saves once', async () => {
  const { t, admin, chat, script, unlockHub, orbit } = await setup();
  const { jar } = await unlockHub();
  script.push(call('finance.propose', { type: 'income', amount: '250,000', account: 'Moniepoint', category: 'Salary', direction: 'increase' }));
  const r = await chat(jar, 'salary of 250k came into Moniepoint'); assert.equal(r.status, 200, r.text);
  assert.ok(r.json.toolsUsed.includes('finance.propose')); assert.match(r.json.reply.content, /confirm it with your Finance PIN/);
  const id = r.json.conversation.id, d = await t.request('GET', `${B}/hub/draft/${id}`, { cookie: jar }); assert.equal(d.json.draft.ready, true, d.text);
  assert.equal((await t.request('GET', `${B}/transactions`, { cookie: orbit })).json.total, 0, 'nothing saved by the AI');
  const url = `${B}/hub/draft/${id}/confirm`, v = d.json.draft.version;
  assert.equal((await t.request('POST', url, { cookie: jar, body: { version: v } })).status, 401, 'no PIN, no save');
  assert.equal((await t.request('POST', url, { cookie: jar, body: { pin: '111222', version: v } })).status, 401);
  const ok = await t.request('POST', url, { cookie: jar, body: { pin: PIN, version: v } }); assert.equal(ok.status, 200, ok.text); assert.equal(ok.json.saved, true);
  assert.equal((await t.request('GET', `${B}/transactions`, { cookie: orbit })).json.total, 1);
  assert.equal((await t.request('POST', url, { cookie: jar, body: { pin: PIN, version: v } })).status, 409, 'cannot save the same draft twice');
  // another person cannot read or confirm it
  await t.request('POST', '/api/users', { cookie: admin.cookie, body: { email: 'x@example.com', displayName: 'x', password: 'a-decent-password', roleId: 'resident' } });
  const users = t.app.services.storage.collection('users'), u = (await users.find({ where: { email: 'x@example.com' } }))[0]; await users.update(u.id, { grants: ['finance.access', 'finance.ai'] });
  const x = await t.login('x@example.com', 'a-decent-password');
  assert.equal((await t.request('GET', `${B}/hub/draft/${id}`, { cookie: x.cookie })).status, 423);
});

test('Orbit shows up in the Universe home stats and reports, behind the PIN', async () => {
  const { t, admin, unlockHub } = await setup();
  const w = await t.request('GET', `${B}/widget/summary`, { cookie: admin.cookie }); assert.equal(w.json.gate, 'finance');
  const run = (cookie) => t.request('POST', '/api/reports/run', { cookie, body: { report: 'all', period: 'monthly' } });
  assert.ok((await t.request('GET', '/api/reports/available', { cookie: admin.cookie })).json.reports.some((r) => r.key === 'finance.finance-overview'));
  const locked = await run(admin.cookie); assert.ok(locked.json.sections.some((s) => s.gate === 'finance')); assert.ok(!/1,234/.test(locked.text));
  const { jar } = await unlockHub();
  const w2 = await t.request('GET', `${B}/widget/summary`, { cookie: jar }); assert.equal(w2.json.stats[0].value, '₦1,234.00');
  const rep = await run(jar); assert.equal(rep.status, 200, rep.text); assert.match(rep.text, /Total balance now/); assert.match(rep.text, /1,234/);
  const saved = await t.request('POST', '/api/reports/run', { cookie: jar, body: { report: 'finance.finance-overview', period: 'monthly', save: true } });
  const doc = await t.request('GET', `/api/reports/saved/${saved.json.savedId}`, { cookie: jar }); assert.ok(!/1,234/.test(doc.text), 'PIN-protected figures are never stored in saved reports');
});
