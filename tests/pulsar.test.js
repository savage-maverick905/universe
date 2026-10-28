// Pulsar: API behaviour (persistence, nesting, trash, images, isolation, backup import) plus the PDF/ZIP/Markdown engines.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startTestApp, closeAll } from './helpers.js';
import { buildPdf, makeImageRegistry, jpegInfo } from '../apps/pulsar/lib/pdf.js';
import { buildZip, readZip, crc32 } from '../apps/pulsar/lib/zip.js';
import { blocksToMarkdown } from '../apps/pulsar/lib/md.js';
import { sanitizeHtml, htmlToRuns, blocksPlain } from '../apps/pulsar/lib/inline.js';
after(() => closeAll());
const B = '/api/apps/pulsar';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

async function setup() {
  const t = await startTestApp(); const admin = await t.login('admin@example.com', 'correct-horse-battery');
  const mk = async (email, roleId = 'resident') => { await t.request('POST', '/api/users', { cookie: admin.cookie, body: { email, displayName: email, password: 'a-decent-password', roleId } }); return t.login(email, 'a-decent-password'); };
  const pre = await t.request('GET', `${B}/meta`, { cookie: admin.cookie });
  await t.request('POST', '/api/apps/pulsar/install', { cookie: admin.cookie });
  const a = await mk('a@example.com'), b = await mk('b@example.com'), g = await mk('g@example.com', 'guest');
  return { t, admin, a, b, g, pre };
}

test('404 before install, 403 for guests, persistence and nesting', async () => {
  const { t, a, g, pre } = await setup();
  assert.equal(pre.status, 404);
  assert.equal((await t.request('GET', `${B}/nodes`, { cookie: g.cookie })).status, 403);
  const col = (await t.request('POST', `${B}/nodes`, { cookie: a.cookie, body: { kind: 'collection', title: 'Work' } })).json.node;
  const pg = (await t.request('POST', `${B}/nodes`, { cookie: a.cookie, body: { kind: 'page', title: 'Plan', parentId: col.id } })).json.node;
  const sub = (await t.request('POST', `${B}/nodes`, { cookie: a.cookie, body: { kind: 'page', title: 'Sub', parentId: pg.id } })).json.node;
  const blocks = [{ id: 'b1', type: 'p', html: 'Hello <b>world</b><script>alert(1)</script>' }, { id: 'b2', type: 'image', src: `${B}/assets/as_x/file`, alt: 'pic', w: 50, align: 'left', caption: 'Cap' }, { id: 'b3', type: 'p', html: 'After image' }, { id: 'b4', type: 'table', rows: [['A', 'B'], ['1', '2']] }];
  const saved = await t.request('PATCH', `${B}/nodes/${pg.id}`, { cookie: a.cookie, body: { blocks, rev: pg.rev } });
  assert.equal(saved.status, 200); assert.equal(saved.json.node.rev, 2);
  const got = (await t.request('GET', `${B}/nodes/${pg.id}`, { cookie: a.cookie })).json.node;
  assert.deepEqual(got.blocks.map((x) => x.type), ['p', 'image', 'p', 'table']);
  assert.ok(!got.blocks[0].html.includes('script') && !got.blocks[0].html.includes('<script'), 'html is sanitised');
  assert.equal(got.blocks[1].w, 50); assert.match(got.plain, /After image/);
  assert.equal((await t.request('PATCH', `${B}/nodes/${pg.id}`, { cookie: a.cookie, body: { title: 'x', rev: 1 } })).status, 409, 'stale rev conflicts');
  assert.equal((await t.request('PATCH', `${B}/nodes/${col.id}`, { cookie: a.cookie, body: { parentId: sub.id } })).status, 400, 'no cycles');
  assert.equal((await t.request('POST', `${B}/nodes`, { cookie: a.cookie, body: { kind: 'page', blocks: [{ type: 'image', src: 'https://evil.example/x.png' }] } })).status, 400);
});

test('isolation, trash, restore, duplicate, search, backlinks', async () => {
  const { t, a, b } = await setup(); const mk = async (body) => (await t.request('POST', `${B}/nodes`, { cookie: a.cookie, body })).json.node;
  const col = await mk({ kind: 'collection', title: 'Notes' }); const p1 = await mk({ title: 'Alpha', parentId: col.id, tags: ['x'], blocks: [{ id: 'q', type: 'p', html: 'needle in haystack' }] });
  const p2 = await mk({ title: 'Beta', blocks: [{ id: 'l', type: 'pagelink', pageId: p1.id, title: 'Alpha' }] });
  assert.equal((await t.request('GET', `${B}/nodes/${p1.id}`, { cookie: b.cookie })).status, 404);
  assert.equal((await t.request('PATCH', `${B}/nodes/${p1.id}`, { cookie: b.cookie, body: { title: 'hack' } })).status, 404);
  assert.deepEqual((await t.request('GET', `${B}/nodes`, { cookie: b.cookie })).json.nodes, []);
  assert.equal((await t.request('GET', `${B}/search?q=needle`, { cookie: a.cookie })).json.nodes[0].id, p1.id);
  assert.equal((await t.request('GET', `${B}/search?q=needle&tag=nope`, { cookie: a.cookie })).json.nodes.length, 0);
  assert.equal((await t.request('GET', `${B}/nodes/${p1.id}/backlinks`, { cookie: a.cookie })).json.nodes[0].id, p2.id);
  const dup = await t.request('POST', `${B}/nodes/${col.id}/duplicate`, { cookie: a.cookie }); assert.equal(dup.json.count, 2); assert.match(dup.json.node.title, /^Copy of/);
  assert.equal((await t.request('DELETE', `${B}/nodes/${col.id}`, { cookie: a.cookie })).status, 409, 'must trash first');
  await t.request('POST', `${B}/nodes/${col.id}/trash`, { cookie: a.cookie });
  assert.equal((await t.request('GET', `${B}/nodes?trashed=1`, { cookie: a.cookie })).json.nodes.length, 2);
  assert.equal((await t.request('GET', `${B}/search?q=needle`, { cookie: a.cookie })).json.nodes.length, 1, 'only the copy remains searchable');
  await t.request('POST', `${B}/nodes/${col.id}/restore`, { cookie: a.cookie });
  assert.equal((await t.request('GET', `${B}/nodes?trashed=1`, { cookie: a.cookie })).json.nodes.length, 0);
  await t.request('POST', `${B}/nodes/${col.id}/trash`, { cookie: a.cookie });
  assert.equal((await t.request('DELETE', `${B}/nodes/${col.id}`, { cookie: a.cookie })).json.deleted, 2);
});

test('journal, databases and entries', async () => {
  const { t, a } = await setup();
  const j1 = await t.request('POST', `${B}/journal/2026-03-04`, { cookie: a.cookie, body: { blocks: [{ type: 'p', html: 'Dear diary' }] } }); const j2 = await t.request('POST', `${B}/journal/2026-03-04`, { cookie: a.cookie, body: {} });
  assert.equal(j1.status, 201); assert.equal(j2.json.created, false); assert.equal(j2.json.node.id, j1.json.node.id);
  assert.equal((await t.request('POST', `${B}/journal/bad`, { cookie: a.cookie, body: {} })).status, 400);
  const db = (await t.request('POST', `${B}/nodes`, { cookie: a.cookie, body: { kind: 'database', title: 'Books', schema: { props: [{ id: 'pr_s', name: 'Status', type: 'status', options: [{ id: 'o1', name: 'Reading' }] }, { id: 'pr_d', name: 'Due', type: 'date' }] } } })).json.node;
  assert.equal(db.schema.views[0].type, 'table');
  const e = await t.request('POST', `${B}/nodes`, { cookie: a.cookie, body: { kind: 'entry', parentId: db.id, title: 'Dune', props: { pr_s: 'o1', pr_d: '2026-05-01' }, blocks: [{ id: 'x', type: 'p', html: 'notes' }] } });
  assert.equal(e.status, 201); assert.equal(e.json.node.dbId, db.id);
  assert.equal((await t.request('POST', `${B}/nodes`, { cookie: a.cookie, body: { kind: 'entry', title: 'orphan' } })).status, 400);
  await t.request('POST', `${B}/nodes/${db.id}/trash`, { cookie: a.cookie });
  assert.equal((await t.request('GET', `${B}/nodes?trashed=1`, { cookie: a.cookie })).json.nodes.length, 2, 'entries follow their database into the trash');
});

test('assets: upload, serve, isolate, reject bad files; import restores a backup', async () => {
  const { t, a, b } = await setup(); const up = (cookie, type, body, name = 'p.png') => fetch(t.app.server.address && `http://127.0.0.1:${t.app.server.address().port}${B}/assets?name=${name}`, { method: 'POST', headers: { 'Content-Type': type, 'X-Requested-With': 'universe', Cookie: cookie }, body });
  const ok = await up(a.cookie, 'image/png', PNG); assert.equal(ok.status, 201); const asset = (await ok.json()).asset;
  const f = await fetch(`http://127.0.0.1:${t.app.server.address().port}${asset.src}`, { headers: { Cookie: a.cookie } }); assert.equal(f.status, 200); assert.equal(f.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await f.arrayBuffer()), PNG);
  assert.equal((await fetch(`http://127.0.0.1:${t.app.server.address().port}${asset.src}`, { headers: { Cookie: b.cookie } })).status, 404);
  assert.equal((await up(a.cookie, 'image/svg+xml', Buffer.from('<svg/>'))).status, 415);
  assert.equal((await up(a.cookie, 'image/png', Buffer.from('not a png'))).status, 400);
  assert.equal((await up(a.cookie, 'image/png', Buffer.alloc(3.5 * 1024 * 1024, 1))).status, 413);
  const imp = await t.request('POST', `${B}/import`, { cookie: b.cookie, body: { nodes: [{ id: 'pg_a', kind: 'collection', title: 'Restored' }, { id: 'pg_b', kind: 'page', title: 'Child', parentId: 'pg_a', blocks: [{ id: 'z', type: 'image', src: asset.src, alt: 'p' }] }, { id: 'pg_c', kind: 'bogus' }] } });
  assert.equal(imp.json.imported, 2); assert.equal(imp.json.failed.length, 1);
  assert.equal((await t.request('POST', `${B}/import`, { cookie: b.cookie, body: { nodes: [{ id: 'pg_a', title: 'Again' }] } })).json.skipped, 1);
  assert.equal((await t.request('GET', `${B}/nodes/pg_b`, { cookie: b.cookie })).json.node.blocks[0].src, asset.src);
});

test('PDF engine: real, valid PDFs with images between paragraphs; ZIP round trip; Markdown', async () => {
  const jpg = new Uint8Array(readFileSync(new URL('./fixtures/pulsar.jpg', import.meta.url))); assert.ok(jpegInfo(jpg)); const reg = makeImageRegistry(), im = reg.add('k', jpg);
  const blocks = [{ id: '1', type: 'h1', html: 'Title' }, { id: '2', type: 'p', html: 'before <b>bold</b>' }, { id: '3', type: 'image', img: im, w: 50, caption: htmlToRuns('cap') }, { id: '4', type: 'p', html: 'after' }, { id: '5', type: 'table', rows: [['a', 'b'], ['c', 'd']] }, { id: '6', type: 'image', img: null, src: 'x.png' }];
  const one = buildPdf({ title: 'T', items: [{ title: 'T', blocks }], images: reg.list }); const head = Buffer.from(one.bytes.subarray(0, 8)).toString(); assert.match(head, /^%PDF-1\.4/); assert.ok(one.pages >= 1);
  assert.ok(Buffer.from(one.bytes).includes('/DCTDecode'), 'image embedded'); assert.ok(one.warnings.some((w) => /could not be included/.test(w)), 'failed image is reported, not silent');
  const many = buildPdf({ title: 'C', toc: true, images: reg.list, items: [{ title: 'Root', level: 0, blocks }, { title: 'Kid', level: 1, blocks }] }); assert.ok(many.pages > one.pages); assert.ok(Buffer.from(many.bytes).includes('/Outlines'));
  const emoji = buildPdf({ title: 'E', items: [{ title: 'E', blocks: [{ id: 'a', type: 'p', html: 'Hi 🎉' }] }] }); assert.ok(emoji.warnings.some((w) => /replaced/.test(w)));
  const zip = buildZip([{ name: 'a/one.pdf', data: one.bytes }, { name: 'a/one.pdf', data: one.bytes }, { name: 'ü.md', data: '# x' }]); const files = await readZip(zip);
  assert.deepEqual(files.map((f) => f.name), ['a/one.pdf', 'a/one (2).pdf', 'ü.md']); assert.equal(crc32(files[0].data), crc32(one.bytes)); assert.equal(Buffer.from(files[2].data).toString(), '# x');
  const md = blocksToMarkdown([{ id: '1', type: 'h2', html: 'H' }, { id: '2', type: 'ol', html: 'one' }, { id: '3', type: 'ol', html: 'two' }, { id: '4', type: 'todo', html: 't', checked: true }, { id: '5', type: 'image', src: 'u', alt: 'A', caption: 'c' }, { id: '6', type: 'table', rows: [['h', 'i'], ['1', '2']] }], { imgPath: () => 'assets/a.jpg' });
  assert.match(md, /## H\n\n1\. one\n2\. two\n\n- \[x\] t\n\n!\[A\]\(assets\/a\.jpg\)/); assert.match(md, /\| h \| i \|\n\| --- \| --- \|/);
  assert.equal(sanitizeHtml('<img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a>'), 'x'); assert.match(blocksPlain(blocks), /after/);
});
