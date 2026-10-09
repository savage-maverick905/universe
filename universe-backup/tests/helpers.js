import { loadConfig } from '../config/env.js';
import { createStorage } from '../database/storage.js';
import { createApp } from '../api/server.js';

const open = new Set();
export async function closeAll() { for (const c of [...open]) await c(); }

export async function startTestApp(overrides = {}, extra = {}) {
  const config = loadConfig({}, {
    storage: { driver: 'sqlite', sqlitePath: ':memory:' },
    bootstrap: { email: 'admin@example.com', password: 'correct-horse-battery' },
    rateLimits: { loginIp: { windowMs: 60000, max: 1000 }, global: { windowMs: 60000, max: 100000 } },
    ai: { defaultProvider: 'fake', defaultModel: 'fake-model', sharedKeys: { fake: 'SHARED-KEY-123' }, keyEncryptionSecret: 'ab'.repeat(32), groqBaseUrl: '' },
    ...overrides,
  });
  const storage = await createStorage(config.storage);
  const quiet = { info() {}, warn() {}, error() {} };
  const app = await createApp({ config, storage, log: quiet, ...extra });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  async function request(method, path, { body, cookie, headers = {}, raw } = {}) {
    const h = { 'X-Requested-With': 'universe', ...headers };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (cookie) h.Cookie = cookie;
    const res = await fetch(base + path, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  async function login(email, password) {
    const r = await request('POST', '/api/auth/login', { body: { email, password } });
    const set = r.headers.get('set-cookie');
    return { ...r, cookie: set ? set.split(';')[0] : null };
  }
  let closed = false;
  const close = async () => { if (closed) return; closed = true; open.delete(close); await app.close(); };
  open.add(close);
  return { app, request, login, close };
}
