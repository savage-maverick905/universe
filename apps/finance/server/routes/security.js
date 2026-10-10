import { v, allowKeys } from '../../../../shared/validate.js';
import { HttpError, badRequest } from '../../../../shared/errors.js';
import { verifyPassword } from '../../../../auth/passwords.js';
import { reply } from '../../../../http/http.js';
import { isValidTz, DEFAULT_TZ } from '../dates.js';
import { currencyInfo, CODE_RE } from '../money.js';

export function securityRoutes({ router, s, store, pins, guard, ipLimit, tooMany, P }) {
  const { col } = store;
  const use = (h, o) => guard('finance.access', h, o);

  router.add('GET', `${P}/session`, use(async ({ user, req, res, session }) => {
    const st = await pins.status(user.id); let unlocked = false;
    if (st.hasPin) { try { await pins.authorize(req, res, user, session); unlocked = true; } catch (e) { if (!(e instanceof HttpError) || e.status !== 423) throw e; } }
    return { hasPin: st.hasPin, unlocked, idleMinutes: st.idleMinutes, lockWhenHiddenSec: st.lockWhenHiddenSec, configured: !!(s.config.finance?.secret || s.config.ai?.keyEncryptionSecret || '').length };
  }, { open: true, setup: false }));

  router.add('POST', `${P}/pin/setup`, use(async ({ user, body, ip, res, session }) => {
    const b = allowKeys(v.object(body), ['pin', 'confirm']);
    if (b.pin !== b.confirm) throw badRequest('The two PINs do not match', 'pin_mismatch');
    await pins.setup(user.id, v.string(b.pin, 'pin', { max: 12, trim: false }));
    await s.audit.record({ actorId: user.id, action: 'finance.pin_set', ip });
    pins.issue(res, user, session, await pins.get(user.id));
    await store.ensureSetup(user);
    return reply(201, { ok: true, unlocked: true });
  }, { open: true, setup: false }));

  router.add('POST', `${P}/unlock`, use(async ({ user, body, ip, res, session }) => {
    const b = allowKeys(v.object(body), ['pin']);
    const g = ipLimit.hit(`${ip}:${user.id}`); if (!g.allowed) throw tooMany(g.retryAfterSec);
    await pins.verify(user.id, typeof b.pin === 'string' ? b.pin : '');
    pins.issue(res, user, session, await pins.get(user.id));
    await store.ensureSetup(user);
    return { ok: true, unlocked: true };
  }, { open: true, setup: false }));

  // Locking works even with an expired cookie. It revokes every device's unlock, not just this one.
  router.add('POST', `${P}/lock`, use(async ({ user, res }) => {
    await pins.lockEverywhere(user.id); res.setHeader('Set-Cookie', pins.clearCookie());
    return { ok: true, unlocked: false };
  }, { open: true, setup: false }));

  router.add('POST', `${P}/pin/change`, use(async ({ user, body, res, session, ip }) => {
    const b = allowKeys(v.object(body), ['current', 'next', 'confirm']);
    if (b.next !== b.confirm) throw badRequest('The two new PINs do not match', 'pin_mismatch');
    await pins.change(user.id, typeof b.current === 'string' ? b.current : '', typeof b.next === 'string' ? b.next : '');
    await s.audit.record({ actorId: user.id, action: 'finance.pin_changed', ip });
    pins.issue(res, user, session, await pins.get(user.id)); // this device stays unlocked; every other one is locked
    return { ok: true };
  }, { open: true, setup: false }));

  // Forgot the PIN: prove it is you with your Universe password. Your finance data is untouched; every device is locked.
  router.add('POST', `${P}/pin/reset`, use(async ({ user, body, res, session, ip }) => {
    const b = allowKeys(v.object(body), ['password', 'next', 'confirm']);
    if (b.next !== b.confirm) throw badRequest('The two new PINs do not match', 'pin_mismatch');
    const g = ipLimit.hit(`reset:${ip}:${user.id}`); if (!g.allowed) throw tooMany(g.retryAfterSec);
    await pins.reset(user.id, typeof b.next === 'string' ? b.next : '', async () => verifyPassword(typeof b.password === 'string' ? b.password : '', (await s.users.getById(user.id))?.passwordHash));
    await s.audit.record({ actorId: user.id, action: 'finance.pin_reset', ip });
    pins.issue(res, user, session, await pins.get(user.id));
    return { ok: true };
  }, { open: true, setup: false }));

  router.add('PUT', `${P}/lock-settings`, use(async ({ user, body }) => {
    const b = allowKeys(v.object(body), ['idleMinutes', 'lockWhenHiddenSec', 'maxSessionHours']), patch = {};
    const int = (x, n, lo, hi) => { if (!Number.isInteger(x) || x < lo || x > hi) throw badRequest(`${n} must be a whole number from ${lo} to ${hi}`); return x; };
    if ('idleMinutes' in b) patch.idleMinutes = int(b.idleMinutes, 'idleMinutes', 1, 60);
    if ('lockWhenHiddenSec' in b) patch.lockWhenHiddenSec = int(b.lockWhenHiddenSec, 'lockWhenHiddenSec', 0, 3600);
    if ('maxSessionHours' in b) patch.maxSessionHours = int(b.maxSessionHours, 'maxSessionHours', 1, 24);
    await pins.saveSettings(user.id, patch);
    return pins.status(user.id);
  }, {}));

  // ---- user settings (currency, time zone, week start, dashboard widget) ----
  router.add('GET', `${P}/settings`, use(async ({ user }) => { const { id, ownerId, ...rest } = await col.settings.get(user.id); return { settings: rest }; }));
  router.add('PATCH', `${P}/settings`, use(async ({ user, body }) => {
    const b = allowKeys(v.object(body), ['currency', 'timezone', 'weekStartsOn', 'customCurrencies', 'showOnDashboard']), patch = {};
    const cur = await col.settings.get(user.id);
    if ('customCurrencies' in b) {
      if (!Array.isArray(b.customCurrencies) || b.customCurrencies.length > 20) throw badRequest('customCurrencies must be a list of at most 20');
      patch.customCurrencies = b.customCurrencies.map((c) => { v.object(c, 'currency'); allowKeys(c, ['code', 'exp', 'symbol', 'name']);
        if (!CODE_RE.test(c.code || '')) throw badRequest('Currency code must be 3-5 capital letters'); if (![0, 2, 3].includes(c.exp)) throw badRequest('Currency decimals must be 0, 2 or 3');
        return { code: c.code, exp: c.exp, symbol: v.string(c.symbol ?? c.code, 'symbol', { min: 1, max: 6 }), name: v.string(c.name ?? c.code, 'name', { min: 1, max: 40 }) }; });
    }
    const custom = patch.customCurrencies ?? cur.customCurrencies;
    if ('currency' in b) { if (!currencyInfo(b.currency, custom)) throw badRequest('Unknown currency. Add it under custom currencies first.'); patch.currency = b.currency; }
    if ('timezone' in b) { if (!isValidTz(b.timezone)) throw badRequest('Unknown time zone, e.g. Africa/Lagos'); patch.timezone = b.timezone; }
    if ('weekStartsOn' in b) { if (![0, 1, 6].includes(b.weekStartsOn)) throw badRequest('weekStartsOn must be 0 (Sunday), 1 (Monday) or 6 (Saturday)'); patch.weekStartsOn = b.weekStartsOn; }
    if ('showOnDashboard' in b) { if (typeof b.showOnDashboard !== 'boolean') throw badRequest('showOnDashboard must be true or false'); patch.showOnDashboard = b.showOnDashboard; }
    const { id, ownerId, ...rest } = await col.settings.update(user.id, patch);
    return { settings: rest };
  }));
}
