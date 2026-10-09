import { v, allowKeys } from '../../shared/validate.js';
import { HttpError } from '../../shared/errors.js';
import { verifyPassword, dummyHash } from '../../auth/passwords.js';
import { UserService } from '../../auth/users.js';
import { serializeCookie, reply } from '../http.js';
import { tooMany } from '../middleware.js';

export const SESSION_COOKIE = 'universe_sid';

export async function describeSession(s, user) {
  return {
    user: UserService.self(user),
    permissions: await s.permissions.effectiveList(user),
    isAdmin: await s.permissions.isAdmin(user),
  };
}

export function authRoutes(router, s) {
  const cookie = (token, maxAge) =>
    serializeCookie(SESSION_COOKIE, token, { maxAge, httpOnly: true, secure: s.config.production, sameSite: 'Lax' });

  // What the sign-in screen needs to know before anyone is signed in.
  router.add('GET', '/api/auth/config', async () => ({ signupEnabled: (await s.authSettings.get()).signupEnabled }), { auth: false });

  // Public sign-up. New people get the configured role (never an admin-level one) and a signed-in session.
  router.add('POST', '/api/auth/register', async ({ req, body, ip }) => {
    const cfg = await s.authSettings.get();
    if (!cfg.signupEnabled) throw new HttpError(403, 'Sign-ups are closed. Ask an admin to create your account.', 'signup_closed');
    const hit = s.limiters.signup.hit(ip);
    if (!hit.allowed) throw tooMany(hit.retryAfterSec);
    const b = allowKeys(v.object(body), ['email', 'displayName', 'password']);
    const email = v.email(b.email);
    const displayName = b.displayName ? v.string(b.displayName, 'displayName', { min: 1, max: 80 }) : email.split('@')[0].slice(0, 80);
    const role = await s.permissions.getRole(cfg.signupRoleId);
    if (!role || role.permissions.includes('*')) throw new HttpError(500, 'Sign-ups are not set up correctly. Tell the admin.', 'signup_misconfigured');
    const created = await s.users.create({ email, displayName, password: b.password, roleId: role.id, denies: cfg.signupAllowAi ? [] : ['ai.use'] });
    await s.audit.record({ actorId: created.id, action: 'auth.register', targetType: 'user', targetId: created.id, ip });
    const { token, maxAgeSec } = await s.sessions.create(created.id, { ip, userAgent: req.headers['user-agent'] });
    return reply(201, await describeSession(s, created), { 'Set-Cookie': cookie(token, maxAgeSec) });
  }, { auth: false });

  router.add('POST', '/api/auth/login', async ({ req, body, ip }) => {
    const b = allowKeys(v.object(body), ['email', 'password']);
    const email = v.email(b.email);
    const password = v.string(b.password, 'password', { min: 1, max: 256, trim: false });

    const ipHit = s.limiters.loginIp.hit(ip);
    if (!ipHit.allowed) throw tooMany(ipHit.retryAfterSec);
    const em = s.limiters.loginEmail.check(email);
    if (!em.allowed) throw tooMany(em.retryAfterSec);

    const user = await s.users.getByEmail(email);
    const ok = user
      ? await verifyPassword(password, user.passwordHash)
      : (await verifyPassword(password, await dummyHash()), false);

    if (!ok || user.status !== 'active') {
      s.limiters.loginEmail.hit(email);
      await s.audit.record({ actorId: user?.id ?? null, action: 'auth.login', outcome: 'failure', ip,
        meta: { email, reason: !user ? 'unknown_email' : !ok ? 'bad_password' : 'disabled' } });
      // Same message for every failure: no account enumeration.
      throw new HttpError(401, 'Invalid email or password', 'invalid_credentials');
    }
    s.limiters.loginEmail.reset(email);
    const { token, maxAgeSec } = await s.sessions.create(user.id, { ip, userAgent: req.headers['user-agent'] });
    const updated = await s.users.update(user.id, { lastLoginAt: new Date().toISOString() });
    await s.audit.record({ actorId: user.id, action: 'auth.login', ip });
    return reply(200, await describeSession(s, updated), { 'Set-Cookie': cookie(token, maxAgeSec) });
  }, { auth: false });

  router.add('POST', '/api/auth/logout', async ({ session, user, ip }) => {
    await s.sessions.col.delete(session.id);
    await s.audit.record({ actorId: user.id, action: 'auth.logout', ip });
    return reply(200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
  });

  router.add('GET', '/api/auth/me', ({ user }) => describeSession(s, user));

  router.add('POST', '/api/auth/change-password', async ({ user, session, body, ip }) => {
    const b = allowKeys(v.object(body), ['currentPassword', 'newPassword']);
    const current = v.string(b.currentPassword, 'currentPassword', { min: 1, max: 256, trim: false });
    const rl = s.limiters.loginEmail.check(user.email);
    if (!rl.allowed) throw tooMany(rl.retryAfterSec);
    if (!(await verifyPassword(current, user.passwordHash))) {
      s.limiters.loginEmail.hit(user.email);
      throw new HttpError(401, 'Current password is incorrect', 'invalid_credentials');
    }
    await s.users.setPassword(user.id, b.newPassword);
    await s.sessions.destroyAllForUser(user.id, { exceptId: session.id }); // sign out everywhere else
    await s.audit.record({ actorId: user.id, action: 'auth.password_changed', targetType: 'user', targetId: user.id, ip });
    return { ok: true };
  });
}
