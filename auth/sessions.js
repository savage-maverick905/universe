import { createHash, randomBytes } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Tokens are random and opaque. Only a SHA-256 of the token is stored, so a database leak
// does not yield usable session cookies.
export class SessionService {
  constructor(storage, { ttlHours = 168 } = {}) {
    this.col = storage.collection('sessions', { indexes: ['userId', 'expiresAt'] });
    this.ttlMs = ttlHours * 3600_000;
  }
  async create(userId, { ip = null, userAgent = null } = {}) {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const doc = await this.col.insert({
      id: sha256(token), userId, ip, userAgent: userAgent ? String(userAgent).slice(0, 200) : null,
      expiresAt: new Date(now + this.ttlMs).toISOString(),
    });
    return { token, session: doc, maxAgeSec: Math.floor(this.ttlMs / 1000) };
  }
  async validate(token) {
    if (typeof token !== 'string' || token.length !== 43) return null;
    const s = await this.col.get(sha256(token));
    if (!s) return null;
    if (new Date(s.expiresAt).getTime() <= Date.now()) { await this.col.delete(s.id); return null; }
    return s;
  }
  destroy(token) { return this.col.delete(sha256(token)); }
  async destroyAllForUser(userId, { exceptId = null } = {}) {
    const all = await this.col.find({ where: { userId }, limit: 10000 });
    for (const s of all) if (s.id !== exceptId) await this.col.delete(s.id);
  }
  purgeExpired() { return this.col.deleteWhere({ expiresAt: { $lt: new Date().toISOString() } }); }
}
