// Pulsar Boards: API (ownership, validation, idempotent autosave, history, resolve, link-preview safety) + geometry/model/stroke/connector engines.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, closeAll } from './helpers.js';
import * as G from '../apps/pulsar/lib/boards/geom.js';
import * as K from '../apps/pulsar/lib/boards/strokes.js';
import { route, arrowPath } from '../apps/pulsar/lib/boards/connectors.js';
import { BoardModel } from '../apps/pulsar/lib/boards/model.js';
import { sanitizeRich, richToText } from '../apps/pulsar/lib/boards/rich.js';
import { isBlockedAddress, parseMeta } from '../apps/pulsar/server/boards.js';
after(() => closeAll());
const B = '/api/apps/pulsar';

async function setup() {
  const t = await startTestApp(); const admin = await t.login('admin@example.com', 'correct-horse-battery');
  await t.request('POST', '/api/apps/pulsar/install', { cookie: admin.cookie });
  const mk = async (email, roleId = 'resident') => { await t.request('POST', '/api/users', { cookie: admin.cookie, body: { email, displayName: email, password: 'a-decent-password', roleId } }); return t.login(email, 'a-decent-password'); };
  return { t, a: await mk('a@example.com'), b: await mk('b@example.com'), g: await mk('g@example.com', 'guest') };
}
const rect = (id, x = 0, y = 0, extra = {}) => ({ id, type: 'shape', kind: 'rect', x, y, w: 100, h: 60, z: 1, ...extra });

test('boards: create, private to owner, guests blocked, validation', async () => {
  const { t, a, b, g } = await setup(); const R = (m, p, c, body) => t.request(m, B + p, { cookie: c.cookie, body });
  assert.equal((await R('GET', '/boards', g)).status, 403);
  const bd = (await R('POST', '/boards', a, { title: 'Mind', items: [rect('r1'), { id: 't1', type: 'text', x: 5, y: 5, w: 200, h: 80, html: 'Hi <b>there</b><script>alert(1)</script><img src=x onerror=y>' }] })).json.board;
  assert.equal(bd.itemCount, 2); assert.ok(!('ops' in bd));
  const got = (await R('GET', `/boards/${bd.id}/items`, a)).json.items; assert.equal(got.length, 2);
  assert.ok(!/script|img|onerror/.test(got.find((i) => i.id === 't1').html), 'rich text sanitised');
  assert.equal((await R('GET', `/boards/${bd.id}`, b)).status, 404); assert.equal((await R('POST', `/boards/${bd.id}/ops`, b, { opId: 'op-aaaaaa', upsert: [rect('x')] })).status, 404);
  assert.deepEqual((await R('GET', '/boards', b)).json.boards, []);
  for (const bad of [{ id: 'bad id!', type: 'shape' }, { id: 'a', type: 'script' }, { id: 'i', type: 'image', src: 'https://evil.example/x.png', x: 0, y: 0, w: 5, h: 5 }, { id: 'l', type: 'link', url: 'javascript:alert(1)' }, { id: 'd', type: 'draw', pts: [1, 2], x: 0, y: 0, w: 1, h: 1 }, { id: 'r', type: 'resource', ref: { type: 'hack', id: 'x' } }])
    assert.equal((await R('POST', '/boards', a, { items: [bad] })).status, 400, JSON.stringify(bad));
  assert.equal((await R('POST', '/boards', a, { items: [rect('same'), rect('same')] })).status, 400, 'duplicate ids rejected');
  const ok = await R('POST', '/boards', a, { items: [{ id: 'i', type: 'image', src: `${B}/assets/as_abc/file`, x: 0, y: 0, w: 50, h: 50, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, notes: [{ x: 0.5, y: 0.5, text: 'pin' }] }] }); assert.equal(ok.status, 201);
  const meta = (await R('PATCH', `/boards/${bd.id}`, a, { title: 'Renamed', favorite: true, description: 'd', folder: 'Work', settings: { grid: 32, snap: false, bg: 'lines' } })).json.board; assert.equal(meta.title, 'Renamed'); assert.equal(meta.settings.grid, 32);
  assert.equal((await R('PATCH', `/boards/${bd.id}`, a, { ownerId: 'x' })).status, 400);
});

test('autosave ops: idempotent, atomic, conflict detection, object limit math', async () => {
  const { t, a } = await setup(); const R = (m, p, body) => t.request(m, B + p, { cookie: a.cookie, body });
  const bd = (await R('POST', '/boards', { title: 'B' })).json.board;
  const op = { opId: 'op-123456', sid: 's1', baseRev: bd.rev, upsert: [rect('a'), rect('b', 200)] };
  const r1 = (await R('POST', `/boards/${bd.id}/ops`, op)).json; assert.equal(r1.itemCount, 2); const r2 = (await R('POST', `/boards/${bd.id}/ops`, op)).json; assert.equal(r2.duplicate, true); assert.equal(r2.itemCount, 2, 'replayed op does not duplicate');
  assert.equal((await R('GET', `/boards/${bd.id}/items`)).json.items.length, 2);
  const bad = await R('POST', `/boards/${bd.id}/ops`, { opId: 'op-bad-001', sid: 's1', upsert: [rect('c'), { id: 'z', type: 'nope' }] }); assert.equal(bad.status, 400);
  assert.equal((await R('GET', `/boards/${bd.id}/items`)).json.items.length, 2, 'failed batch writes nothing');
  const r3 = (await R('POST', `/boards/${bd.id}/ops`, { opId: 'op-222222', sid: 's1', baseRev: r1.rev, upsert: [rect('a', 50)], remove: ['b'] })).json; assert.equal(r3.itemCount, 1);
  const other = await R('POST', `/boards/${bd.id}/ops`, { opId: 'op-333333', sid: 's2', baseRev: 1, upsert: [rect('q')] }); assert.equal(other.status, 409, 'another session with a stale rev conflicts');
  assert.equal((await R('POST', `/boards/${bd.id}/ops`, { opId: 'op-444444', sid: 's2', baseRev: 1, force: true, upsert: [rect('q')] })).status, 200);
  const a1 = (await R('GET', `/boards/${bd.id}/items`)).json.items.find((i) => i.id === 'a'); assert.equal(a1.x, 50);
  const d = (await R('POST', `/boards/${bd.id}/duplicate`)).json.board; assert.match(d.title, /^Copy of/); assert.equal((await R('GET', `/boards/${d.id}/items`)).json.items.length, 2);
  assert.equal((await R('GET', `/boards/${bd.id}/items`)).json.items.length, 2, 'original untouched');
});

test('history: auto snapshot, manual version, restore, recover deleted objects, delete board', async () => {
  const { t, a } = await setup(); const R = (m, p, body) => t.request(m, B + p, { cookie: a.cookie, body });
  const bd = (await R('POST', '/boards', { title: 'H', items: [rect('a'), rect('b')] })).json.board;
  const v1 = (await R('POST', `/boards/${bd.id}/versions`, { label: 'Before' })).json.version; assert.equal(v1.itemCount, 2);
  await R('POST', `/boards/${bd.id}/ops`, { opId: 'op-h00001', sid: 's', remove: ['b'], upsert: [rect('a', 999), rect('c')] });
  const list = (await R('GET', `/boards/${bd.id}/versions`)).json.versions; assert.ok(list.length >= 2, 'auto snapshot taken'); assert.ok(list.every((x) => !('items' in x)));
  assert.equal((await R('POST', `/boards/${bd.id}/versions/${v1.id}/restore`, { mode: 'deleted' })).json.restored, 1, 'only the deleted object comes back');
  let items = (await R('GET', `/boards/${bd.id}/items`)).json.items; assert.deepEqual(items.map((i) => i.id).sort(), ['a', 'b', 'c']); assert.equal(items.find((i) => i.id === 'a').x, 999, 'current edits kept');
  await R('POST', `/boards/${bd.id}/versions/${v1.id}/restore`, { mode: 'all' }); items = (await R('GET', `/boards/${bd.id}/items`)).json.items; assert.deepEqual(items.map((i) => i.id).sort(), ['a', 'b']); assert.equal(items.find((i) => i.id === 'a').x, 0);
  assert.ok((await R('GET', `/boards/${bd.id}/versions`)).json.versions.some((x) => x.label === 'Before restore'), 'restore is itself undoable');
  assert.equal((await R('DELETE', `/boards/${bd.id}`)).status, 200); assert.equal((await R('GET', `/boards/${bd.id}`)).status, 404);
});

test('resolve Pulsar resources: live data, missing, trashed, other boards', async () => {
  const { t, a, b } = await setup(); const R = (m, p, c = a, body) => t.request(m, B + p, { cookie: c.cookie, body });
  const pg = (await R('POST', '/nodes', a, { title: 'My page', blocks: [{ id: 'b1', type: 'p', html: 'hello world' }] })).json.node;
  const db = (await R('POST', '/nodes', a, { kind: 'database', title: 'Tasks', schema: { props: [{ id: 'p1', name: 'Status', type: 'text', options: [] }], views: [] } })).json.node;
  await R('POST', '/nodes', a, { kind: 'entry', parentId: db.id, title: 'Row 1', props: { p1: 'x' } });
  const bd = (await R('POST', '/boards', a, { title: 'Other' })).json.board;
  const col = (await R('POST', '/nodes', a, { kind: 'collection', title: 'Col' })).json.node; await R('POST', '/nodes', a, { title: 'Child', parentId: col.id });
  const res = (await R('POST', '/boards/resolve', a, { refs: [{ type: 'page', id: pg.id }, { type: 'database', id: db.id }, { type: 'board', id: bd.id }, { type: 'page', id: 'pg_nothere' }, { type: 'collection', id: col.id }] })).json.results;
  assert.equal(res[`page:${pg.id}`].plain, 'hello world'); assert.equal(res[`database:${db.id}`].rowCount, 1); assert.equal(res[`database:${db.id}`].rows[0].props.p1, 'x');
  assert.equal(res[`board:${bd.id}`].title, 'Other'); assert.equal(res['page:pg_nothere'].state, 'missing'); assert.equal(res[`collection:${col.id}`].children[0].title, 'Child');
  assert.equal((await R('POST', '/boards/resolve', b, { refs: [{ type: 'page', id: pg.id }, { type: 'board', id: bd.id }] })).json.results[`page:${pg.id}`].state, 'missing', 'other users cannot resolve my pages');
  assert.equal((await R('POST', '/boards/resolve', b, { refs: [{ type: 'board', id: bd.id }] })).json.results[`board:${bd.id}`].state, 'missing');
  await R('POST', `/nodes/${pg.id}/trash`); assert.equal((await R('POST', '/boards/resolve', a, { refs: [{ type: 'page', id: pg.id }] })).json.results[`page:${pg.id}`].state, 'trashed');
});

test('link preview: refuses private addresses, bad schemes; parses metadata', async () => {
  const { t, a } = await setup(); const R = (url) => t.request('POST', `${B}/boards/link-preview`, { cookie: a.cookie, body: { url } });
  assert.equal((await R('javascript:alert(1)')).status, 400); assert.equal((await R('file:///etc/passwd')).status, 400);
  for (const u of ['http://127.0.0.1:1/', 'http://localhost/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://10.0.0.5/']) { const r = await R(u); assert.equal(r.status, 200); assert.equal(r.json.ok, false, u); }
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.0.1', '169.254.1.1', '::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0']) assert.ok(isBlockedAddress(ip), ip); for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700::1111']) assert.ok(!isBlockedAddress(ip), ip);
  const m = parseMeta('<title>Fallback</title><meta property="og:title" content="Hello &amp; Co"><meta name="description" content="Desc"><meta property="og:image" content="/img.png"><link rel="shortcut icon" href="/f.ico">', 'https://ex.com/a/b'); assert.deepEqual(m, { title: 'Hello & Co', description: 'Desc', image: 'https://ex.com/img.png', favicon: 'https://ex.com/f.ico' });
});

test('engine: coordinates, rotation, anchors, align/distribute, spatial index at huge distances', () => {
  const cam = { x: 1e6, y: -5e5, z: 0.5 }; const w = G.toWorld(cam, 100, 40); const s = G.toScreen(cam, w.x, w.y); assert.ok(Math.abs(s.x - 100) < 1e-6 && Math.abs(s.y - 40) < 1e-6);
  const z = G.zoomAt(cam, 300, 200, 2); const before = G.toWorld(cam, 300, 200), after = G.toWorld(z, 300, 200); assert.ok(Math.abs(before.x - after.x) < 1e-6, 'zoom keeps the point under the pointer');
  const it = { x: 0, y: 0, w: 100, h: 50, rot: 90 }; const bb = G.aabb(it); assert.deepEqual([bb.x, bb.y, bb.w, bb.h].map(Math.round), [25, -25, 50, 100]);
  assert.ok(G.pointInItem(it, 50, 70) && !G.pointInItem(it, 90, 25), 'hit test respects rotation');
  const r = G.anchorPoint({ x: 0, y: 0, w: 100, h: 100, rot: 0 }, 'right'); assert.deepEqual([r.x, r.y, r.nx, r.ny], [100, 50, 1, 0]);
  const al = G.alignPatches([{ id: 'a', x: 0, y: 0, w: 10, h: 10 }, { id: 'b', x: 50, y: 20, w: 10, h: 10 }], 'left'); assert.equal(al[1].patch.x, 0);
  const di = G.distributePatches([{ id: 'a', x: 0, y: 0, w: 10, h: 10 }, { id: 'b', x: 15, y: 0, w: 10, h: 10 }, { id: 'c', x: 90, y: 0, w: 10, h: 10 }], 'h'); assert.equal(di.find((p) => p.id === 'b').patch.x, 45);
  const ix = new G.SpatialIndex(); ix.set('far', { x: 9e9, y: -9e9, w: 10, h: 10 }); ix.set('near', { x: 0, y: 0, w: 10, h: 10 }); ix.set('big', { x: -1e8, y: -1e8, w: 2e8, h: 2e8 });
  assert.deepEqual([...ix.query({ x: 9e9, y: -9e9, w: 5, h: 5 })].sort(), ['far']); assert.deepEqual([...ix.query({ x: 1, y: 1, w: 2, h: 2 })].sort(), ['big', 'near']);
  assert.equal(G.snap(37, 16), 32);
});

test('engine: connectors stay attached, reroute, all four route types, arrowheads', () => {
  const A = { id: 'a', x: 0, y: 0, w: 100, h: 60 }, Bx = { id: 'b', x: 300, y: 200, w: 100, h: 60 }; const get = (id) => ({ a: A, b: Bx }[id]);
  for (const kind of ['straight', 'curve', 'elbow', 'free']) { const g = route({ from: { id: 'a', side: 'auto' }, to: { id: 'b', side: 'auto' }, route: kind, pts: kind === 'free' ? [{ x: 150, y: 150 }] : [] }, get); assert.ok(g.d.startsWith('M') && g.pts.length >= 2, kind); assert.ok(Number.isFinite(g.labelPos.x)); }
  const g1 = route({ from: { id: 'a', side: 'right' }, to: { id: 'b', side: 'left' }, route: 'straight' }, get); assert.deepEqual([g1.s.x, g1.s.y, g1.e.x, g1.e.y], [100, 30, 300, 230]);
  const moved = { ...Bx, x: 600 }; const g2 = route({ from: { id: 'a', side: 'right' }, to: { id: 'b', side: 'left' }, route: 'straight' }, (id) => (id === 'b' ? moved : A)); assert.equal(g2.e.x, 600, 'endpoint follows the moved object');
  const g3 = route({ from: { id: 'a', side: 'right' }, to: null, p2: { x: 500, y: 50 }, route: 'straight' }, get); assert.equal(g3.e.x, 500, 'free endpoint');
  assert.ok(route({ from: { id: 'gone' }, p1: { x: 1, y: 1 }, to: { id: 'b' }, route: 'elbow' }, get).s.broken, 'deleted target is flagged, not a crash');
  const eb = route({ from: { id: 'a', side: 'right' }, to: { id: 'b', side: 'top' }, route: 'elbow' }, get); assert.ok(eb.pts.every((p, i) => !i || p.x === eb.pts[i - 1].x || p.y === eb.pts[i - 1].y), 'elbow segments are orthogonal');
  for (const k of ['triangle', 'open', 'diamond', 'dot']) assert.match(arrowPath(k, { x: 0, y: 0 }, { x: 1, y: 0 }, 10), /^M/); assert.equal(arrowPath('none', { x: 0, y: 0 }, { x: 1, y: 0 }, 10), '');
});

test('engine: strokes simplify, render with pressure, erase partially', () => {
  const raw = []; for (let i = 0; i <= 100; i++) raw.push(i, i % 2 ? 0.1 : 0, 0.5); const st = K.makeStroke(raw, { tool: 'pen', color: '#fff' }); assert.ok(K.ptsCount(st.pts) < 10, 'simplified');
  assert.ok(K.strokePath({ ...st, pressure: true, pts: [0, 0, 0.1, 10, 0, 0.9, 20, 0, 0.5] }).fill, 'pressure -> outline'); assert.ok(K.strokeDist(st, 50, 5) < 10);
  const parts = K.eraseFromStroke(st, 50, 0, 8); assert.equal(parts.length, 2, 'splits into two strokes'); assert.equal(K.eraseFromStroke(st, 50, 500, 8), null); assert.deepEqual(K.eraseFromStroke(K.makeStroke([0, 0, 1, 1, 0, 1], { tool: 'pen' }), 0, 0, 50), []);
});

test('engine: model undo/redo, drag as one step, dirty tracking, connectors follow, deleting keeps connectors', () => {
  const m = new BoardModel(); m.tx('add', (t) => { t.put(rect('a')); t.put(rect('b', 300)); t.put({ id: 'c', type: 'connector', from: { id: 'a', side: 'auto' }, to: { id: 'b', side: 'auto' }, route: 'curve' }); });
  assert.equal(m.items.size, 3); const d0 = m.takeDirty(); assert.equal(d0.upsert.length, 3); assert.ok(!m.hasDirty);
  m.beginLive(); for (let i = 1; i <= 20; i++) m.livePatch([{ id: 'a', patch: { x: i * 10 } }]); m.endLive('move'); assert.equal(m.undoS.length, 2, '20 drag frames = one history step');
  assert.ok(!m.index.query({ x: 600, y: 600, w: 10, h: 10 }).has('c') && m.index.query({ x: 300, y: 30, w: 1, h: 1 }).has('c'), 'connector index updated after drag');
  m.undo(); assert.equal(m.get('a').x, 0); m.redo(); assert.equal(m.get('a').x, 200);
  const dirty = m.takeDirty(); assert.ok(dirty.upsert.some((i) => i.id === 'a')); m.giveBack(dirty); assert.ok(m.hasDirty, 'failed save puts changes back');
  m.tx('del', (t) => t.del('b')); assert.ok(m.gone.has('b')); assert.ok(m.get('c'), 'connector survives'); m.undo(); assert.ok(m.get('b')); assert.ok(!m.gone.has('b'));
  m.tx('x', (t) => t.patch('a', { style: { fill: '#ff0000' } })); m.tx('y', (t) => t.patch('a', { style: { stroke: '#00ff00' } })); assert.deepEqual(m.get('a').style, { fill: '#ff0000', stroke: '#00ff00' });
});

test('rich text sanitiser', () => {
  assert.equal(sanitizeRich('<b onclick="x">a</b><script>bad()</script><ul><li>x</li></ul><a href="javascript:x">l</a><img src=x>'), '<b>a</b><ul><li>x</li></ul>l'); assert.equal(richToText('<div>a</div><div>b</div>'), 'a\nb');
});

test('export/import engine: package round trip, validation, hostile packages, id remapping, formats', async () => {
  const E = await import('../apps/pulsar/lib/boards/export.js'); const { buildZip } = await import('../apps/pulsar/lib/zip.js');
  const items = [{ id: 'f', type: 'frame', x: 0, y: 0, w: 500, h: 300, title: 'Slide <1>', color: '#ff6b1a', z: 1 }, { id: 't', type: 'text', x: 20, y: 20, w: 200, h: 60, html: 'Hello <b>world</b>', z: 2, style: {} }, { id: 's', type: 'sticky', x: 260, y: 20, w: 150, h: 100, html: 'Note', z: 3, style: { bg: '#fff3a3' } }, { id: 'c', type: 'connector', from: { id: 't', side: 'auto' }, to: { id: 's', side: 'auto' }, route: 'curve', label: 'Leads to', endArrow: 'triangle', sw: 2, color: '#a6a6a6', z: 4 },
    { id: 'db', type: 'resource', ref: { type: 'database', id: 'x1' }, mode: 'snapshot', x: 0, y: 400, w: 300, h: 200, z: 5, snap: { kind: 'database', title: 'Tasks, "big"', props: [{ id: 'p', name: 'Status', type: 'text' }], rows: [{ id: 'r1', title: 'A', props: { p: 'Todo' } }] } }];
  const { zip, manifest } = await E.buildPackage({ title: 'T', description: 'd' }, items, { includeMedia: false });
  assert.equal(manifest.format, 'pulsar-board-package'); assert.equal(manifest.counts.connectors, 1); assert.ok(manifest.files.some((f) => /^data\/.*\.csv$/.test(f)), 'database CSV included'); assert.ok(manifest.unsupported.some((u) => u.note), 'explains that resources are references, not copies');
  const back = await E.readPackage(zip); assert.equal(back.items.length, 5); assert.equal(back.board.title, 'T');
  const re = E.remapIds(back.items, (() => { let n = 0; return () => `n${++n}`; })()); const ids = new Set(re.map((i) => i.id)); const c = re.find((i) => i.type === 'connector'); assert.ok(!ids.has('t') && ids.has(c.from.id) && ids.has(c.to.id), 'connector follows remapped ids');
  const part = E.remapIds(items.filter((i) => i.id !== 's'), () => 'zz' + Math.random()); assert.equal(part.find((i) => i.type === 'connector').to, null, 'a connector whose target is not in the package becomes a free end, not a dangling reference');
  await assert.rejects(E.readPackage(buildZip([{ name: '../evil.txt', data: 'x' }, { name: 'manifest.json', data: '{}' }])), /Unsafe path/); await assert.rejects(E.readPackage(buildZip([{ name: 'manifest.json', data: '{"format":"other","version":1}' }, { name: 'board.json', data: '{}' }])), /not a Pulsar board package/);
  await assert.rejects(E.readPackage(buildZip([{ name: 'manifest.json', data: `{"format":"pulsar-board-package","version":99}` }, { name: 'board.json', data: '{}' }])), /newer Pulsar/); await assert.rejects(E.readPackage(new TextEncoder().encode('not a zip')), /not a valid/);
  const hostile = buildZip([{ name: 'manifest.json', data: JSON.stringify({ format: 'pulsar-board-package', version: 1 }) }, { name: 'board.json', data: JSON.stringify({ items: [{ id: 'a', type: 'script', html: '<script>x</script>' }, { id: 'b', type: 'sticky', html: 'ok', x: 0, y: 0, w: 10, h: 10 }, null] }) }]); const h = await E.readPackage(hostile); assert.equal(h.items.length, 1); assert.equal(h.warnings.length, 2, 'unknown objects are reported, not silently dropped');
  const md = E.boardMarkdown({ title: 'T', description: 'd' }, items); assert.match(md, /## Slide <1>/); assert.match(md, /Hello world/); assert.match(md, /Leads to/);
  const csv = E.databaseCsvs(items)[0]; assert.equal(csv.data.split('\n')[0], 'Name,Status'); assert.ok(csv.name.endsWith('.csv'));
  const { svg } = E.buildSvg(items, E.contentRect(items)); assert.match(svg, /^<svg /); assert.match(svg, /Slide &lt;1&gt;/, 'text is escaped'); assert.ok(!/<script|foreignObject/.test(svg));
  const pdf = E.buildImagePdf([{ jpeg: new Uint8Array([255, 216, 255, 217]), w: 100, h: 50 }, { jpeg: new Uint8Array([255, 216, 255, 217]), w: 10, h: 10 }]); const txt = new TextDecoder('latin1').decode(pdf); assert.ok(txt.startsWith('%PDF-1.4') && txt.includes('/Count 2') && txt.trimEnd().endsWith('%%EOF'));
});
