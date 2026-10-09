import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, closeAll } from './helpers.js';
after(closeAll);

const B = '/api/apps/inventory';
const CLOUD = { publicId: 'universe/x', secureUrl: 'https://res.cloudinary.com/democloud/image/upload/v1/x.jpg', resourceType: 'image', width: 10, height: 10, format: 'jpg', uploadedAt: '2026-01-01T00:00:00Z' };

async function setup() {
  const t = await startTestApp({ cloudinary: { cloudName: 'democloud', uploadPreset: 'preset1' } });
  const admin = await t.login('admin@example.com', 'correct-horse-battery');
  const mk = async (email, roleId = 'resident') => {
    await t.request('POST', '/api/users', { cookie: admin.cookie, body: { email, displayName: email, password: 'a-decent-password', roleId } });
    return t.login(email, 'a-decent-password');
  };
  const pre = await mk('a@example.com'); // created before install
  await t.request('POST', '/api/apps/inventory/install', { cookie: admin.cookie });
  const a = await t.login('a@example.com', 'a-decent-password'); // re-login picks up new permissions
  const b = await mk('b@example.com'); const g = await mk('g@example.com', 'guest');
  const add = async (u, item) => (await t.request('POST', `${B}/items`, { cookie: u.cookie, body: item })).json?.item;
  return { t, admin, a, b, g, add, pre };
}

test('gated: 404 when not installed, 401 anonymous, 403 for guests', async () => {
  const t = await startTestApp();
  const admin = await t.login('admin@example.com', 'correct-horse-battery');
  assert.equal((await t.request('GET', `${B}/items`, { cookie: admin.cookie })).status, 404);
  await t.request('POST', '/api/apps/inventory/install', { cookie: admin.cookie });
  assert.equal((await t.request('GET', `${B}/items`)).status, 401);
  assert.equal((await t.request('GET', `${B}/items`, { cookie: admin.cookie })).status, 200);
  await t.request('POST', '/api/users', { cookie: admin.cookie, body: { email: 'g@example.com', displayName: 'g', password: 'a-decent-password', roleId: 'guest' } });
  const g = await t.login('g@example.com', 'a-decent-password');
  assert.equal((await t.request('GET', `${B}/items`, { cookie: g.cookie })).status, 403);
  assert.equal((await t.request('POST', `${B}/items`, { cookie: g.cookie, body: { identity: { name: 'x' } } })).status, 403);
  await t.close();
});

test('create/read/update with defaults, auto history, validation', async () => {
  const { t, a, add } = await setup();
  const it = await add(a, { identity: { name: 'itel A90', tags: ['Phone', 'daily-use'] }, acquisition: { method: 'purchased', price: 85000, currency: 'ngn', date: '2026-01-15' } });
  assert.equal(it.schemaVersion, 1); assert.equal(it.status.state, 'in_use'); assert.deepEqual(it.identity.tags, ['phone', 'daily-use']);
  assert.equal(it.acquisition.currency, 'NGN'); assert.equal(it.history[0].event, 'created');
  const up = await t.request('PATCH', `${B}/items/${it.id}`, { cookie: a.cookie, body: { status: { state: 'lost', reason: 'Left on a bus' }, condition: { state: 'poor' } } });
  assert.equal(up.status, 200);
  assert.deepEqual(up.json.item.history.map((h) => h.event), ['created', 'status_changed', 'condition_changed']);
  assert.equal(up.json.item.identity.name, 'itel A90'); // untouched fields preserved
  for (const bad of [{}, { identity: {} }, { identity: { name: 'x' }, status: { state: 'exploded' } }, { identity: { name: 'x' }, ownership: { ownerId: 'user_x' } },
    { identity: { name: 'x' }, id: 'item_hack' }, { identity: { name: 'x' }, history: [] }, { identity: { name: 'x' }, acquisition: { price: -5 } }, { identity: { name: 'x' }, acquisition: { date: '15/01/2026' } },
    { identity: { name: 'x', categoryId: 'cat_nope' } }]) assert.equal((await t.request('POST', `${B}/items`, { cookie: a.cookie, body: bad })).status, 400, JSON.stringify(bad));
  const note = await t.request('POST', `${B}/items/${it.id}/history`, { cookie: a.cookie, body: { reason: 'Found it again' } });
  assert.equal(note.json.item.history.at(-1).event, 'note');
  await t.close();
});

test('data isolation: users never see or touch each others items, categories, locations', async () => {
  const { t, a, b, admin, add } = await setup();
  const it = await add(a, { identity: { name: 'secret thing' } });
  assert.equal((await t.request('GET', `${B}/items/${it.id}`, { cookie: b.cookie })).status, 404);
  assert.equal((await t.request('PATCH', `${B}/items/${it.id}`, { cookie: b.cookie, body: { notes: 'hax' } })).status, 404);
  assert.equal((await t.request('POST', `${B}/items/${it.id}/archive`, { cookie: b.cookie })).status, 404);
  assert.equal((await t.request('DELETE', `${B}/items/${it.id}`, { cookie: b.cookie })).status, 404);
  assert.equal((await t.request('GET', `${B}/items`, { cookie: b.cookie })).json.total, 0);
  assert.equal((await t.request('GET', `${B}/items/${it.id}`, { cookie: admin.cookie })).status, 404); // even admins: private by default
  const catA = (await t.request('GET', `${B}/categories`, { cookie: a.cookie })).json.categories[0];
  assert.equal((await t.request('POST', `${B}/items`, { cookie: b.cookie, body: { identity: { name: 'x', categoryId: catA.id } } })).status, 400);
  assert.equal((await t.request('POST', `${B}/items`, { cookie: b.cookie, body: { identity: { name: 'x' }, relationships: { relatedItems: [it.id] } } })).status, 400);
  assert.equal((await t.request('DELETE', `${B}/categories/${catA.id}`, { cookie: b.cookie })).status, 404);
  assert.equal((await t.request('GET', `${B}/stats/summary`, { cookie: b.cookie })).json.stats[0].value, 0);
  await t.close();
});

test('search, filter, sort, archive/restore/delete rules', async () => {
  const { t, a, add } = await setup();
  const phone = await add(a, { identity: { name: 'Phone', tags: ['tech'] }, acquisition: { price: 300, currency: 'USD' } });
  await add(a, { identity: { name: 'Chair', description: 'wooden' }, status: { state: 'lent_out' }, acquisition: { price: 50, currency: 'USD' } });
  const q = async (qs) => (await t.request('GET', `${B}/items?${qs}`, { cookie: a.cookie })).json.items.map((i) => i.identity.name);
  assert.deepEqual(await q('q=wooden'), ['Chair']);
  assert.deepEqual(await q('status=lent_out'), ['Chair']);
  assert.deepEqual(await q('tag=TECH'), ['Phone']);
  assert.deepEqual(await q('sort=name&dir=asc'), ['Chair', 'Phone']);
  assert.deepEqual(await q('sort=price&dir=desc'), ['Phone', 'Chair']);
  assert.equal((await t.request('DELETE', `${B}/items/${phone.id}`, { cookie: a.cookie })).status, 409); // must archive first
  await t.request('POST', `${B}/items/${phone.id}/archive`, { cookie: a.cookie });
  assert.deepEqual(await q(''), ['Chair']); assert.deepEqual(await q('archived=true'), ['Phone']);
  await t.request('POST', `${B}/items/${phone.id}/restore`, { cookie: a.cookie });
  assert.equal((await q('')).length, 2);
  await t.request('POST', `${B}/items/${phone.id}/archive`, { cookie: a.cookie });
  assert.equal((await t.request('DELETE', `${B}/items/${phone.id}`, { cookie: a.cookie })).status, 200);
  assert.equal((await t.request('GET', `${B}/items/${phone.id}`, { cookie: a.cookie })).status, 404);
  await t.close();
});

test('categories/locations: seeded, in-use deletion blocked, location tree has no cycles', async () => {
  const { t, a, add } = await setup();
  const cats = (await t.request('GET', `${B}/categories`, { cookie: a.cookie })).json.categories;
  assert.ok(cats.length >= 5);
  const it = await add(a, { identity: { name: 'TV', categoryId: cats[0].id } });
  assert.equal((await t.request('DELETE', `${B}/categories/${cats[0].id}`, { cookie: a.cookie })).status, 409);
  assert.equal((await t.request('PATCH', `${B}/categories/${cats[1].id}`, { cookie: a.cookie, body: { name: 'Renamed' } })).json.category.name, 'Renamed');
  assert.equal((await t.request('DELETE', `${B}/categories/${cats[1].id}`, { cookie: a.cookie })).status, 200);
  const house = (await t.request('POST', `${B}/locations`, { cookie: a.cookie, body: { name: 'House' } })).json.location;
  const room = (await t.request('POST', `${B}/locations`, { cookie: a.cookie, body: { name: 'Bedroom', parentId: house.id } })).json.location;
  assert.equal((await t.request('PATCH', `${B}/locations/${house.id}`, { cookie: a.cookie, body: { parentId: room.id } })).status, 400);
  assert.equal((await t.request('PATCH', `${B}/locations/${house.id}`, { cookie: a.cookie, body: { parentId: house.id } })).status, 400);
  assert.equal((await t.request('DELETE', `${B}/locations/${house.id}`, { cookie: a.cookie })).status, 409); // has child
  await t.request('PATCH', `${B}/items/${it.id}`, { cookie: a.cookie, body: { location: { locationId: room.id } } });
  assert.equal((await t.request('DELETE', `${B}/locations/${room.id}`, { cookie: a.cookie })).status, 409); // has item
  const by = (await t.request('GET', `${B}/stats/by-location`, { cookie: a.cookie })).json.series;
  assert.deepEqual(by, [{ label: 'Bedroom', value: 1 }]);
  await t.close();
});

test('relationships: loops rejected; deleting an item cleans references', async () => {
  const { t, a, add } = await setup();
  const p = await add(a, { identity: { name: 'Laptop' } });
  const c = await add(a, { identity: { name: 'Charger' }, relationships: { parentItemId: p.id } });
  assert.equal((await t.request('PATCH', `${B}/items/${p.id}`, { cookie: a.cookie, body: { relationships: { parentItemId: c.id } } })).status, 400);
  assert.equal((await t.request('PATCH', `${B}/items/${p.id}`, { cookie: a.cookie, body: { relationships: { relatedItems: [p.id] } } })).status, 400);
  await t.request('POST', `${B}/items/${p.id}/archive`, { cookie: a.cookie });
  await t.request('DELETE', `${B}/items/${p.id}`, { cookie: a.cookie });
  assert.equal((await t.request('GET', `${B}/items/${c.id}`, { cookie: a.cookie })).json.item.relationships.parentItemId, null);
  await t.close();
});

test('images: only metadata from our Cloudinary cloud is accepted; meta exposes no secrets', async () => {
  const { t, a, add } = await setup();
  const ok = await add(a, { identity: { name: 'Camera' }, media: { images: [CLOUD] } });
  assert.equal(ok.media.images[0].publicId, 'universe/x');
  const post = (img) => t.request('POST', `${B}/items`, { cookie: a.cookie, body: { identity: { name: 'x' }, media: { images: [img] } } });
  assert.equal((await post({ ...CLOUD, secureUrl: 'https://evil.example/x.jpg' })).status, 400);
  assert.equal((await post({ ...CLOUD, secureUrl: 'https://res.cloudinary.com/othercloud/image/upload/x.jpg' })).status, 400);
  assert.equal((await post({ ...CLOUD, secureUrl: 'http://res.cloudinary.com/democloud/x.jpg' })).status, 400);
  assert.equal((await post({ ...CLOUD, extra: 1 })).status, 400);
  const meta = await t.request('GET', `${B}/meta`, { cookie: a.cookie });
  assert.equal(meta.json.cloudinary.cloudName, 'democloud');
  assert.ok(meta.json.cloudinary.folder.startsWith('universe/inventory/user_'));
  assert.ok(!/secret|api_?key/i.test(meta.text));
  assert.equal(meta.json.statuses.length, 10);
  await t.close();
});

test('statistics reflect only the callers active items', async () => {
  const { t, a, add } = await setup();
  await add(a, { identity: { name: 'A' }, acquisition: { price: 100, currency: 'NGN' } });
  await add(a, { identity: { name: 'B' }, status: { state: 'damaged' }, acquisition: { price: 50, currency: 'NGN' } });
  await add(a, { identity: { name: 'C' }, status: { state: 'lost' } });
  const st = Object.fromEntries((await t.request('GET', `${B}/stats/summary`, { cookie: a.cookie })).json.stats.map((s) => [s.label, s.value]));
  assert.equal(st['Total items'], 3); assert.equal(st['In use'], 1); assert.equal(st['Lost'], 1); assert.equal(st['Needs attention'], 2); assert.equal(st['Estimated value'], 'NGN 150');
  assert.equal((await t.request('GET', `${B}/stats/recent`, { cookie: a.cookie })).json.items.length, 3);
  await t.close();
});

test('export/import: round trip works, ids are remapped, others data cannot be overwritten', async () => {
  const { t, a, b, add } = await setup();
  const cat = (await t.request('POST', `${B}/categories`, { cookie: a.cookie, body: { name: 'Gadgets' } })).json.category;
  const loc = (await t.request('POST', `${B}/locations`, { cookie: a.cookie, body: { name: 'Desk' } })).json.location;
  const p = await add(a, { identity: { name: 'Mouse', categoryId: cat.id }, location: { locationId: loc.id } });
  const k = await add(a, { identity: { name: 'Keyboard' }, relationships: { relatedItems: [p.id] } });
  const dump = (await t.request('GET', `${B}/export`, { cookie: a.cookie }));
  assert.match(dump.headers.get('content-disposition'), /attachment/);
  // b imports a's file
  const imp = await t.request('POST', `${B}/import`, { cookie: b.cookie, body: dump.json });
  assert.equal(imp.status, 201); assert.equal(imp.json.imported.items, 2);
  const bItems = (await t.request('GET', `${B}/items?sort=name&dir=asc`, { cookie: b.cookie })).json.items;
  assert.deepEqual(bItems.map((i) => i.identity.name), ['Keyboard', 'Mouse']);
  assert.ok(!bItems.some((i) => i.id === p.id || i.id === k.id)); // fresh ids
  assert.ok(bItems.every((i) => i.ownership.ownerId !== a.id && i.history.at(-1).event === 'imported'));
  const mouse = bItems.find((i) => i.identity.name === 'Mouse'), kb = bItems.find((i) => i.identity.name === 'Keyboard');
  assert.deepEqual(kb.relationships.relatedItems, [mouse.id]); // references remapped to b's copies
  assert.notEqual(mouse.identity.categoryId, cat.id);
  const bCats = (await t.request('GET', `${B}/categories`, { cookie: b.cookie })).json.categories.map((c) => c.name);
  assert.ok(bCats.includes('Gadgets'));
  // a's original data untouched
  assert.equal((await t.request('GET', `${B}/items/${p.id}`, { cookie: a.cookie })).status, 200);
  // hostile import: tries to claim a's ids and another owner
  const evil = { ...dump.json, items: dump.json.items.map((i) => ({ ...i, ownership: { type: 'personal', ownerId: a.id } })) };
  await t.request('POST', `${B}/import`, { cookie: b.cookie, body: evil });
  assert.equal((await t.request('GET', `${B}/items`, { cookie: a.cookie })).json.total, 2);
  assert.equal((await t.request('POST', `${B}/import`, { cookie: b.cookie, body: { format: 'nope' } })).status, 400);
  assert.equal((await t.request('POST', `${B}/import`, { cookie: b.cookie, body: { ...dump.json, items: [{ identity: {} }] } })).status, 400);
  await t.close();
});

test('inventory UI files are served while active; server code never is', async () => {
  const { t, admin } = await setup();
  const get = async (path) => (await fetch(`http://127.0.0.1:${t.app.server.address().port}${path}`)).status;
  for (const f of ['/apps/inventory/', '/apps/inventory/app.js', '/apps/inventory/styles.css', '/apps/inventory/services/media.js', '/apps/inventory/manifest.json']) assert.equal(await get(f), 200, f);
  for (const f of ['/apps/inventory/server/index.js', '/apps/inventory/server/schema.js']) assert.equal(await get(f), 404, f);
  const csp = (await fetch(`http://127.0.0.1:${t.app.server.address().port}/`)).headers.get('content-security-policy');
  assert.match(csp, /connect-src 'self' https:\/\/api\.cloudinary\.com/);
  assert.ok(!/api_secret|CLOUDINARY_API_SECRET/i.test(await (await fetch(`http://127.0.0.1:${t.app.server.address().port}/apps/inventory/services/media.js`)).text().then((x) => x.replace(/never appear/g, '').replace(/API secret/g, ''))));
  await t.close();
});
