import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

// Pretend to be the Android app: a native bridge that collects what the page sends it.
const got = { chunks: [], name: null, action: null, aborted: false };
globalThis.window = globalThis;
globalThis.UniverseNative = { fileBegin: (name) => { got.name = name; got.chunks = []; return 'tok'; }, fileChunk: (t, b64) => { got.chunks.push(Buffer.from(b64, 'base64')); return true; }, fileEnd: (t, action) => { got.action = action; return 'ok'; }, fileAbort: () => { got.aborted = true; } };
globalThis.HTMLAnchorElement = class { constructor() { this.attrs = {}; this.clicked = false; } setAttribute(k, v) { this.attrs[k] = v; } getAttribute(k) { return this.attrs[k] ?? null; } click() { this.clicked = true; } };
const { saveFile, shareFile, canShareFiles } = await import('../shared/files.js'); // ui.js inspects `document` when it loads, so no fake one until after
// Just enough of a browser for toast() and the file reader:
const el = () => ({ setAttribute() {}, addEventListener() {}, append() {}, remove() {}, nodeType: 1, className: '' });
globalThis.document = { createElement: el, createTextNode: () => ({ nodeType: 3 }), body: { append() {} }, getElementById: () => null };
globalThis.FileReader = class { readAsDataURL(b) { b.arrayBuffer().then((ab) => { this.result = `data:;base64,${Buffer.from(ab).toString('base64')}`; this.onload(); }, (e) => this.onerror(e)); } };

test('a file is sent to the Android app in pieces and arrives byte for byte', async () => {
  const bytes = randomBytes(1_000_003); // not a multiple of the piece size
  assert.equal(await saveFile(new Blob([bytes]), 'statement.pdf', 'application/pdf'), 'saved');
  assert.equal(got.name, 'statement.pdf'); assert.equal(got.action, 'save'); assert.ok(got.chunks.length > 2);
  assert.ok(Buffer.concat(got.chunks).equals(bytes));
  assert.equal(await shareFile(new Blob(['hi']), 'song.png', { type: 'image/png', title: 'x' }), 'shared'); assert.equal(got.action, 'share');
  assert.equal(canShareFiles(), true);
});

test('a blob download link clicked inside the app is saved, without fetch() (the site CSP blocks blob: requests)', async () => {
  const realFetch = globalThis.fetch; globalThis.fetch = () => { throw new Error('fetch must not be used'); };
  try {
    const bytes = Buffer.from('date,amount\n2026-11-02,100\n'), a = new HTMLAnchorElement();
    a.setAttribute('href', URL.createObjectURL(new Blob([bytes], { type: 'text/csv' }))); a.setAttribute('download', 'orbit.csv');
    a.click(); await new Promise((r) => setTimeout(r, 30));
    assert.equal(got.name, 'orbit.csv'); assert.ok(Buffer.concat(got.chunks).equals(bytes)); assert.equal(a.clicked, false); // the browser's own click was not used
    const d = new HTMLAnchorElement(); d.setAttribute('href', 'data:text/plain;base64,aGVsbG8='); d.setAttribute('download', 'hello.txt'); d.click(); await new Promise((r) => setTimeout(r, 30));
    assert.equal(Buffer.concat(got.chunks).toString(), 'hello');
    const plain = new HTMLAnchorElement(); plain.setAttribute('href', '/somewhere'); plain.click(); assert.equal(plain.clicked, true); // ordinary links are untouched
  } finally { globalThis.fetch = realFetch; }
});

test('an old Android app without the file bridge says so instead of failing silently', async () => {
  const keep = globalThis.UniverseNative; globalThis.UniverseNative = {};
  try { await assert.rejects(saveFile(new Blob(['x']), 'a.txt'), /newest Android app/); await assert.rejects(shareFile(new Blob(['x']), 'a.png'), /newest Android app/); }
  finally { globalThis.UniverseNative = keep; }
});
