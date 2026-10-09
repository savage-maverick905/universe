import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../database/storage.js';

const mk = () => createStorage({ driver: 'sqlite', sqlitePath: ':memory:' });

test('CRUD, filters, ordering, counts', async () => {
  const st = await mk(); const c = st.collection('things', { indexes: ['status.state'] });
  await c.insert({ id: 'a', n: 1, status: { state: 'in_use' }, ok: true });
  await c.insert({ id: 'b', n: 2, status: { state: 'lost' }, ok: false });
  await c.insert({ id: 'c', n: 3, status: { state: 'in_use' }, ok: true });
  assert.equal((await c.get('b')).n, 2);
  assert.equal(await c.count({ 'status.state': 'in_use' }), 2);
  assert.equal(await c.count({ ok: true }), 2);
  assert.deepEqual((await c.find({ where: { n: { $gte: 2 } }, orderBy: { field: 'n', dir: 'desc' } })).map((d) => d.id), ['c', 'b']);
  assert.equal((await c.find({ where: { id: { $in: ['a', 'c'] } } })).length, 2);
  assert.equal((await c.find({ where: { id: { $in: [] } } })).length, 0);
  const u = await c.update('a', { n: 10 });
  assert.equal(u.n, 10); assert.equal(u.id, 'a');
  assert.equal(await c.update('nope', { n: 1 }), null);
  assert.equal(await c.delete('a'), true);
  assert.equal(await c.get('a'), null);
  assert.equal(await c.deleteWhere({ ok: false }), 1);
  st.close();
});

test('duplicate ids rejected; bad ids/fields/collections rejected', async () => {
  const st = await mk(); const c = st.collection('dups');
  await c.insert({ id: 'x' });
  await assert.rejects(() => c.insert({ id: 'x' }), { code: 'DUPLICATE_ID' });
  await assert.rejects(() => c.insert({ id: "x'; DROP TABLE c_dups;--" }));
  await assert.rejects(() => c.find({ where: { "a') OR 1=1 --": 1 } }));
  await assert.rejects(() => c.find({ orderBy: { field: 'id; DROP TABLE x' } }));
  assert.throws(() => st.collection('Bad Name; drop'));
  assert.equal(await c.get("x' OR '1'='1"), null);
  assert.equal(await c.count(), 1);
  st.close();
});

test('transactions commit, roll back, and serialize', async () => {
  const st = await mk(); const c = st.collection('tx');
  await st.transaction(async () => { await c.insert({ id: '1' }); });
  await assert.rejects(() => st.transaction(async () => { await c.insert({ id: '2' }); throw new Error('boom'); }));
  assert.equal(await c.get('2'), null);
  await Promise.all([1, 2, 3].map((i) => st.transaction(async () => { await c.insert({ id: `p${i}` }); })));
  assert.equal(await c.count(), 4);
  st.close();
});

test('export/import round trip, sessions excluded by default', async () => {
  const a = await mk();
  await a.collection('users').insert({ id: 'u1', email: 'a@b.c' });
  await a.collection('sessions').insert({ id: 's1' });
  const dump = await a.exportAll();
  assert.equal(dump.format, 'universe-export');
  assert.ok(dump.collections.users && !dump.collections.sessions);
  const b = await mk();
  await b.importAll(JSON.parse(JSON.stringify(dump)));
  assert.equal((await b.collection('users').get('u1')).email, 'a@b.c');
  await assert.rejects(() => b.importAll({ format: 'nope' }));
  a.close(); b.close();
});

test('export pages through large collections without losing documents', async () => {
  const st = await mk(); const c = st.collection('big');
  for (let i = 0; i < 25; i++) await c.insert({ id: `d${String(i).padStart(2, '0')}` });
  const dump = await st.exportAll({ pageSize: 7 });
  assert.equal(dump.collections.big.length, 25);
  assert.equal(new Set(dump.collections.big.map((d) => d.id)).size, 25);
  st.close();
});
