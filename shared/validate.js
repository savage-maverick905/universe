// Tiny dependency-free validators. Every one throws HttpError(400) on bad input.
import { HttpError } from './errors.js';

const fail = (msg) => { throw new HttpError(400, msg, 'validation_error'); };

export const v = {
  object(x, name = 'body') {
    if (!x || typeof x !== 'object' || Array.isArray(x)) fail(`${name} must be an object`);
    return x;
  },
  string(x, name, { min = 0, max = 1000, trim = true } = {}) {
    if (typeof x !== 'string') fail(`${name} must be a string`);
    const s = trim ? x.trim() : x;
    if (s.length < min || s.length > max) fail(`${name} must be ${min}-${max} characters`);
    return s;
  },
  email(x, name = 'email') {
    const s = v.string(x, name, { min: 3, max: 254 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) fail(`${name} is not a valid email address`);
    return s;
  },
  id(x, name) {
    const s = v.string(x, name, { min: 2, max: 64 });
    if (!/^[a-z][a-z0-9_]*$/.test(s)) fail(`${name} must be lowercase letters, digits and underscores`);
    return s;
  },
  anyId(x, name) {
    const s = v.string(x, name, { min: 1, max: 100 });
    if (!/^[A-Za-z0-9_-]+$/.test(s)) fail(`${name} is not a valid id`);
    return s;
  },
  enum(x, name, list) {
    if (!list.includes(x)) fail(`${name} must be one of: ${list.join(', ')}`);
    return x;
  },
  stringArray(x, name, { max = 200, itemMax = 100 } = {}) {
    if (!Array.isArray(x) || x.length > max) fail(`${name} must be an array of at most ${max} items`);
    return [...new Set(x.map((i, n) => v.string(i, `${name}[${n}]`, { min: 1, max: itemMax })))];
  },
  httpsUrl(x, name, max = 500) {
    const s = v.string(x, name, { min: 1, max });
    let u;
    try { u = new URL(s); } catch { fail(`${name} must be a valid URL`); }
    if (u.protocol !== 'https:') fail(`${name} must be an https URL`);
    return s;
  },
};

// Reject unknown keys so clients cannot smuggle fields (e.g. roleId, ownerId) into updates.
export function allowKeys(obj, allowed, name = 'body') {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail(`Unknown field in ${name}: ${k}`);
  return obj;
}
