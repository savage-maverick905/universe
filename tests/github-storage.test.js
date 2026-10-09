import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../database/storage.js';
import { startTestApp, closeAll } from './helpers.js';

// A tiny in-process stand-in for the parts of the GitHub REST API the driver uses.
function fakeGithub({ repo = 'me/data', defaultBranch = 'main', big = false } = {}) {
  const branches = new Map([[defaultBranch, new Map()]]); // branch -> path -> { text, sha }
  const state = { puts: 0, gets: 0, failNext: [], seenAuth: new Set(), n: 0 };
  const res = (status, body, text) => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => text ?? JSON.stringify(body) });
  async function fetch(url, init = {}) {
    const u = new URL(url); const method = init.method || 'GET'; const p = decodeURIComponent(u.pathname);
    state.seenAuth.add(init.headers.Authorization);
    const body = init.body ? JSON.parse(init.body) : null;
    const pre = `/repos/${repo}`;
    if (!p.startsWith(pre)) return res(404, { message: 'Not Found' });
    const rest = p.slice(pre.length);
    if (method === 'GET' && rest === '') return res(200, { default_branch: defaultBranch });
    if (method === 'GET' && rest.startsWith('/branches/')) return branches.has(rest.slice(10)) ? res(200, {}) : res(404, { message: 'Branch not found' });
    if (method === 'GET' && rest.startsWith('/git/ref/heads/')) return branches.has(rest.slice(15)) ? res(200, { object: { sha: 'base' } }) : res(404, {});
    if (method === 'POST' && rest === '/git/refs') {
      const name = body.ref.replace('refs/heads/', '');
      if (branches.has(name)) return res(422, { message: 'Reference already exists' });
      branches.set(name, new Map(branches.get(defaultBranch))); return res(201, {});
    }
    if (rest.startsWith('/contents/')) {
      const file = rest.slice(10); const files = branches.get(u.searchParams.get('ref') || body?.branch || defaultBranch);
      if (!files) return res(404, { message: 'No such branch' });
      if (method === 'GET') {
        state.gets++; const f = files.get(file);
        if (!f) return res(404, { message: 'Not Found' });
        if (init.headers.Accept.includes('raw')) return res(200, null, f.text);
        return res(200, big ? { sha: f.sha, encoding: 'none', content: '' } : { sha: f.sha, encoding: 'base64', content: Buffer.from(f.text).toString('base64') });
      }
      if (method === 'PUT') {
        state.puts++;
        const fail = state.failNext.shift(); if (fail) return res(fail, { message: 'injected failure' });
        const f = files.get(file);
        if (f && !body.sha) return res(422, { message: 'sha was not supplied' });
        if (f && f.sha !== body.sha) return res(409, { message: 'does not match' });
        const sha = `sha${++state.n}`; files.set(file, { text: Buffer.from(body.content, 'base64').toString('utf8'), sha });
        return res(200, { content: { sha } });
      }
    }
    return res(404, { message: 'Not Found' });
  }
  return { fetch, state, branches, file: (b = 'universe-data', p = 'universe-data.json') => branches.get(b)?.get(p) };
}
const open = (gh, extra = {}) => createStorage({ driver: 'github', github: { token: 'ghp_SECRET', repo: 'me/data', flushMs: 5, retryMs: 1, fetch: gh.fetch, log: { warn() {}, error() {} }, ...extra } });

test('creates the data branch, saves on close, and a new instance reads it back', async () => {
  const gh = fakeGithub(); const a = await open(gh);
  await a.collection('things').insert({ id: 'x', n: 1 });
  await a.collection('things').insert({ id: 'y', n: 2 });
  await a.close();
  assert.ok(gh.branches.has('universe-data'));
  assert.equal(JSON.parse(gh.file().text).collections.things.length, 2);
  assert.equal(gh.file().text.split('\n').length > 3, true); // one document per line
  const b = await open(gh);
  assert.equal((await b.collection('things').get('y')).n, 2);
  await b.close();
});

test('batches many writes into one commit, and commits nothing when nothing changed', async () => {
  const gh = fakeGithub(); const a = await open(gh, { flushMs: 20 });
  const c = a.collection('things');
  for (let i = 0; i < 8; i++) await c.insert({ id: `i${i}` });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(gh.state.puts, 1);
  await a.close(); assert.equal(gh.state.puts, 1);
  const b = await open(gh); await b.close(); assert.equal(gh.state.puts, 1); // opened and closed, no changes
});

test('a failed transaction rolls everything back and is not saved', async () => {
  const gh = fakeGithub(); const a = await open(gh); const c = a.collection('t');
  await c.insert({ id: 'keep', n: 1 });
  await assert.rejects(a.transaction(async () => { await c.update('keep', { n: 99 }); await c.insert({ id: 'gone' }); throw new Error('boom'); }), /boom/);
  assert.equal((await c.get('keep')).n, 1); assert.equal(await c.get('gone'), null);
  await a.close();
  assert.equal(JSON.parse(gh.file().text).collections.t.length, 1);
});

test('recovers when the file changed on GitHub (409) and retries server errors', async () => {
  const gh = fakeGithub(); const a = await open(gh); const c = a.collection('t');
  await c.insert({ id: 'one' }); await a.flush();
  gh.file().sha = 'changed-elsewhere'; // someone edited the file on github.com
  await c.insert({ id: 'two' }); await a.flush();
  assert.equal(JSON.parse(gh.file().text).collections.t.length, 2);
  gh.state.failNext.push(500, 502);
  await c.insert({ id: 'three' }); await a.flush();
  assert.equal(JSON.parse(gh.file().text).collections.t.length, 3);
  await a.close();
});

test('when saving keeps failing the data stays dirty and close() reports it, without leaking the token', async () => {
  const gh = fakeGithub(); const a = await open(gh, { flushMs: 100000 });
  await a.collection('t').insert({ id: 'one' });
  gh.state.failNext.push(500, 500, 500, 500);
  await assert.rejects(a.close(), (e) => { assert.doesNotMatch(e.message, /ghp_SECRET/); return /500/.test(e.message); });
  assert.equal(gh.file(), undefined);
});

test('ephemeral collections stay in memory and are never committed', async () => {
  const gh = fakeGithub(); const a = await open(gh, { ephemeral: ['sessions'] });
  await a.collection('sessions').insert({ id: 's1' }); await a.collection('keepme').insert({ id: 'k1' });
  await a.close();
  const saved = JSON.parse(gh.file().text).collections;
  assert.deepEqual(Object.keys(saved), ['keepme']);
});

test('loads files over 1 MB (GitHub does not inline them) and refuses to overwrite a corrupt file', async () => {
  const gh = fakeGithub(); const a = await open(gh); await a.collection('t').insert({ id: 'one' }); await a.close();
  const big = fakeGithub({ big: true }); big.branches.set('universe-data', new Map([['universe-data.json', gh.file()]]));
  const b = await open(big); assert.ok(await b.collection('t').get('one')); await b.close();
  const bad = fakeGithub(); bad.branches.set('universe-data', new Map([['universe-data.json', { text: '{oops', sha: 's' }]]));
  await assert.rejects(open(bad), /not valid JSON/);
});

test('config is validated', async () => {
  await assert.rejects(createStorage({ driver: 'github', github: { repo: 'a/b' } }), /GITHUB_TOKEN/);
  await assert.rejects(createStorage({ driver: 'github', github: { token: 't', repo: 'nope' } }), /owner\/name/);
  await assert.rejects(createStorage({ driver: 'github', github: { token: 't', repo: 'a/b', path: '../x' } }), /relative/);
});

test('behaves like the SQLite driver for filters, ordering, paging, updates and export', async () => {
  const gh = fakeGithub(); const g = await open(gh); const s = await createStorage({ driver: 'sqlite', sqlitePath: ':memory:' });
  const docs = [
    { id: 'a', n: 3, name: 'Zed', ok: true, status: { state: 'in_use' }, d: '2026-01-02' }, { id: 'b', n: 1, name: 'amy', ok: false, status: { state: 'lost' }, d: '2026-01-01' },
    { id: 'c', n: 2, name: 'Bob', ok: true, status: { state: 'in_use' } }, { id: 'd', name: 'cat', ok: false, d: '2026-03-01' }, { id: 'e', n: 5, name: 'dan', ok: true, tags: ['x'] },
  ];
  const queries = [
    {}, { where: { ok: true } }, { where: { n: { $gte: 2 } } }, { where: { n: { $gt: 1, $lt: 5 } } }, { where: { 'status.state': 'in_use' } },
    { where: { id: { $in: ['a', 'e', 'zz'] } } }, { where: { id: { $in: [] } } }, { where: { d: null } }, { where: { d: { $lt: '2026-02-01' } } },
    { orderBy: { field: 'n', dir: 'asc' } }, { orderBy: { field: 'n', dir: 'desc' } }, { orderBy: { field: 'name' } }, { orderBy: { field: 'd', dir: 'desc' }, limit: 2, offset: 1 },
    { where: { ok: true }, orderBy: { field: 'status.state' }, limit: 2 },
  ];
  for (const st of [g, s]) { const c = st.collection('q'); for (const d of docs) await c.insert(d); }
  for (const q of queries) {
    const [x, y] = await Promise.all([g.collection('q').find(q), s.collection('q').find(q)]);
    assert.deepEqual(x.map((d) => d.id), y.map((d) => d.id), JSON.stringify(q));
  }
  for (const w of [{}, { ok: false }, { n: { $lte: 2 } }]) assert.equal(await g.collection('q').count(w), await s.collection('q').count(w));
  for (const st of [g, s]) { await st.collection('q').update('a', { n: 10, extra: { z: 1 } }); await st.collection('q').deleteWhere({ ok: false }); }
  const strip = (r) => r.map(({ updatedAt, createdAt, ...d }) => d);
  assert.deepEqual(strip(await g.collection('q').find({ orderBy: { field: 'id' } })), strip(await s.collection('q').find({ orderBy: { field: 'id' } })));
  for (const bad of [{ where: { 'x; drop': 1 } }, { where: { n: { $bogus: 1 } } }, { orderBy: { field: 'id; x' } }, { where: { n: [1] } }])
    await assert.rejects(g.collection('q').find(bad));
  await assert.rejects(g.collection('q').insert({ id: 'a' }), { code: 'DUPLICATE_ID' });
  assert.equal(await g.collection('q').get("x' OR '1'='1"), null);
  assert.throws(() => g.collection('Bad Name'));
  const ex = await g.exportAll(); await s.importAll(ex, { mode: 'replace' }); assert.equal(await s.collection('q').count(), ex.collections.q.length);
  await g.close(); s.close();
});

test('the whole app runs on the github driver and users survive a restart', async () => {
  const gh = fakeGithub();
  const storage = { driver: 'github', github: { token: 't', repo: 'me/data', flushMs: 5, retryMs: 1, fetch: gh.fetch, ephemeral: [] } };
  const t1 = await startTestApp({ storage });
  const l1 = await t1.login('admin@example.com', 'correct-horse-battery');
  assert.equal(l1.status, 200);
  const item = await t1.request('POST', '/api/apps/inventory/install', { cookie: l1.cookie });
  assert.equal(item.status, 200);
  await t1.close();
  const t2 = await startTestApp({ storage, bootstrap: { email: '', password: '' } });
  assert.equal((await t2.request('GET', '/api/auth/me', { cookie: l1.cookie })).status, 200); // even the session survived
  assert.equal((await t2.login('admin@example.com', 'correct-horse-battery')).status, 200);
  await t2.close();
  await closeAll();
});
