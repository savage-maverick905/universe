// SQLite driver using Node's built-in node:sqlite (no native npm dependency).
// Each collection is a table: id, JSON document, timestamps.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*){0,3}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const OPS = { $lt: '<', $lte: '<=', $gt: '>', $gte: '>=' };

// Field names are validated by regex before being interpolated, so queries stay injection-safe.
function fieldExpr(field) {
  if (!FIELD_RE.test(field)) throw new Error(`Invalid field name: ${field}`);
  return field === 'id' ? 'id' : `json_extract(data,'$.${field}')`;
}
function bindValue(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return v;
  throw new Error('Unsupported filter value type');
}
function buildWhere(where = {}) {
  const clauses = [];
  const params = [];
  for (const [field, cond] of Object.entries(where)) {
    const expr = fieldExpr(field);
    if (cond === null) clauses.push(`${expr} IS NULL`);
    else if (typeof cond === 'object' && !Array.isArray(cond)) {
      for (const [op, val] of Object.entries(cond)) {
        if (op === '$in') {
          if (!Array.isArray(val)) throw new Error('$in needs an array');
          if (val.length === 0) { clauses.push('0'); continue; }
          clauses.push(`${expr} IN (${val.map(() => '?').join(',')})`);
          params.push(...val.map(bindValue));
        } else if (OPS[op]) {
          clauses.push(`${expr} ${OPS[op]} ?`);
          params.push(bindValue(val));
        } else throw new Error(`Unsupported operator: ${op}`);
      }
    } else {
      clauses.push(`${expr} = ?`);
      params.push(bindValue(cond));
    }
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

class SqliteCollection {
  constructor(db, name, indexes = []) {
    this.db = db;
    this.name = name;
    this.table = `c_${name}`;
    db.exec(`CREATE TABLE IF NOT EXISTS ${this.table} (
      id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    this.ensureIndexes(indexes);
  }
  ensureIndexes(indexes = []) {
    for (const f of indexes) {
      fieldExpr(f);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${this.name}_${f.replace(/\./g, '_')}
        ON ${this.table} (json_extract(data,'$.${f}'))`);
    }
  }
  _prepare(doc) {
    if (!doc || typeof doc !== 'object' || !ID_RE.test(doc.id || '')) throw new Error('Document needs a valid string id');
    const now = new Date().toISOString();
    const out = { ...doc, createdAt: doc.createdAt || now, updatedAt: doc.updatedAt || now };
    return out;
  }
  async insert(doc) {
    const d = this._prepare(doc);
    try {
      this.db.prepare(`INSERT INTO ${this.table} (id,data,created_at,updated_at) VALUES (?,?,?,?)`)
        .run(d.id, JSON.stringify(d), d.createdAt, d.updatedAt);
    } catch (e) {
      if (/UNIQUE|PRIMARY KEY/i.test(e.message)) { const err = new Error(`Duplicate id: ${d.id}`); err.code = 'DUPLICATE_ID'; throw err; }
      throw e;
    }
    return d;
  }
  async upsert(doc) {
    const d = this._prepare(doc);
    this.db.prepare(`INSERT INTO ${this.table} (id,data,created_at,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`)
      .run(d.id, JSON.stringify(d), d.createdAt, d.updatedAt);
    return d;
  }
  async get(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    const row = this.db.prepare(`SELECT data FROM ${this.table} WHERE id = ?`).get(id);
    return row ? JSON.parse(row.data) : null;
  }
  async find({ where = {}, orderBy, limit = 100, offset = 0 } = {}) {
    const w = buildWhere(where);
    let sql = `SELECT data FROM ${this.table} ${w.sql}`;
    if (orderBy) sql += ` ORDER BY ${fieldExpr(orderBy.field)} ${orderBy.dir === 'desc' ? 'DESC' : 'ASC'}`;
    sql += ' LIMIT ? OFFSET ?';
    const lim = Math.min(Math.max(1, Math.trunc(limit)), 10000);
    const off = Math.max(0, Math.trunc(offset));
    return this.db.prepare(sql).all(...w.params, lim, off).map((r) => JSON.parse(r.data));
  }
  async count(where = {}) {
    const w = buildWhere(where);
    return Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${this.table} ${w.sql}`).get(...w.params).n);
  }
  async update(id, patch) {
    const old = await this.get(id);
    if (!old) return null;
    const d = { ...old, ...patch, id: old.id, createdAt: old.createdAt, updatedAt: new Date().toISOString() };
    this.db.prepare(`UPDATE ${this.table} SET data=?, updated_at=? WHERE id=?`).run(JSON.stringify(d), d.updatedAt, id);
    return JSON.parse(JSON.stringify(d));
  }
  async delete(id) {
    return this.db.prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id).changes > 0;
  }
  async deleteWhere(where = {}) {
    const w = buildWhere(where);
    return Number(this.db.prepare(`DELETE FROM ${this.table} ${w.sql}`).run(...w.params).changes);
  }
}

export class SqliteStorage {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this._cols = new Map();
    this._chain = Promise.resolve();
  }
  collection(name, { indexes = [] } = {}) {
    if (!NAME_RE.test(name)) throw new Error(`Invalid collection name: ${name}`);
    let c = this._cols.get(name);
    if (!c) { c = new SqliteCollection(this.db, name, indexes); this._cols.set(name, c); }
    else if (indexes.length) c.ensureIndexes(indexes);
    return c;
  }
  // Transactions are serialized. The callback must not await anything except storage calls,
  // otherwise unrelated requests could interleave inside the transaction.
  transaction(fn) {
    const run = async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const r = await fn(this);
        this.db.exec('COMMIT');
        return r;
      } catch (e) {
        try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      }
    };
    const p = this._chain.then(run);
    this._chain = p.catch(() => {});
    return p;
  }
  async exportAll({ exclude = ['sessions'], pageSize = 5000 } = {}) {
    const names = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'c\\_%' ESCAPE '\\'")
      .all().map((r) => r.name.slice(2));
    const collections = {};
    for (const n of names) {
      if (exclude.includes(n)) continue;
      const docs = [];
      for (let offset = 0; ; offset += pageSize) { // page through everything; never truncate silently
        const page = await this.collection(n).find({ orderBy: { field: 'id' }, limit: pageSize, offset });
        docs.push(...page);
        if (page.length < pageSize) break;
      }
      collections[n] = docs;
    }
    return { format: 'universe-export', schemaVersion: 1, exportedAt: new Date().toISOString(), collections };
  }
  async importAll(data, { mode = 'merge' } = {}) {
    if (!data || data.format !== 'universe-export' || typeof data.collections !== 'object') throw new Error('Not a Universe export');
    if (data.schemaVersion !== 1) throw new Error(`Unsupported schemaVersion ${data.schemaVersion}`);
    await this.transaction(async () => {
      for (const [name, docs] of Object.entries(data.collections)) {
        const col = this.collection(name);
        if (mode === 'replace') await col.deleteWhere({});
        for (const d of docs) await col.upsert(d);
      }
    });
  }
  close() { this.db.close(); }
}
