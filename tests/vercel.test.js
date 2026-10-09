import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createStorage } from '../database/storage.js';

// Minimal stand-in for the GitHub contents API, with ETags (so "unchanged" answers 304) and sha checks (so conflicts answer 409).
function fakeGithub(repo = 'me/data') {
  const files = new Map(); const branches = new Set(['main']);
  const state = { puts: 0, full: 0, notModified: 0, n: 0 };
  const headers = (h) => ({ get: (k) => h[k.toLowerCase()] ?? null });
  const res = (status, body, h = {}) => ({ status, ok: status >= 200 && status < 300, headers: headers(h), json: async () => body, text: async () => JSON.stringify(body) });
  async function fetch(url, init = {}) {
    const u = new URL(url); const method = init.method || 'GET'; const p = decodeURIComponent(u.pathname); const body = init.body ? JSON.parse(init.body) : null;
    const pre = `/repos/${repo}`; if (!p.startsWith(pre)) return res(404, {});
    const rest = p.slice(pre.length);
    if (method === 'GET' && rest === '') return res(200, { default_branch: 'main' });
    if (method === 'GET' && rest.startsWith('/branches/')) return branches.has(rest.slice(10)) ? res(200, {}) : res(404, {});
    if (method === 'GET' && rest.startsWith('/git/ref/heads/')) return res(200, { object: { sha: 'base' } });
    if (method === 'POST' && rest === '/git/refs') { branches.add(body.ref.replace('refs/heads/', '')); return res(201, {}); }
    if (rest.startsWith('/contents/')) {
      const f = files.get(rest.slice(10));
      if (method === 'GET') {
        if (!branches.has(u.searchParams.get('ref'))) return res(404, {});
        if (!f) return res(404, {});
        if (init.headers['If-None-Match'] === `"${f.sha}"`) { state.notModified++; return res(304, null); }
        state.full++;
        return res(200, { sha: f.sha, encoding: 'base64', content: Buffer.from(f.text).toString('base64') }, { etag: `"${f.sha}"` });
      }
      if (method === 'PUT') {
        state.puts++;
        if (f && !body.sha) return res(422, { message: 'sha was not supplied' });
        if (f && f.sha !== body.sha) return res(409, { message: 'does not match' });
        const sha = `sha${++state.n}`; files.set(rest.slice(10), { text: Buffer.from(body.content, 'base64').toString('utf8'), sha });
        return res(200, { content: { sha } });
      }
    }
    return res(404, {});
  }
  return { fetch, state, text: () => files.get('universe-data.json')?.text };
}
const opts = (gh, extra = {}) => ({ driver: 'github', github: { token: 'ghp_X', repo: 'me/data', serverless: true, retryMs: 1, fetch: gh.fetch, log: { warn() {}, error() {} }, ...extra } });

test('serverless storage: saves only when flushed, and other instances pick the change up', async () => {
  const gh = fakeGithub();
  const a = await createStorage(opts(gh)), b = await createStorage(opts(gh));
  await a.collection('things').insert({ id: 'x', n: 1 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(gh.state.puts, 0, 'no timer-based saving in serverless mode');
  await a.flush();
  assert.equal(gh.state.puts, 1);
  assert.equal(await b.collection('things').get('x'), null); // b has not looked yet
  assert.equal(await b.refresh(), true);
  assert.equal((await b.collection('things').get('x')).n, 1);
  assert.equal(await b.refresh(), false); // unchanged: answered 304, nothing reloaded
  assert.ok(gh.state.notModified >= 1);
});

test('serverless storage: a conflicting save is refused, never overwrites, and the next refresh recovers', async () => {
  const gh = fakeGithub();
  const a = await createStorage(opts(gh)); await a.collection('t').insert({ id: 'one', v: 'a' }); await a.flush();
  const b = await createStorage(opts(gh));
  await a.collection('t').insert({ id: 'two', v: 'from-a' }); await a.flush();           // a saves first
  await b.collection('t').insert({ id: 'three', v: 'from-b' });                         // b still has the old version
  await assert.rejects(() => b.flush(), (e) => e.conflict === true && e.status === 409);
  assert.match(gh.text(), /from-a/); assert.doesNotMatch(gh.text(), /from-b/);           // a's data survived
  await b.refresh();
  assert.equal(await b.collection('t').count(), 2);                                      // b reloaded a's data
  assert.equal(await b.collection('t').get('three'), null);                              // and its own refused write is gone
});

test('the Vercel function: signs in, saves before answering, and a cold start still knows you', async () => {
  const gh = fakeGithub(); const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => (String(url).startsWith('https://api.github.com') ? gh.fetch(url, init) : realFetch(url, init));
  Object.assign(process.env, { GITHUB_TOKEN: 'ghp_X', GITHUB_REPO: 'me/data', BOOTSTRAP_ADMIN_EMAIL: 'me@example.com', BOOTSTRAP_ADMIN_PASSWORD: 'correct-horse-battery', KEY_ENCRYPTION_SECRET: 'ab'.repeat(32), VERCEL: '1' });
  const serve = async (mod) => { const s = http.createServer((q, r) => mod.default(q, r)); await new Promise((r) => s.listen(0, '127.0.0.1', r)); return s; };
  const call = (s, method, path, { body, cookie } = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const q = http.request({ port: s.address().port, host: '127.0.0.1', method, path, headers: { 'X-Requested-With': 'universe', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, (r) => {
      let t = ''; r.on('data', (c) => (t += c)); r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, json: t ? JSON.parse(t) : null }));
    });
    q.on('error', reject); if (data) q.write(data); q.end();
  });
  const warm = await serve(await import('../api/index.js?warm'));
  try {
    const login = await call(warm, 'POST', '/api/auth/login', { body: { email: 'me@example.com', password: 'correct-horse-battery' } });
    assert.equal(login.status, 200);
    assert.ok(gh.state.puts >= 1, 'the data was committed before the response arrived');
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    assert.equal((await call(warm, 'GET', '/api/auth/me', { cookie })).status, 200);

    const cold = await serve(await import('../api/index.js?cold')); // a brand-new instance: empty memory, same GitHub
    try {
      const me = await call(cold, 'GET', '/api/auth/me', { cookie });
      assert.equal(me.status, 200); assert.equal(me.json.user.email, 'me@example.com');
      assert.equal((await call(cold, 'GET', '/api/auth/me')).status, 401);
    } finally { cold.closeAllConnections?.(); await new Promise((r) => cold.close(r)); }
  } finally { warm.closeAllConnections?.(); await new Promise((r) => warm.close(r)); globalThis.fetch = realFetch; }
});
