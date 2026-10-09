// GitHub driver: the whole database lives in memory and is saved as ONE JSON file in a (private!) GitHub repo.
//
//   - Reads and queries run against memory, so they are fast and never touch the network.
//   - Writes change memory immediately and are committed to GitHub shortly after, in batches
//     (at most one commit per `flushMs`). close() flushes, so a normal shutdown loses nothing.
//   - Built for ONE server instance. Two servers writing the same file would overwrite each other.
//   - SERVERLESS MODE (`serverless: true`, used on Vercel): there is no long-lived process, so nothing is saved on a timer.
//     The host calls refresh() before each request (a cheap conditional GET; 304 when nothing changed) and awaits flush()
//     before it answers. If someone else changed the file in between, the save is refused (status 409) instead of overwriting it.
//   - The file uses the same format as `npm run export`, so you can move data between drivers.
//
// Uses only the GitHub REST "contents" API and Node's built-in fetch. The token never appears in logs or errors.
const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*){0,3}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9._\/-]{1,100}$/;
const FORMAT = 'universe-export';

const json = (v) => JSON.parse(JSON.stringify(v)); // same value rules as the SQLite driver (undefined dropped)
const norm = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v);
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
const urlPath = (p) => p.split('/').map(encodeURIComponent).join('/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function field(f) {
  if (!FIELD_RE.test(f)) throw new Error(`Invalid field name: ${f}`);
  return f;
}
function scalar(v) {
  if (typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return norm(v);
  throw new Error('Unsupported filter value type');
}
// SQLite ordering: NULL < numbers < text.
const rank = (v) => (v == null ? 0 : typeof v === 'number' || typeof v === 'bigint' ? 1 : 2);
function compare(a, b) {
  a = norm(a); b = norm(b);
  if (a != null && typeof a === 'object') a = JSON.stringify(a);
  if (b != null && typeof b === 'object') b = JSON.stringify(b);
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  return a < b ? -1 : a > b ? 1 : 0;
}
const CMP = { $lt: (c) => c < 0, $lte: (c) => c <= 0, $gt: (c) => c > 0, $gte: (c) => c >= 0 };

function compile(where = {}) {
  const tests = [];
  for (const [f, cond] of Object.entries(where)) {
    field(f);
    if (cond === null) tests.push((d) => getPath(d, f) == null);
    else if (typeof cond === 'object' && !Array.isArray(cond)) {
      for (const [op, val] of Object.entries(cond)) {
        if (op === '$in') {
          if (!Array.isArray(val)) throw new Error('$in needs an array');
          const set = val.map(scalar);
          tests.push((d) => set.includes(norm(getPath(d, f))));
        } else if (CMP[op]) {
          const bound = scalar(val);
          tests.push((d) => { const a = norm(getPath(d, f)); return a != null && typeof a !== 'object' && CMP[op](compare(a, bound)); });
        } else throw new Error(`Unsupported operator: ${op}`);
      }
    } else { const want = scalar(cond); tests.push((d) => norm(getPath(d, f)) === want); }
  }
  return (d) => tests.every((t) => t(d));
}

class GithubCollection {
  constructor(store, name) { this.store = store; this.name = name; this.docs = new Map(); }
  ensureIndexes(indexes = []) { for (const f of indexes) field(f); } // memory scans need no indexes
  _prepare(doc) {
    if (!doc || typeof doc !== 'object' || !ID_RE.test(doc.id || '')) throw new Error('Document needs a valid string id');
    const now = new Date().toISOString();
    return json({ ...doc, createdAt: doc.createdAt || now, updatedAt: doc.updatedAt || now });
  }
  async insert(doc) {
    const d = this._prepare(doc);
    if (this.docs.has(d.id)) { const err = new Error(`Duplicate id: ${d.id}`); err.code = 'DUPLICATE_ID'; throw err; }
    this.docs.set(d.id, d); this.store._touch(this.name);
    return structuredClone(d);
  }
  async upsert(doc) {
    const d = this._prepare(doc);
    this.docs.set(d.id, d); this.store._touch(this.name);
    return structuredClone(d);
  }
  async get(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    const d = this.docs.get(id);
    return d ? structuredClone(d) : null;
  }
  async find({ where = {}, orderBy, limit = 100, offset = 0 } = {}) {
    const test = compile(where);
    let rows = [...this.docs.values()].filter(test);
    if (orderBy) {
      const f = field(orderBy.field), sign = orderBy.dir === 'desc' ? -1 : 1;
      rows = rows.map((d, i) => [d, i]).sort((x, y) => sign * compare(getPath(x[0], f), getPath(y[0], f)) || x[1] - y[1]).map(([d]) => d);
    }
    const lim = Math.min(Math.max(1, Math.trunc(limit)), 10000), off = Math.max(0, Math.trunc(offset));
    return rows.slice(off, off + lim).map((d) => structuredClone(d));
  }
  async count(where = {}) {
    const test = compile(where);
    let n = 0; for (const d of this.docs.values()) if (test(d)) n++;
    return n;
  }
  async update(id, patch) {
    const old = typeof id === 'string' ? this.docs.get(id) : null;
    if (!old) return null;
    const d = json({ ...old, ...patch, id: old.id, createdAt: old.createdAt, updatedAt: new Date().toISOString() });
    this.docs.set(id, d); this.store._touch(this.name);
    return structuredClone(d);
  }
  async delete(id) {
    const had = this.docs.delete(id);
    if (had) this.store._touch(this.name);
    return had;
  }
  async deleteWhere(where = {}) {
    const test = compile(where);
    let n = 0;
    for (const [id, d] of [...this.docs]) if (test(d)) { this.docs.delete(id); n++; }
    if (n) this.store._touch(this.name);
    return n;
  }
}

export class GithubStorage {
  static async open(opts) {
    const s = new GithubStorage(opts);
    await s._load();
    return s;
  }
  constructor({ token, repo, branch = 'universe-data', path = 'universe-data.json', flushMs = 3000, retryMs = 500, ephemeral = [], serverless = false,
    apiUrl = 'https://api.github.com', fetch: fetchFn = globalThis.fetch, log = console } = {}) {
    if (!token) throw new Error('GITHUB_TOKEN is required for the github storage driver');
    if (!REPO_RE.test(repo || '')) throw new Error('GITHUB_REPO must look like owner/name');
    if (!BRANCH_RE.test(branch)) throw new Error('GITHUB_BRANCH has invalid characters');
    if (!path || path.startsWith('/') || path.includes('..')) throw new Error('GITHUB_DATA_PATH must be a relative file path');
    Object.assign(this, { token, repo, branch, path, flushMs, retryMs, apiUrl, fetchFn, log, serverless });
    this._etag = null; this._stale = false;
    this.ephemeral = new Set(ephemeral);
    this._cols = new Map();
    this._chain = Promise.resolve();   // serializes transactions
    this._writeChain = Promise.resolve(); // serializes commits
    this._timer = null; this._dirty = false; this._sha = null; this._lastText = null; this._closed = false;
  }

  // ---- GitHub API ----
  async _gh(method, path, body, headers = {}) {
    try {
      return await this.fetchFn(`${this.apiUrl}${path}`, {
        method, body: body ? JSON.stringify(body) : undefined,
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'universe-storage', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      });
    } catch (e) { throw new Error(`GitHub request failed: ${e.cause?.code || e.message}`); }
  }
  async _fail(res, what) {
    let msg = ''; try { msg = (await res.json()).message || ''; } catch { /* no body */ }
    const err = new Error(`GitHub ${what} failed (${res.status})${msg ? `: ${msg}` : ''}`); err.status = res.status;
    return err;
  }
  get _contents() { return `/repos/${this.repo}/contents/${urlPath(this.path)}`; }

  async _ensureBranch() {
    const b = await this._gh('GET', `/repos/${this.repo}/branches/${urlPath(this.branch)}`);
    if (b.ok) return;
    if (b.status !== 404) throw await this._fail(b, 'branch lookup');
    const r = await this._gh('GET', `/repos/${this.repo}`);
    if (!r.ok) throw await this._fail(r, 'repository lookup');
    const def = (await r.json()).default_branch;
    const ref = await this._gh('GET', `/repos/${this.repo}/git/ref/heads/${urlPath(def)}`);
    if (!ref.ok) throw await this._fail(ref, 'reading the default branch (is the repo empty? add a README first)');
    const created = await this._gh('POST', `/repos/${this.repo}/git/refs`, { ref: `refs/heads/${this.branch}`, sha: (await ref.json()).object.sha });
    if (!created.ok && created.status !== 422) throw await this._fail(created, 'creating the data branch'); // 422: it already exists
  }

  async _load() {
    if (!this.serverless) await this._ensureBranch(); // serverless: only when the first read says the branch may be missing
    await this._pull(true);
  }
  // Reads the data file into memory. After the first read, an unchanged file (304) costs one tiny request and changes nothing.
  async _pull(first = false) {
    const q = `${this._contents}?ref=${encodeURIComponent(this.branch)}`;
    const res = await this._gh('GET', q, null, !first && this._etag ? { 'If-None-Match': this._etag } : {});
    if (res.status === 304) return false;
    if (res.status === 404) {
      if (this.serverless && first) await this._ensureBranch(); // the branch itself may be what is missing
      this._clear(); this._sha = null; this._lastText = null; this._etag = null; this._stale = false; return true; // first run: nothing saved yet
    }
    if (!res.ok) throw await this._fail(res, 'loading data');
    const etag = res.headers?.get?.('etag') || null;
    const j = await res.json();
    let text;
    if (j.encoding === 'base64' && typeof j.content === 'string') text = Buffer.from(j.content, 'base64').toString('utf8');
    else { // files over 1 MB are not inlined; ask for the raw body
      const raw = await this._gh('GET', q, null, { Accept: 'application/vnd.github.raw+json' });
      if (!raw.ok) throw await this._fail(raw, 'loading data');
      text = await raw.text();
    }
    let data; try { data = JSON.parse(text); } catch { throw new Error(`${this.path} on branch ${this.branch} is not valid JSON; refusing to start so it is not overwritten`); }
    if (data.format !== FORMAT || typeof data.collections !== 'object') throw new Error(`${this.path} is not a Universe data file; refusing to start`);
    this._clear();
    for (const [name, docs] of Object.entries(data.collections)) {
      const col = this.collection(name);
      for (const d of docs) col.docs.set(d.id, d);
    }
    this._sha = j.sha; this._lastText = text; this._etag = etag; this._stale = false;
    return true;
  }
  _clear() { for (const c of this._cols.values()) c.docs = new Map(); }
  // Serverless hosts call this before each request. Does nothing while this instance holds unsaved changes.
  async refresh() {
    if (this._dirty && !this._stale) return false;
    return this._pull(false);
  }

  // ---- saving ----
  _touch(name) {
    if (this.ephemeral.has(name)) return;
    this._dirty = true;
    if (!this.serverless && !this._timer && !this._closed) {
      this._timer = setTimeout(() => { this._timer = null; this.flush().catch((e) => this.log.error?.(`Saving to GitHub failed: ${e.message}`)); }, this.flushMs);
      this._timer.unref?.();
    }
  }
  _serialize() {
    const parts = [];
    for (const name of [...this._cols.keys()].sort()) {
      if (this.ephemeral.has(name)) continue;
      const docs = [...this._cols.get(name).docs.values()];
      if (docs.length) parts.push(`${JSON.stringify(name)}:[\n${docs.map((d) => JSON.stringify(d)).join(',\n')}\n]`); // one document per line = readable git diffs
    }
    return `{"format":"${FORMAT}","schemaVersion":1,"collections":{\n${parts.join(',\n')}\n}}\n`;
  }
  flush() {
    clearTimeout(this._timer); this._timer = null;
    const p = this._writeChain.then(() => this._write());
    this._writeChain = p.catch(() => {});
    return p;
  }
  async _refreshSha() {
    const res = await this._gh('GET', `${this._contents}?ref=${encodeURIComponent(this.branch)}`);
    if (res.status === 404) { this._sha = null; return; }
    if (!res.ok) throw await this._fail(res, 'reading the file version');
    this._sha = (await res.json()).sha;
  }
  async _write() {
    if (!this._dirty) return;
    this._dirty = false; // anything written while we save sets it again
    const text = this._serialize();
    if (text === this._lastText) return;
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await this._gh('PUT', this._contents, {
          message: `Universe data update ${new Date().toISOString()}`, branch: this.branch,
          content: Buffer.from(text, 'utf8').toString('base64'), ...(this._sha ? { sha: this._sha } : {}),
        });
        if (res.ok) { this._sha = (await res.json()).content.sha; this._lastText = text; this._etag = null; return; }
        if (this.serverless && (res.status === 409 || res.status === 422)) { // someone else saved first: do NOT overwrite; drop our copy and reload next time
          this._dirty = false; this._stale = true; this._etag = null;
          const err = await this._fail(res, 'saving data'); err.status = 409; err.conflict = true;
          throw err;
        }
        if (res.status === 409 || res.status === 422) { // file changed under us, or sha missing
          this.log.warn?.('GitHub data file changed outside this server; overwriting it with this server\'s copy.');
          await this._refreshSha(); lastErr = await this._fail(res, 'saving data'); continue;
        }
        lastErr = await this._fail(res, 'saving data');
        if (res.status < 500 && res.status !== 429 && res.status !== 403) break; // 401/404 etc: retrying will not help
      } catch (e) { lastErr = e; }
      await sleep(this.retryMs * 2 ** attempt);
    }
    this._dirty = true; // keep the data and try again later
    if (this.serverless) { this._dirty = false; this._stale = true; this._etag = null; throw lastErr; } // the next request reloads from GitHub
    if (!this._closed) {
      this._timer = setTimeout(() => { this._timer = null; this.flush().catch((e) => this.log.error?.(`Saving to GitHub failed: ${e.message}`)); }, Math.max(this.flushMs, 30_000));
      this._timer.unref?.();
    }
    throw lastErr;
  }

  // ---- storage interface ----
  collection(name, { indexes = [] } = {}) {
    if (!NAME_RE.test(name)) throw new Error(`Invalid collection name: ${name}`);
    let c = this._cols.get(name);
    if (!c) { c = new GithubCollection(this, name); this._cols.set(name, c); }
    if (indexes.length) c.ensureIndexes(indexes);
    return c;
  }
  // Serialized. If the callback throws, every change it made is undone.
  transaction(fn) {
    const run = async () => {
      const snap = new Map([...this._cols].map(([n, c]) => [n, new Map(c.docs)])); // documents are replaced, never edited in place
      try { return await fn(this); }
      catch (e) { for (const [n, c] of this._cols) c.docs = snap.get(n) ?? new Map(); this._dirty = true; throw e; }
    };
    const p = this._chain.then(run);
    this._chain = p.catch(() => {});
    return p;
  }
  async exportAll({ exclude = ['sessions'] } = {}) {
    const collections = {};
    for (const [n, c] of [...this._cols].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (exclude.includes(n)) continue;
      collections[n] = [...c.docs.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((d) => structuredClone(d));
    }
    return { format: FORMAT, schemaVersion: 1, exportedAt: new Date().toISOString(), collections };
  }
  async importAll(data, { mode = 'merge' } = {}) {
    if (!data || data.format !== FORMAT || typeof data.collections !== 'object') throw new Error('Not a Universe export');
    if (data.schemaVersion !== 1) throw new Error(`Unsupported schemaVersion ${data.schemaVersion}`);
    await this.transaction(async () => {
      for (const [name, docs] of Object.entries(data.collections)) {
        const col = this.collection(name);
        if (mode === 'replace') await col.deleteWhere({});
        for (const d of docs) await col.upsert(d);
      }
    });
  }
  // Saves anything pending. Async, unlike the SQLite driver, so callers should `await storage.close()`.
  async close() {
    if (this._closed) return;
    this._closed = true;
    clearTimeout(this._timer); this._timer = null;
    await this.flush();
  }
}
