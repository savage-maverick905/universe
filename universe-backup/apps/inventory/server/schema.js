import { v, allowKeys } from '../../../shared/validate.js';
import { HttpError } from '../../../shared/errors.js';

export const STATUSES = { in_use: 'In use', not_in_use: 'Not in use', lost: 'Lost', lent_out: 'Lent out', given_away: 'Given away',
  sold: 'Sold', damaged: 'Damaged', under_repair: 'Under repair', disposed: 'Disposed', stolen: 'Stolen' };
export const CONDITIONS = { new: 'New', good: 'Good', fair: 'Fair', poor: 'Poor', broken: 'Broken' };
export const METHODS = { purchased: 'Purchased', gift: 'Gift', found: 'Found', made: 'Made', inherited: 'Inherited', other: 'Other' };
export const ATTENTION = ['lost', 'damaged', 'under_repair', 'stolen'];

const bad = (m) => new HttpError(400, m, 'validation_error');
const nil = (x) => x == null || x === '';
const F = {
  req: (max) => (x, n) => v.string(x, n, { min: 1, max }),
  text: (max) => (x, n) => (x == null ? '' : v.string(x, n, { max })),
  opt: (max) => (x, n) => (nil(x) ? null : v.string(x, n, { max })),
  id: () => (x, n) => (nil(x) ? null : v.anyId(x, n)),
  ids: (max) => (x, n) => (x == null ? [] : v.stringArray(x, n, { max })),
  tags: () => (x, n) => (x == null ? [] : v.stringArray(Array.isArray(x) ? x.map((t) => (typeof t === 'string' ? t.toLowerCase() : t)) : x, n, { max: 20, itemMax: 40 })),
  enum: (list) => (x, n) => v.enum(x, n, list),
  nenum: (list) => (x, n) => (nil(x) ? null : v.enum(x, n, list)),
  date: () => (x, n) => { if (nil(x)) return null; if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x) || Number.isNaN(Date.parse(x))) throw bad(`${n} must be a date like 2026-01-15`); return x; },
  num: () => (x, n) => { if (nil(x)) return null; if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1e12) throw bad(`${n} must be a non-negative number`); return x; },
  cur: () => (x, n) => { if (nil(x)) return null; if (typeof x !== 'string' || !/^[A-Za-z]{3}$/.test(x)) throw bad(`${n} must be a 3-letter currency code`); return x.toUpperCase(); },
};
const SPEC = {
  identity: { name: F.req(120), description: F.text(2000), categoryId: F.id(), tags: F.tags() },
  status: { state: F.enum(Object.keys(STATUSES)), reason: F.text(300) },
  location: { type: F.enum(['home', 'work', 'storage', 'with_someone', 'other']), locationId: F.id() },
  acquisition: { method: F.nenum(Object.keys(METHODS)), date: F.date(), source: F.opt(200), price: F.num(), currency: F.cur() },
  condition: { state: F.enum(Object.keys(CONDITIONS)), notes: F.text(500) },
  identification: { brand: F.opt(100), model: F.opt(100), modelNumber: F.opt(100), serialNumber: F.opt(100), imei: F.opt(32) },
  relationships: { parentItemId: F.id(), relatedItems: F.ids(50) },
};

export const blankItem = () => ({
  identity: { name: '', description: '', categoryId: null, tags: [] },
  status: { state: 'in_use', reason: '' }, location: { type: 'home', locationId: null },
  acquisition: { method: null, date: null, source: null, price: null, currency: null },
  condition: { state: 'good', notes: '' },
  identification: { brand: null, model: null, modelNumber: null, serialNumber: null, imei: null },
  media: { images: [], documents: [] }, relationships: { parentItemId: null, relatedItems: [] }, notes: '',
});

// Images must be Cloudinary assets (and from OUR cloud when configured). Only metadata is stored.
export function parseImages(list, cloudName) {
  if (!Array.isArray(list) || list.length > 10) throw bad('media.images must be an array of at most 10 images');
  return list.map((im, i) => {
    const n = `media.images[${i}]`;
    allowKeys(v.object(im, n), ['publicId', 'secureUrl', 'resourceType', 'width', 'height', 'format', 'uploadedAt'], n);
    const url = v.httpsUrl(im.secureUrl, `${n}.secureUrl`);
    const u = new URL(url);
    if (u.hostname !== 'res.cloudinary.com' || (cloudName && !u.pathname.startsWith(`/${cloudName}/`))) throw bad(`${n}.secureUrl must be a Cloudinary URL for this ecosystem`);
    const dim = (x, k) => (Number.isInteger(x) && x > 0 && x <= 30000 ? x : (() => { throw bad(`${n}.${k} is invalid`); })());
    return { publicId: v.string(im.publicId, `${n}.publicId`, { min: 1, max: 200 }), secureUrl: url, resourceType: v.enum(im.resourceType ?? 'image', `${n}.resourceType`, ['image']),
      width: dim(im.width, 'width'), height: dim(im.height, 'height'), format: v.string(im.format, `${n}.format`, { min: 1, max: 10 }),
      uploadedAt: v.string(im.uploadedAt, `${n}.uploadedAt`, { max: 40 }) };
  });
}

// Validates only the provided fields. Unknown sections/fields are rejected (no smuggling ownerId, id, history...).
export function parseItemPatch(b, { cloudName = '' } = {}) {
  allowKeys(v.object(b), [...Object.keys(SPEC), 'media', 'notes']);
  const out = {};
  for (const [sec, fields] of Object.entries(SPEC)) {
    if (b[sec] === undefined) continue;
    const input = allowKeys(v.object(b[sec], sec), Object.keys(fields), sec);
    out[sec] = {};
    for (const [k, val] of Object.entries(input)) out[sec][k] = fields[k](val, `${sec}.${k}`);
  }
  if (b.media !== undefined) {
    const m = allowKeys(v.object(b.media, 'media'), ['images'], 'media');
    out.media = {}; if ('images' in m) out.media.images = parseImages(m.images, cloudName);
  }
  if ('notes' in b) out.notes = F.text(5000)(b.notes, 'notes');
  return out;
}

export function mergeItem(base, patch) {
  const out = { ...base };
  for (const [k, val] of Object.entries(patch)) out[k] = (val && typeof val === 'object' && !Array.isArray(val)) ? { ...base[k], ...val } : val;
  return out;
}
export const parseName = (x, name, max = 80) => F.req(max)(x, name);
export const parseParent = F.id();
