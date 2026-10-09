import { HttpError } from '../shared/errors.js';

export function applySecurityHeaders(res, production) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; connect-src 'self' https://api.cloudinary.com; img-src 'self' data: https://res.cloudinary.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

// In-memory, per-process. Fine for one server; replace with a shared store if you ever run several.
export class RateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs; this.max = max; this.hits = new Map();
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref();
  }
  check(key) {
    const now = Date.now(); const e = this.hits.get(key);
    if (!e || e.reset <= now) return { allowed: true, retryAfterSec: 0 };
    return { allowed: e.count < this.max, retryAfterSec: Math.ceil((e.reset - now) / 1000) };
  }
  hit(key) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || e.reset <= now) { e = { count: 0, reset: now + this.windowMs }; this.hits.set(key, e); }
    e.count++;
    return { allowed: e.count <= this.max, retryAfterSec: Math.ceil((e.reset - now) / 1000) };
  }
  reset(key) { this.hits.delete(key); }
  sweep() { const now = Date.now(); for (const [k, e] of this.hits) if (e.reset <= now) this.hits.delete(k); }
  stop() { clearInterval(this.timer); }
}

export const tooMany = (retryAfterSec) =>
  new HttpError(429, 'Too many requests. Try again later.', 'rate_limited', { 'Retry-After': String(retryAfterSec) });

// With TRUST_PROXY=true, use the rightmost X-Forwarded-For entry (the one added by YOUR single proxy).
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',').pop().trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

// CSRF defence in depth: SameSite=Lax cookie + a custom header that cross-site pages cannot send
// without a CORS preflight (which we never allow) + Origin check.
export function checkCsrf(req, config) {
  if (req.headers['x-requested-with'] !== 'universe') throw new HttpError(403, 'Missing X-Requested-With header', 'csrf');
  const origin = req.headers.origin;
  if (origin) {
    const proto = (config.trustProxy && req.headers['x-forwarded-proto']) || (req.socket.encrypted ? 'https' : 'http');
    const allowed = new Set([`${proto}://${req.headers.host}`, ...config.allowedOrigins]);
    if (!allowed.has(origin)) throw new HttpError(403, 'Origin not allowed', 'csrf');
  }
}
