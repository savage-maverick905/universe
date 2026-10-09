import { HttpError } from '../shared/errors.js';

export const reply = (status, body, headers = {}) => ({ __reply: true, status, body, headers });

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, httpOnly = true, secure = false, sameSite = 'Lax', path = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  return c;
}

export async function readJsonBody(req, limit = 100 * 1024) {
  if (Number(req.headers['content-length']) > limit) throw new HttpError(413, 'Request body too large', 'too_large');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Request body too large', 'too_large');
    chunks.push(c);
  }
  if (size === 0) return {};
  const ct = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json', 'unsupported_media_type');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON', 'invalid_json'); }
}

export function sendJson(res, status, body, headers = {}) {
  for (const [k, val] of Object.entries(headers)) res.setHeader(k, val);
  if (body === undefined) { res.statusCode = status; return res.end(); }
  const data = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(data));
  res.end(data);
}
