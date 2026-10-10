// Finance PIN and unlock sessions.
//
// What this protects, honestly: it stops someone who has your signed-in phone/browser (or a stolen Universe session cookie)
// from reading or changing your finances. It is an ACCESS GATE enforced on the server for every sensitive route, not
// encryption: the data is stored as plain JSON in your private GitHub repo, so anyone with that repo, the Vercel
// project or the GitHub token can read it. Keep those private.
//
// Design (fits Vercel: no long-lived memory, no sticky instances):
//  - The PIN is never stored. We store scrypt(HMAC(pepper, pin), salt). The pepper comes from the server's environment,
//    NOT from the data repo, so a leak of the data file alone cannot be brute-forced offline (6-digit PINs are tiny).
//  - Failed attempts and delays are stored in the database (not in memory), so they hold across serverless instances.
//  - An unlock session is a signed, expiring cookie bound to this user AND this Universe session. Idle expiry slides
//    without writing to the database. Locking (or changing the PIN) sets `revokedBefore`, which kills every device's token.
//  - There is no client "unlocked" flag anywhere: the browser only ever holds an HttpOnly cookie it cannot read or forge.
import { scrypt, randomBytes, timingSafeEqual, createHmac, hkdfSync } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from '../../../shared/errors.js';
import { parseCookies, serializeCookie } from '../../../http/http.js';

const scryptAsync = promisify(scrypt);
const N = 32768, R = 8, P = 1, KEYLEN = 64, MAXMEM = 128 * N * R * 2;
export const COOKIE = 'orbit_unlock';
export const PIN_RE = /^\d{6,12}$/;
export const DEFAULTS = { idleMinutes: 5, maxSessionHours: 12, lockWhenHiddenSec: 0 };

// failures -> seconds you must wait before the next try (none for the first 4 wrong PINs)
const delaySec = (f) => (f < 5 ? 0 : f >= 10 ? 86400 : [30, 60, 300, 900, 3600][f - 5]);
export { delaySec };

export function weakPin(pin) {
  if (!PIN_RE.test(pin)) return 'Use 6 to 12 digits';
  if (/^(\d)\1+$/.test(pin)) return 'Do not use the same digit repeated';
  const d = [...pin].map(Number);
  if (d.every((x, i) => i === 0 || x === d[i - 1] + 1) || d.every((x, i) => i === 0 || x === d[i - 1] - 1)) return 'Do not use an obvious sequence like 123456';
  if (/^(\d\d)\1+$/.test(pin)) return 'Do not use a repeating pattern';
  return null;
}

export class PinService {
  constructor({ storage, config, audit }) {
    this.col = storage.collection('finance_security');
    this.config = config; this.audit = audit; this.prod = !!config.production;
    this.mutex = new Map();
  }
  keys() {
    const material = this.config.finance?.secret || this.config.ai?.keyEncryptionSecret || '';
    if (material.length < 32) throw new HttpError(503, 'Orbit needs a server secret before a PIN can be created. Set KEY_ENCRYPTION_SECRET (or FINANCE_SECRET) to a random value of at least 32 characters.', 'finance_not_configured');
    const k = (info) => Buffer.from(hkdfSync('sha256', Buffer.from(material, 'utf8'), Buffer.from('orbit-by-universe'), info, 32));
    return { pepper: k('pin-pepper'), sign: k('unlock-session') };
  }
  async hash(pin) {
    const { pepper } = this.keys(), salt = randomBytes(16);
    const pre = createHmac('sha256', pepper).update(pin).digest();
    const h = await scryptAsync(pre, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
    return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${h.toString('base64')}`;
  }
  async check(pin, stored) {
    if (typeof pin !== 'string' || typeof stored !== 'string') return false;
    const [alg, n, r, p, saltB, hashB] = stored.split('$');
    if (alg !== 'scrypt' || !hashB) return false;
    const { pepper } = this.keys(), pre = createHmac('sha256', pepper).update(pin).digest(), expected = Buffer.from(hashB, 'base64');
    const actual = await scryptAsync(pre, Buffer.from(saltB, 'base64'), expected.length, { N: +n, r: +r, p: +p, maxmem: MAXMEM });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  get(userId) { return this.col.get(userId); }
  async status(userId) {
    const d = await this.get(userId);
    return { hasPin: !!d?.pinHash, idleMinutes: d?.idleMinutes ?? DEFAULTS.idleMinutes, maxSessionHours: d?.maxSessionHours ?? DEFAULTS.maxSessionHours, lockWhenHiddenSec: d?.lockWhenHiddenSec ?? DEFAULTS.lockWhenHiddenSec };
  }
  // One attempt at a time per user inside this process, so parallel requests cannot all read "0 failures".
  async serial(userId, fn) {
    const prev = this.mutex.get(userId) || Promise.resolve();
    const run = prev.then(fn, fn);
    this.mutex.set(userId, run.catch(() => {}));
    return run;
  }
  lockedFor(d, field = 'lockedUntil') { const ms = (d?.[field] || 0) - Date.now(); return ms > 0 ? Math.ceil(ms / 1000) : 0; }
  tooMany(sec) { return new HttpError(429, `Too many wrong PIN attempts. Try again in ${sec < 90 ? `${sec} seconds` : `${Math.ceil(sec / 60)} minutes`}.`, 'pin_locked', { 'Retry-After': String(sec) }); }

  async setup(userId, pin) {
    const weak = weakPin(pin); if (weak) throw new HttpError(400, weak, 'weak_pin');
    const existing = await this.get(userId);
    if (existing?.pinHash) throw new HttpError(409, 'A Finance PIN already exists. Change it instead.', 'pin_exists');
    const pinHash = await this.hash(pin), now = Date.now();
    const doc = { pinHash, pinSetAt: now, failures: 0, lockedUntil: 0, lastFailureAt: 0, revokedBefore: 0, idleMinutes: DEFAULTS.idleMinutes, maxSessionHours: DEFAULTS.maxSessionHours, lockWhenHiddenSec: DEFAULTS.lockWhenHiddenSec, resetFailures: 0, resetLockedUntil: 0 };
    if (existing) await this.col.update(userId, doc); else await this.col.insert({ id: userId, ...doc });
  }
  // Verifies a PIN with persisted, escalating lockout. The failure is recorded BEFORE the error is thrown and outside any
  // storage transaction (a rollback would erase it).
  verify(userId, pin) {
    return this.serial(userId, async () => {
      const d = await this.get(userId);
      if (!d?.pinHash) throw new HttpError(409, 'Create a Finance PIN first.', 'no_pin');
      const wait = this.lockedFor(d); if (wait) throw this.tooMany(wait);
      let failures = d.failures || 0; if (failures && Date.now() - (d.lastFailureAt || 0) > 86400_000) failures = 0; // old failures fade after a quiet day
      if (typeof pin !== 'string' || !PIN_RE.test(pin) || !(await this.check(pin, d.pinHash))) {
        failures++; const sec = delaySec(failures);
        await this.col.update(userId, { failures, lastFailureAt: Date.now(), lockedUntil: sec ? Date.now() + sec * 1000 : 0 });
        await this.audit.record({ actorId: userId, action: 'finance.pin_failed', meta: { failures } }).catch(() => {});
        if (sec) throw this.tooMany(sec);
        throw new HttpError(401, `Wrong PIN. ${5 - failures} ${5 - failures === 1 ? 'try' : 'tries'} left before a short lock.`, 'bad_pin');
      }
      if (d.failures || d.lockedUntil) await this.col.update(userId, { failures: 0, lockedUntil: 0 });
      return d;
    });
  }
  async change(userId, current, next) {
    const weak = weakPin(next); if (weak) throw new HttpError(400, weak, 'weak_pin');
    await this.verify(userId, current);
    await this.col.update(userId, { pinHash: await this.hash(next), pinSetAt: Date.now(), revokedBefore: Date.now() });
  }
  // Forgot the PIN: prove you own the Universe account with its password (limited and persisted like PIN attempts).
  reset(userId, next, passwordOk) {
    return this.serial(`reset:${userId}`, async () => {
      const weak = weakPin(next); if (weak) throw new HttpError(400, weak, 'weak_pin');
      const d = await this.get(userId);
      if (!d?.pinHash) throw new HttpError(409, 'There is no PIN to reset.', 'no_pin');
      const wait = this.lockedFor(d, 'resetLockedUntil'); if (wait) throw this.tooMany(wait);
      if (!(await passwordOk())) {
        const f = (d.resetFailures || 0) + 1, sec = delaySec(f + 2);
        await this.col.update(userId, { resetFailures: f, resetLockedUntil: sec ? Date.now() + sec * 1000 : 0 });
        if (sec) throw this.tooMany(sec);
        throw new HttpError(401, 'That password is not correct.', 'bad_password');
      }
      await this.col.update(userId, { pinHash: await this.hash(next), pinSetAt: Date.now(), revokedBefore: Date.now(), failures: 0, lockedUntil: 0, resetFailures: 0, resetLockedUntil: 0 });
    });
  }
  async lockEverywhere(userId) { if (await this.get(userId)) await this.col.update(userId, { revokedBefore: Date.now() }); }
  async saveSettings(userId, patch) { await this.col.update(userId, patch); }

  // ---- unlock cookie ----
  sign(payload) { const body = Buffer.from(JSON.stringify(payload)).toString('base64url'); return `${body}.${createHmac('sha256', this.keys().sign).update(body).digest('base64url')}`; }
  unsign(token) {
    if (typeof token !== 'string' || token.length > 600) return null;
    const [body, mac] = token.split('.'); if (!body || !mac) return null;
    const want = createHmac('sha256', this.keys().sign).update(body).digest();
    let got; try { got = Buffer.from(mac, 'base64url'); } catch { return null; }
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  }
  cookie(payload, maxAgeSec) { return serializeCookie(COOKIE, this.sign(payload), { maxAge: maxAgeSec, httpOnly: true, secure: this.prod, sameSite: 'Strict', path: '/api/apps/finance' }); }
  clearCookie() { return serializeCookie(COOKIE, '', { maxAge: 0, httpOnly: true, secure: this.prod, sameSite: 'Strict', path: '/api/apps/finance' }); }
  issue(res, user, session, d) {
    const now = Math.max(Date.now(), (d.revokedBefore || 0) + 1); // always strictly after a revocation
    res.setHeader('Set-Cookie', this.cookie({ v: 1, u: user.id, s: session.id, iat: now, seen: now }, Math.floor((d.maxSessionHours ?? DEFAULTS.maxSessionHours) * 3600)));
  }
  // Called on EVERY sensitive request. Returns the security doc, or throws 423 (locked).
  async authorize(req, res, user, session) {
    const locked = (why) => new HttpError(423, 'Orbit is locked. Enter your Finance PIN.', 'locked', { 'X-Orbit-Reason': why });
    const d = await this.get(user.id);
    if (!d?.pinHash) throw new HttpError(423, 'Create a Finance PIN to use Orbit.', 'no_pin');
    const tok = this.unsign(parseCookies(req.headers.cookie)[COOKIE]);
    if (!tok || tok.v !== 1) throw locked('no_session');
    const now = Date.now(), idle = (d.idleMinutes ?? DEFAULTS.idleMinutes) * 60_000, max = (d.maxSessionHours ?? DEFAULTS.maxSessionHours) * 3600_000;
    if (tok.u !== user.id || tok.s !== session.id) throw locked('wrong_session');
    if (!(tok.iat > (d.revokedBefore || 0)) || tok.iat < (d.pinSetAt || 0)) throw locked('revoked');
    if (now - tok.seen > idle) throw locked('idle');
    if (now - tok.iat > max) throw locked('expired');
    if (now - tok.seen > 15_000) res.setHeader('Set-Cookie', this.cookie({ ...tok, seen: now }, Math.max(60, Math.floor((max - (now - tok.iat)) / 1000)))); // slide the idle window; no database write
    return d;
  }
}
