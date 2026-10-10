// Orbit — by Universe. Personal finance app backend.
// Every route is under /api/apps/finance/, scoped to the signed-in user, and (except the PIN/unlock routes) requires BOTH
// a Universe session AND a valid unlock cookie, checked on every request. See pin.js for how and why.
import { HttpError, notFound } from '../../../shared/errors.js';
import { RateLimiter, tooMany } from '../../../http/middleware.js';
import { makeStore } from './store.js';
import { PinService } from './pin.js';
import { makeTxnService } from './txn.js';
import { securityRoutes } from './routes/security.js';
import { dataRoutes } from './routes/data.js';
import { planningRoutes } from './routes/planning.js';
import { insightRoutes } from './routes/insights.js';
import { portabilityRoutes } from './routes/portability.js';
import { assistantRoutes } from './routes/assistant.js';

export const P = '/api/apps/finance';

export function register({ router, services: s }) {
  const store = makeStore(s), pins = new PinService({ storage: s.storage, config: s.config, audit: s.audit }), txn = makeTxnService(store);
  const ipLimit = new RateLimiter({ windowMs: 15 * 60_000, max: 60 }); // extra brake on PIN guessing from one address (in memory; the persisted lockout is the real control)

  // can: Universe permission. open: no unlock needed (PIN setup, unlock, status). Everything else needs the unlock cookie.
  const guard = (perm, handler, { open = false, setup = true } = {}) => async (ctx) => {
    await s.permissions.assert(ctx.user, perm);
    let sec = null;
    if (!open) sec = await pins.authorize(ctx.req, ctx.res, ctx.user, ctx.session);
    if (setup) await store.ensureSetup(ctx.user);
    return handler({ ...ctx, sec });
  };
  const fx = { router, s, store, pins, txn, guard, ipLimit, tooMany, P };
  securityRoutes(fx); dataRoutes(fx); planningRoutes(fx); insightRoutes(fx); portabilityRoutes(fx); assistantRoutes(fx);
}
