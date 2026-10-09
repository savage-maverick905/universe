import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestApp, closeAll } from './helpers.js';
import { encrypt, decrypt } from '../ai/crypto.js';
import { GroqProvider, ProviderError } from '../ai/providers/groq.js';
import { validateArgs } from '../ai/tools.js';
after(closeAll);

const SECRET = 'ab'.repeat(32);
const text = (content) => ({ content, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
const toolCall = (name, args, id = 'c1') => ({ content: '', toolCalls: [{ id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }], usage: null });
function fake(script) { const calls = []; return { id: 'fake', calls, async chat(req) { calls.push(structuredClone(req)); return script(req, calls.length); } }; }

async function setup(script = () => text('hello'), config = {}) {
  const provider = fake(script);
  const t = await startTestApp(config, { providers: { fake: provider } });
  const admin = await t.login('admin@example.com', 'correct-horse-battery');
  const mk = async (email, roleId = 'resident') => {
    const r = await t.request('POST', '/api/users', { cookie: admin.cookie, body: { email, displayName: email, password: 'a-decent-password', roleId } });
    return { ...r.json.user, ...(await t.login(email, 'a-decent-password')) };
  };
  await t.request('POST', '/api/apps/inventory/install', { cookie: admin.cookie });
  const a = await mk('a@example.com'), b = await mk('b@example.com'), g = await mk('g@example.com', 'guest');
  const chat = (u, message, conversationId) => t.request('POST', '/api/ai/chat', { cookie: u.cookie, body: { message, ...(conversationId ? { conversationId } : {}) } });
  const item = (u, name) => t.request('POST', '/api/apps/inventory/items', { cookie: u.cookie, body: { identity: { name } } });
  return { t, provider, admin, a, b, g, chat, item };
}

test('crypto: round trip, tamper and wrong secret fail, bad secret rejected', () => {
  const blob = encrypt('sk-secret-value', SECRET);
  assert.ok(!blob.includes('sk-secret-value'));
  assert.equal(decrypt(blob, SECRET), 'sk-secret-value');
  assert.throws(() => decrypt(blob.slice(0, -4) + 'AAAA', SECRET));
  assert.throws(() => decrypt(blob, 'cd'.repeat(32)));
  assert.throws(() => encrypt('x', 'short'));
});

test('argument validation rejects unknown, missing and out-of-range arguments', () => {
  const schema = { properties: { q: { type: 'string', maxLength: 5 }, n: { type: 'integer', minimum: 1, maximum: 3 }, s: { type: 'string', enum: ['a'] } }, required: ['q'] };
  assert.equal(validateArgs(schema, { q: 'ok', n: 2, s: 'a' }), null);
  for (const bad of [{}, { q: 'toolong' }, { q: 'x', n: 9 }, { q: 'x', s: 'z' }, { q: 'x', userId: 'u' }, null, []]) assert.ok(validateArgs(schema, bad), JSON.stringify(bad));
});

test('profile: name and personality reach the system prompt; keys never returned or stored in plaintext', async () => {
  const { t, a, provider, chat } = await setup();
  assert.equal((await t.request('GET', '/api/ai/profile', { cookie: a.cookie })).json.profile.name, 'Nebula');
  assert.equal((await t.request('PUT', '/api/ai/profile', { cookie: a.cookie, body: { roleId: 'admin' } })).status, 400);
  assert.equal((await t.request('PUT', '/api/ai/profile', { cookie: a.cookie, body: { style: 'rude' } })).status, 400);
  await t.request('PUT', '/api/ai/profile', { cookie: a.cookie, body: { name: 'Nova', instructions: 'Speak like a pirate', style: 'concise' } });
  assert.equal((await chat(a, 'hi')).status, 200);
  const sys = provider.calls[0].messages[0].content;
  assert.match(sys, /You are Nova/); assert.match(sys, /Speak like a pirate/); assert.match(sys, /short and direct/);
  const k = await t.request('PUT', '/api/ai/key', { cookie: a.cookie, body: { apiKey: 'sk-user-secret-9999', provider: 'fake' } });
  assert.equal(k.json.profile.hasKey, true); assert.equal(k.json.profile.keyLast4, '9999');
  assert.ok(!k.text.includes('sk-user-secret-9999'));
  assert.ok(!(await t.request('GET', '/api/ai/profile', { cookie: a.cookie })).text.includes('sk-user-secret'));
  const stored = await t.app.services.storage.collection('ai_profiles').get(a.id);
  assert.ok(!JSON.stringify(stored).includes('sk-user-secret-9999'));
  const audit = (await t.request('GET', '/api/audit?action=ai.key_set', { cookie: (await t.login('admin@example.com', 'correct-horse-battery')).cookie })).text;
  assert.ok(audit.includes('ai.key_set') && !audit.includes('sk-user-secret'));
  await t.close();
});

test('key strategies: shared key vs own key; never mixed; own mode needs a key', async () => {
  const { t, a, provider, chat } = await setup();
  await chat(a, 'one');
  assert.equal(provider.calls.at(-1).apiKey, 'SHARED-KEY-123');
  assert.equal((await t.request('PUT', '/api/ai/profile', { cookie: a.cookie, body: { keyMode: 'own' } })).status, 200);
  assert.equal((await chat(a, 'two')).status, 400); // own mode but no key yet
  await t.request('PUT', '/api/ai/key', { cookie: a.cookie, body: { apiKey: 'sk-user-secret-9999', provider: 'fake' } });
  assert.equal((await chat(a, 'three')).status, 200);
  assert.equal(provider.calls.at(-1).apiKey, 'sk-user-secret-9999');
  await t.request('DELETE', '/api/ai/key', { cookie: a.cookie });
  const p = (await t.request('GET', '/api/ai/profile', { cookie: a.cookie })).json.profile;
  assert.equal(p.hasKey, false); assert.equal(p.keyMode, 'shared');
  await t.close();
});

test('personal keys are refused when the server has no encryption secret', async () => {
  const { t, a } = await setup(undefined, { ai: { defaultProvider: 'fake', defaultModel: 'm', sharedKeys: { fake: 'K' }, keyEncryptionSecret: '', groqBaseUrl: '' } });
  assert.equal((await t.request('PUT', '/api/ai/key', { cookie: a.cookie, body: { apiKey: 'sk-user-secret-9999', provider: 'fake' } })).status, 503);
  await t.close();
});

test('conversations: stored per user, continue, rename, delete; others get 404, guests 403', async () => {
  const { t, a, b, g, provider, chat } = await setup();
  const first = (await chat(a, 'What is in my house?')).json;
  assert.equal(first.conversation.title, 'What is in my house?');
  const id = first.conversation.id;
  await chat(a, 'And the garage?', id);
  assert.equal(provider.calls.at(-1).messages.filter((m) => m.role === 'user').length, 2); // history carried over
  const full = (await t.request('GET', `/api/ai/conversations/${id}`, { cookie: a.cookie })).json;
  assert.deepEqual(full.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.ok(!full.messages.some((m) => m.role === 'system'));
  assert.equal(full.messages[1].model, 'fake-model');
  assert.equal((await t.request('PATCH', `/api/ai/conversations/${id}`, { cookie: a.cookie, body: { title: 'Renamed' } })).json.conversation.title, 'Renamed');
  for (const [m, body] of [['GET'], ['PATCH', { title: 'x' }], ['DELETE']]) assert.equal((await t.request(m, `/api/ai/conversations/${id}`, { cookie: b.cookie, body })).status, 404, m);
  assert.equal((await chat(b, 'sneaky', id)).status, 404);
  assert.equal((await t.request('GET', '/api/ai/conversations', { cookie: b.cookie })).json.conversations.length, 0);
  assert.equal((await t.request('GET', '/api/ai/conversations', { cookie: g.cookie })).status, 403);
  assert.equal((await chat(g, 'hi')).status, 403);
  assert.equal((await t.request('DELETE', `/api/ai/conversations/${id}`, { cookie: a.cookie })).status, 200);
  assert.equal((await t.request('GET', `/api/ai/conversations/${id}`, { cookie: a.cookie })).status, 404);
  assert.equal(await t.app.services.storage.collection('ai_messages').count({ conversationId: id }), 0);
  await t.close();
});

test('only a bounded window of history is sent to the model', async () => {
  const { a, provider, chat } = await setup(undefined, { rateLimits: { ai: { windowMs: 60000, max: 1000 }, loginIp: { windowMs: 60000, max: 1000 }, global: { windowMs: 60000, max: 100000 } } });
  let id;
  for (let i = 0; i < 25; i++) id = (await chat(a, `message ${i}`, id)).json.conversation.id;
  const last = provider.calls.at(-1).messages;
  assert.ok(last.length <= 22, `sent ${last.length} messages`); // system + 20 history + new
  assert.equal(last.at(-1).content, 'message 24');
});

test('shared key has a daily cap; own key is not capped; admin controls defaults', async () => {
  const { t, admin, a, provider, chat } = await setup();
  assert.equal((await t.request('PUT', '/api/ai/admin/config', { cookie: a.cookie, body: { sharedDailyLimit: 1 } })).status, 403);
  const cfg = await t.request('PUT', '/api/ai/admin/config', { cookie: admin.cookie, body: { sharedDailyLimit: 2, defaultModel: 'model-2' } });
  assert.equal(cfg.json.config.defaultModel, 'model-2');
  assert.equal((await chat(a, '1')).status, 200); assert.equal((await chat(a, '2')).status, 200);
  assert.equal(provider.calls.at(-1).model, 'model-2');
  const over = await chat(a, '3'); assert.equal(over.status, 429); assert.match(over.json.error.message, /own API key/);
  await t.request('PUT', '/api/ai/key', { cookie: a.cookie, body: { apiKey: 'sk-user-secret-9999', provider: 'fake' } });
  await t.request('PUT', '/api/ai/profile', { cookie: a.cookie, body: { keyMode: 'own' } });
  assert.equal((await chat(a, '4')).status, 200);
  const g = await t.request('GET', '/api/ai/admin/config', { cookie: admin.cookie });
  assert.deepEqual(g.json.sharedKeyConfigured, { groq: false, fake: true });
  assert.ok(!g.text.includes('SHARED-KEY-123'));
  await t.request('PUT', '/api/ai/admin/config', { cookie: admin.cookie, body: { sharedKeyEnabled: false } });
  await t.request('PUT', '/api/ai/profile', { cookie: a.cookie, body: { keyMode: 'shared' } });
  assert.equal((await chat(a, '5')).status, 403);
  assert.equal((await t.request('PUT', '/api/ai/admin/config', { cookie: admin.cookie, body: { defaultProvider: 'nope' } })).status, 400);
  await t.close();
});

test('provider errors become safe messages with no key leakage', async () => {
  const { a, chat } = await setup(() => { throw new ProviderError('auth', 401); });
  const r = await chat(a, 'hi');
  assert.equal(r.status, 502); assert.match(r.json.error.message, /shared key/);
  assert.ok(!r.text.includes('SHARED-KEY-123'));
});

test('tools: run with the callers identity only; model cannot pick another user or call unlisted tools', async () => {
  let step = 0;
  const { t, a, b, provider, chat, item } = await setup((req, n) => {
    step = n;
    if (n === 1) return toolCall('inventory.search', { query: 'phone' });
    return text('done');
  });
  await item(a, 'Phone A'); await item(b, 'Secret Phone B');
  assert.equal((await chat(a, 'find my phone')).json.toolsUsed[0], 'inventory.search');
  const toolMsg = provider.calls[1].messages.find((m) => m.role === 'tool').content;
  assert.match(toolMsg, /Phone A/); assert.ok(!toolMsg.includes('Secret Phone B'));
  assert.ok(provider.calls[0].tools.some((x) => x.name === 'inventory.getItem'));
  // stored transcript shows the tool use
  const convo = (await t.request('GET', '/api/ai/conversations', { cookie: a.cookie })).json.conversations[0];
  const roles = (await t.request('GET', `/api/ai/conversations/${convo.id}`, { cookie: a.cookie })).json.messages.map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant', 'tool', 'assistant']);
  await t.close();
});

test('tools: hostile model output is contained', async () => {
  const attempts = [
    ['inventory.search', { query: 'x', userId: 'user_other' }, /unknown argument/],
    ['inventory.search', '{not json', /not valid JSON/],
    ['inventory.getItem', { id: 'item_does_not_exist' }, /not found/],
    ['db.query', { sql: 'SELECT * FROM users' }, /not available/],
    ['users.findProfiles', { query: 'x'.repeat(500) }, /Invalid arguments/],
  ];
  for (const [name, args, expect] of attempts) {
    const { provider, a, chat, t } = await setup((req, n) => (n === 1 ? toolCall(name, args) : text('ok')));
    await chat(a, 'go');
    const content = provider.calls[1].messages.find((m) => m.role === 'tool').content;
    assert.match(content, expect, name);
    assert.ok(!/passwordHash|scrypt/.test(content));
    await t.close();
  }
});

test('tools: availability follows permissions and app state', async () => {
  const { t, admin, a, g, provider, chat } = await setup();
  const names = () => provider.calls.at(-1).tools.map((x) => x.name);
  await chat(a, 'hi'); assert.ok(names().includes('inventory.search') && names().includes('users.findProfiles'));
  await t.request('PATCH', `/api/users/${g.id}`, { cookie: admin.cookie, body: { grants: ['ai.use'] } });
  const g2 = await t.login('g@example.com', 'a-decent-password');
  await chat(g2, 'hi'); assert.deepEqual(names().sort(), ['reports.generate', 'users.findProfiles']); // guest has no inventory permissions
  await t.request('POST', '/api/apps/inventory/disable', { cookie: admin.cookie });
  await chat(a, 'hi'); assert.deepEqual(names().sort(), ['reports.generate', 'users.findProfiles']);
  await t.close();
});

test('AI cannot be used to bypass profile visibility', async () => {
  const { t, a, b, provider, chat } = await setup((req, n) => (n === 1 ? toolCall('users.findProfiles', { query: 'b@example' }) : text('ok')));
  const result = async () => { provider.calls.length = 0; await chat(a, 'what about B?'); return JSON.parse(provider.calls[1].messages.find((m) => m.role === 'tool').content); };
  await t.request('PATCH', '/api/me', { cookie: b.cookie, body: { bio: 'B works on a secret project' } });
  let r = await result();
  assert.equal(r.profiles[0].id, b.id); assert.equal(r.profiles[0].bio, undefined); // bio is private by default
  await t.request('PUT', '/api/me/visibility', { cookie: b.cookie, body: { bio: { level: 'shared', sharedWith: [a.id] } } });
  assert.equal((await result()).profiles[0].bio, 'B works on a secret project');
  await t.request('PUT', '/api/me/visibility', { cookie: b.cookie, body: { bio: { level: 'private' }, displayName: { level: 'private' } } });
  r = await result();
  assert.deepEqual(r.profiles, []); // B can no longer even be found
  await t.close();
});

test('GroqProvider: wire format, tool-name mapping, usage, error kinds (against a local mock server)', async () => {
  let seen, status = 200;
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
      res.statusCode = status; res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(status === 200 ? { choices: [{ message: { content: null, tool_calls: [{ id: 'x1', function: { name: 'inventory__search', arguments: '{"query":"a"}' } }] } }], usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } } : { error: { message: 'KEY-ECHO' } }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const p = new GroqProvider({ baseUrl: `http://127.0.0.1:${srv.address().port}` });
  const req = { apiKey: 'K1', model: 'm', tools: [{ name: 'inventory.search', description: 'd', parameters: { type: 'object', properties: {} } }],
    messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }, { role: 'assistant', content: '', toolCalls: [{ id: 'x0', name: 'inventory.search', arguments: '{}' }] }, { role: 'tool', toolCallId: 'x0', content: '{}' }] };
  const out = await p.chat(req);
  assert.equal(seen.url, '/chat/completions'); assert.equal(seen.auth, 'Bearer K1');
  assert.equal(seen.body.tools[0].function.name, 'inventory__search'); assert.equal(seen.body.model, 'm');
  assert.equal(seen.body.messages[2].tool_calls[0].function.name, 'inventory__search'); assert.equal(seen.body.messages[3].tool_call_id, 'x0');
  assert.deepEqual(out.toolCalls, [{ id: 'x1', name: 'inventory.search', arguments: '{"query":"a"}' }]);
  assert.equal(out.usage.totalTokens, 11);
  for (const [code, kind] of [[401, 'auth'], [429, 'rate_limit'], [500, 'unavailable'], [404, 'bad_request']]) {
    status = code;
    const e = await p.chat(req).catch((x) => x);
    assert.ok(e instanceof ProviderError && e.kind === kind, `${code}`);
    assert.ok(!e.message.includes('KEY-ECHO'));
  }
  srv.close();
});

test('chat is rate limited per user', async () => {
  const { a, b, chat, t } = await setup();
  let last;
  for (let i = 0; i < 21; i++) last = await chat(a, `m${i}`);
  assert.equal(last.status, 429); assert.ok(last.headers.get('retry-after'));
  assert.equal((await chat(b, 'still fine')).status, 200); // other users unaffected
  await t.close();
});
