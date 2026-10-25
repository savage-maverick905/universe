// Jupiter's media store: where audio parts, artwork and analytics files live. NEVER the Universe data branch.
//
// Interface (both drivers):
//   putBlob(buffer)                       -> ref        content-addressed, not part of any tree yet
//   getBlob(ref)                          -> Buffer
//   commit({ add:[{path,ref}], remove:[path], message }) -> { head }   atomic: all changes or none
//   readFile(path)                        -> Buffer | null
//   head()                                -> string|null   id of the current tip
//   rebuildHistory({ message })           -> { skipped } | { before, after, treeSha }   squash history, same files
//   usage()                               -> { files, bytes }  (what the tree holds; used for the library quota)
//
// GitHub driver: Git Data API on a dedicated branch (default "jupiter-media"), created as an ORPHAN branch so it shares no history with
// the Universe data branch. Uses only Node's fetch. The token is sent to api.github.com only and never appears in errors or logs.
// Filesystem driver: for local development and tests (no network). Same semantics, files under JUPITER_MEDIA_DIR.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { HttpError } from '../../../shared/errors.js';

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9._\/-]{1,100}$/;
const PATH_RE = /^(tracks|art|analytics)\/[A-Za-z0-9_./-]{1,200}$|^README\.md$/;
const urlPath = (p) => p.split('/').map(encodeURIComponent).join('/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function assertMediaPath(p) {
  if (typeof p !== 'string' || p.includes('..') || p.includes('//') || p.startsWith('/') || !PATH_RE.test(p)) throw new Error('Invalid media path');
  return p;
}

// ---------------------------------------------------------------- GitHub
export class GithubMediaStore {
  kind = 'github';
  constructor({ token, repo, branch = 'jupiter-media', protectedBranches = [], fetch: fetchFn = globalThis.fetch, apiUrl = 'https://api.github.com', retryMs = 400, log = console }) {
    if (!token) throw new Error('A GitHub token is required for Jupiter media storage');
    if (!REPO_RE.test(repo || '')) throw new Error('JUPITER_MEDIA_REPO / GITHUB_REPO must look like owner/name');
    if (!BRANCH_RE.test(branch)) throw new Error('JUPITER_MEDIA_BRANCH has invalid characters');
    if (protectedBranches.includes(branch)) throw new Error(`JUPITER_MEDIA_BRANCH must not be "${branch}" (that branch holds other data)`);
    Object.assign(this, { token, repo, branch, fetchFn, apiUrl, retryMs, log });
    this._lock = Promise.resolve();
    this._blobCache = new Map(); // ref -> Buffer, tiny LRU for seeking within a track
    this._cacheBytes = 0;
  }
  async _gh(method, path, body, headers = {}) {
    let res;
    try {
      res = await this.fetchFn(`${this.apiUrl}${path}`, { method, body: body ? JSON.stringify(body) : undefined,
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'universe-jupiter',
          ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } });
    } catch (e) { throw this._err(0, 'could not reach GitHub', e.cause?.code || e.message); }
    return res;
  }
  _err(status, what, detail = '') {
    const e = new Error(`GitHub ${what} failed${status ? ` (${status})` : ''}${detail ? `: ${String(detail).slice(0, 160)}` : ''}`); e.status = status; return e;
  }
  async _fail(res, what) { let m = ''; try { m = (await res.json()).message || ''; } catch { /* no body */ } return this._err(res.status, what, m); }
  get _r() { return `/repos/${this.repo}`; }

  async _head() { // -> { commit, tree } | null when the branch does not exist yet
    const ref = await this._gh('GET', `${this._r}/git/ref/heads/${urlPath(this.branch)}`);
    if (ref.status === 404) return null;
    if (!ref.ok) throw await this._fail(ref, 'reading the media branch');
    const commit = (await ref.json()).object.sha;
    const c = await this._gh('GET', `${this._r}/git/commits/${commit}`);
    if (!c.ok) throw await this._fail(c, 'reading the media commit');
    return { commit, tree: (await c.json()).tree.sha };
  }
  async head() { return (await this._head())?.commit || null; }

  async putBlob(buffer) {
    const res = await this._gh('POST', `${this._r}/git/blobs`, { content: Buffer.from(buffer).toString('base64'), encoding: 'base64' });
    if (!res.ok) throw await this._fail(res, 'storing a file');
    return (await res.json()).sha;
  }
  async getBlob(ref) {
    if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error('Invalid blob reference');
    const hit = this._blobCache.get(ref);
    if (hit) { this._blobCache.delete(ref); this._blobCache.set(ref, hit); return hit; }
    let last;
    for (let i = 0; i < 3; i++) {
      const res = await this._gh('GET', `${this._r}/git/blobs/${ref}`, null, { Accept: 'application/vnd.github.raw+json' });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        this._blobCache.set(ref, buf); this._cacheBytes += buf.length;
        while (this._cacheBytes > 24 * 1024 * 1024 && this._blobCache.size > 1) { const [k, v] = this._blobCache.entries().next().value; this._blobCache.delete(k); this._cacheBytes -= v.length; }
        return buf;
      }
      last = await this._fail(res, 'reading a file');
      if (res.status === 404) { last.missing = true; break; }
      if (res.status < 500 && res.status !== 429 && res.status !== 403) break;
      await sleep(this.retryMs * 2 ** i);
    }
    throw last;
  }
  async readFile(path) {
    assertMediaPath(path);
    const res = await this._gh('GET', `${this._r}/contents/${urlPath(path)}?ref=${encodeURIComponent(this.branch)}`, null, { Accept: 'application/vnd.github.raw+json' });
    if (res.status === 404) return null;
    if (!res.ok) throw await this._fail(res, 'reading a file');
    return Buffer.from(await res.arrayBuffer());
  }

  // One commit, serialized in this process; retried if another writer moved the branch in between (fast-forward only: never forced).
  commit(change) { const p = this._lock.then(() => this._commit(change)); this._lock = p.catch(() => {}); return p; }
  async _commit({ add = [], remove = [], message = 'Jupiter media update' }) {
    add.forEach((a) => assertMediaPath(a.path)); remove.forEach(assertMediaPath);
    const entries = [
      ...add.map((a) => ({ path: a.path, mode: '100644', type: 'blob', sha: a.ref })),
      ...remove.map((p) => ({ path: p, mode: '100644', type: 'blob', sha: null })),
    ];
    let last;
    for (let attempt = 0; attempt < 6; attempt++) {
      const head = await this._head();
      const tree = await this._gh('POST', `${this._r}/git/trees`, { ...(head ? { base_tree: head.tree } : {}), tree: head ? entries : entries.filter((e) => e.sha) });
      if (!tree.ok) throw await this._fail(tree, 'building the media tree');
      const treeSha = (await tree.json()).sha;
      const commit = await this._gh('POST', `${this._r}/git/commits`, { message, tree: treeSha, parents: head ? [head.commit] : [] });
      if (!commit.ok) throw await this._fail(commit, 'saving the media commit');
      const sha = (await commit.json()).sha;
      const upd = head
        ? await this._gh('PATCH', `${this._r}/git/refs/heads/${urlPath(this.branch)}`, { sha, force: false })
        : await this._gh('POST', `${this._r}/git/refs`, { ref: `refs/heads/${this.branch}`, sha });
      if (upd.ok) return { head: sha };
      last = await this._fail(upd, 'updating the media branch');
      if (upd.status !== 422 && upd.status !== 409) break; // 422/409: someone else moved the branch; try again on top of it
      await sleep(this.retryMs * (attempt + 1) + Math.random() * 200);
    }
    throw last;
  }

  // Squash history: ONE new root commit that points at the SAME tree, then move this branch to it.
  // Only ever touches `this.branch`. Refuses to run if the tree would differ. History rewrites cannot guarantee that GitHub
  // erases old objects immediately: old commits can stay reachable by their hash until GitHub garbage-collects them.
  rebuildHistory({ message = 'Jupiter media: history rebuilt (files unchanged)' } = {}) { const p = this._lock.then(() => this._rebuild(message)); this._lock = p.catch(() => {}); return p; }
  async _rebuild(message) {
    const head = await this._head();
    if (!head) return { skipped: 'The media branch does not exist yet.' };
    const c = await this._gh('GET', `${this._r}/git/commits/${head.commit}`);
    if (!c.ok) throw await this._fail(c, 'reading the media commit');
    if (!(await c.json()).parents?.length) return { skipped: 'History is already a single commit.' };
    const made = await this._gh('POST', `${this._r}/git/commits`, { message, tree: head.tree, parents: [] });
    if (!made.ok) throw await this._fail(made, 'creating the new root commit');
    const after = (await made.json()).sha;
    const chk = await this._gh('GET', `${this._r}/git/commits/${after}`);
    if (!chk.ok || (await chk.json()).tree.sha !== head.tree) throw new Error('Rebuild aborted: the new commit does not hold the same files.');
    const now = await this._head();
    if (now.commit !== head.commit) return { skipped: 'The branch changed while rebuilding; nothing was changed. It will be retried next time.' };
    const upd = await this._gh('PATCH', `${this._r}/git/refs/heads/${urlPath(this.branch)}`, { sha: after, force: true });
    if (!upd.ok) throw await this._fail(upd, 'moving the media branch');
    return { before: head.commit, after, treeSha: head.tree };
  }
  async list() {
    const head = await this._head();
    if (!head) return [];
    const res = await this._gh('GET', `${this._r}/git/trees/${head.tree}?recursive=1`);
    if (!res.ok) throw await this._fail(res, 'reading the media tree');
    return ((await res.json()).tree || []).filter((e) => e.type === 'blob').map((e) => ({ path: e.path, size: e.size || 0, ref: e.sha }));
  }
  async usage() {
    const head = await this._head();
    if (!head) return { files: 0, bytes: 0 };
    const res = await this._gh('GET', `${this._r}/git/trees/${head.tree}?recursive=1`);
    if (!res.ok) throw await this._fail(res, 'reading the media tree');
    const j = await res.json();
    let files = 0, bytes = 0;
    for (const e of j.tree || []) if (e.type === 'blob') { files++; bytes += e.size || 0; }
    return { files, bytes, truncated: !!j.truncated };
  }
}

// ---------------------------------------------------------------- Filesystem (local development, tests)
export class FsMediaStore {
  kind = 'fs';
  constructor({ dir }) { this.dir = dir; this._lock = Promise.resolve(); this._tree = null; }
  async _load() {
    if (this._tree) return this._tree;
    try { this._tree = JSON.parse(await readFile(join(this.dir, 'tree.json'), 'utf8')); } catch { this._tree = { rev: 0, files: {} }; }
    return this._tree;
  }
  async _save() {
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, `tree.${randomBytes(4).toString('hex')}.tmp`);
    await writeFile(tmp, JSON.stringify(this._tree)); await rename(tmp, join(this.dir, 'tree.json'));
  }
  _blobPath(ref) { if (!/^[0-9a-f]{64}$/.test(ref)) throw new Error('Invalid blob reference'); return join(this.dir, 'blobs', ref.slice(0, 2), ref); }
  async head() { const t = await this._load(); return t.rev ? `fs${t.rev}` : null; }
  async putBlob(buffer) {
    const ref = sha256(buffer), p = this._blobPath(ref);
    await mkdir(dirname(p), { recursive: true }); await writeFile(p, buffer);
    return ref;
  }
  async getBlob(ref) { try { return await readFile(this._blobPath(ref)); } catch (e) { const err = new Error('File not found in media storage'); err.missing = true; throw err; } }
  async readFile(path) { assertMediaPath(path); const t = await this._load(); const ref = t.files[path]; if (!ref) return null; try { return await this.getBlob(ref); } catch { return null; } }
  commit(change) { const p = this._lock.then(() => this._commit(change)); this._lock = p.catch(() => {}); return p; }
  async _commit({ add = [], remove = [] }) {
    add.forEach((a) => assertMediaPath(a.path)); remove.forEach(assertMediaPath);
    const t = await this._load(), before = { ...t.files };
    try {
      for (const a of add) { await stat(this._blobPath(a.ref)); t.files[a.path] = a.ref; }
      for (const p of remove) delete t.files[p];
      t.rev++; await this._save();
    } catch (e) { t.files = before; throw e; }
    const used = new Set(Object.values(t.files)); // drop blobs nothing points at any more
    for (const p of remove) { const ref = before[p]; if (ref && !used.has(ref)) await rm(this._blobPath(ref), { force: true }); }
    return { head: `fs${t.rev}` };
  }
  async rebuildHistory() { return { skipped: 'The filesystem store keeps no history.' }; }
  async list() { const t = await this._load(); const out = []; for (const [path, ref] of Object.entries(t.files)) { let size = 0; try { size = (await stat(this._blobPath(ref))).size; } catch { /* missing */ } out.push({ path, size, ref }); } return out; }
  async usage() {
    const t = await this._load(); let bytes = 0, files = 0;
    for (const ref of Object.values(t.files)) { try { bytes += (await stat(this._blobPath(ref))).size; files++; } catch { /* missing */ } }
    return { files, bytes };
  }
  async listBlobs() { const out = []; try { for (const d of await readdir(join(this.dir, 'blobs'))) for (const f of await readdir(join(this.dir, 'blobs', d))) out.push(f); } catch { /* none */ } return out; }
}

export function createMediaStore(config, { log = console, fetch } = {}) {
  const j = config.jupiter || {};
  const gh = config.storage?.github || {};
  const wantGithub = j.driver ? j.driver === 'github' : config.storage?.driver === 'github';
  if (wantGithub) {
    return new GithubMediaStore({ token: j.token || gh.token, repo: j.repo || gh.repo, branch: j.branch || 'jupiter-media', protectedBranches: [gh.branch, 'main', 'master'].filter(Boolean), fetch, log });
  }
  return new FsMediaStore({ dir: j.dir || './data/jupiter-media' });
}
export { HttpError };
