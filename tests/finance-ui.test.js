// Renders every Orbit screen against the REAL API using a tiny fake DOM, to catch runtime errors (undefined variables, bad API shapes).
// It is not a browser test: layout, taps and styling are not checked.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { startTestApp, closeAll } from './helpers.js';
// Browser code imports '/shared/...'; map that onto the repository folder for this test only.
const root = new URL('..', import.meta.url).href;
register(`data:text/javascript,export async function resolve(s,c,n){return s.startsWith('/shared/')?n(${JSON.stringify(root)}+s.slice(1),c):n(s,c)}`);
after(() => closeAll());

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.style = { setProperty() {} }; this.listeners = {}; this.className = ''; this.hidden = false; this.value = ''; this.nodeType = 1; this.textContent_ = ''; this.classList = { add() {}, remove() {}, contains() { return false; }, toggle() {} }; }
  get textContent() { return this.textContent_ + this.children.map((c) => c.textContent ?? '').join(''); } set textContent(v) { this.textContent_ = String(v); this.children = []; }
  append(...k) { for (const c of k) this.children.push(c); } replaceChildren(...k) { this.children = [...k]; this.textContent_ = ''; } remove() {} focus() {} click() {} showModal() {} close() {} scrollTo() {}
  setAttribute(k, v) { this.attrs[k] = v; } getAttribute(k) { return this.attrs[k]; } addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
  querySelector() { return null; } querySelectorAll() { return []; } closest() { return null; } get firstChild() { return this.children[0]; } get lastChild() { return this.children[this.children.length - 1]; }
  set innerHTML(v) { this.children = []; } get id() { return this.attrs.id; } set id(v) { this.attrs.id = v; }
}
const text = (e) => (e == null ? '' : e.nodeType === 3 ? e.data : e.textContent);
globalThis.document = { createElement: (t) => new El(t), createElementNS: (n, t) => new El(t), createTextNode: (d) => ({ nodeType: 3, data: String(d), get textContent() { return this.data; } }), body: new El('body'), documentElement: new El('html'), addEventListener() {}, getElementById: () => new El('div'), querySelector: () => null, querySelectorAll: () => [], hidden: false };
Object.assign(globalThis, { window: globalThis, location: { hash: '', pathname: '/apps/finance/' }, history: { replaceState() {} }, addEventListener() {}, scrollTo() {}, matchMedia: () => ({ matches: false }), URL: Object.assign(URL, { createObjectURL: () => 'blob:x' }) });
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true, userAgent: 'x', platform: 'x', maxTouchPoints: 0 }, configurable: true });
Object.defineProperty(globalThis, 'crypto', { value: globalThis.crypto, configurable: true });

test('every Orbit screen renders against the real API without runtime errors', async () => {
  const t = await startTestApp({}, { providers: { fake: { id: 'fake', async chat() { return { content: 'hello', toolCalls: [], usage: null }; } } } });
  const admin = await t.login('admin@example.com', 'correct-horse-battery'); await t.request('POST', '/api/apps/finance/install', { cookie: admin.cookie });
  const su = await t.request('POST', '/api/apps/finance/pin/setup', { cookie: admin.cookie, body: { pin: '482915', confirm: '482915' } });
  const jar = `${admin.cookie}; ${su.headers.get('set-cookie').split(';')[0]}`, realFetch = fetch;
  const api = (m, p, b) => t.request(m, `/api/apps/finance${p}`, { cookie: jar, body: b });
  globalThis.fetch = async (url, init = {}) => realFetch(String(url).startsWith('/') ? `http://127.0.0.1:${t.app.server.address().port}${url}` : url, { ...init, headers: { ...(init.headers || {}), Cookie: jar } });
  const a = (await api('POST', '/accounts', { name: 'OPay', openingBalance: '10,000' })).json.account, b = (await api('POST', '/accounts', { name: 'PalmPay' })).json.account;
  const cat = (await api('GET', '/categories')).json.categories.find((c) => c.name === 'Groceries').id;
  await api('POST', '/transactions', { type: 'expense', amount: '1,000', accountId: a.id, categoryId: cat, description: 'Rice', idempotencyKey: 'ui-key-0001' });
  await api('POST', '/transactions', { type: 'transfer', amount: '500', accountId: a.id, toAccountId: b.id, idempotencyKey: 'ui-key-0002' });
  await api('POST', '/budgets', { categoryId: cat, period: 'monthly', amount: '5,000' }); await api('POST', '/goals', { name: 'Laptop', target: '100,000' });
  await api('POST', '/debts', { direction: 'lent', counterparty: 'Ada', amount: '2,000', accountId: a.id, idempotencyKey: 'ui-debt-0001' });
  const { loadBase } = await import('../apps/finance/lib/forms.js'); const { setCurrencies } = await import('../apps/finance/lib/fmt.js'); const S = await loadBase(); setCurrencies(S.meta.currencies);
  const shown = []; const frame = (page, ...content) => shown.push([page, content.flat(5).map(text).join(' ')]); const goto = () => {}; const state = { me: { user: { displayName: 'Admin', email: 'a@x' }, permissions: [] }, session: { idleMinutes: 5, lockWhenHiddenSec: 0 } };
  const run = async (mod, extra = {}) => { shown.length = 0; await (await import(`../apps/finance/views/${mod}.js`)).render({ frame, goto, state, rest: [], ...extra }); assert.equal(shown.length, 1, mod); return shown[0][1]; };
  assert.match(await run('home'), /Total balance[\s\S]*₦7,000\.00/); assert.match(await run('home'), /Rice|Recent/);
  assert.match(await run('activity'), /Activity/); assert.match(await run('accounts'), /OPay[\s\S]*PalmPay/); assert.match(await run('categories'), /Groceries/);
  for (const tab of ['budgets', 'debts', 'goals', 'bills', 'networth']) { await run('plan', { rest: [tab] }); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); }
  assert.match(await run('reports'), /Reports/); assert.match(await run('assistant'), /Assistant/); assert.match(await run('settings', { page: 'settings' }), /Settings/); assert.match(await run('settings', { page: 'more' }), /Accounts/);
  await run('accounts', { rest: [a.id] });
  globalThis.fetch = realFetch;
});
