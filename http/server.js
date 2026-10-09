import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { AppRegistry } from '../core/registry.js';
import { InstallService } from '../core/installer.js';
import { serveStatic } from './static.js';
import { loadAppModules } from '../core/appLoader.js';
import { appRoutes } from './routes/apps.js';
import { aiRoutes } from './routes/ai.js';
import { reportRoutes } from './routes/reports.js';
import { ReportRegistry } from '../core/reports.js';
import { ProviderRegistry } from '../ai/providers/index.js';
import { ToolRegistry } from '../ai/tools.js';
import { registerCoreTools } from '../ai/tools/core.js';
import { AiOrchestrator } from '../ai/orchestrator.js';
import { loadConfig, loadDotEnv } from '../config/env.js';
import { createStorage } from '../database/storage.js';
import { HttpError } from '../shared/errors.js';
import { AuditLog } from '../auth/audit.js';
import { PermissionRegistry, PermissionService } from '../auth/permissions.js';
import { SessionService } from '../auth/sessions.js';
import { UserService } from '../auth/users.js';
import { AuthSettings } from '../auth/authSettings.js';
import { ensureDefaultRoles, ensureBootstrapAdmin } from '../auth/bootstrap.js';
import { Router } from './router.js';
import { parseCookies, readJsonBody, sendJson } from './http.js';
import { RateLimiter, applySecurityHeaders, checkCsrf, clientIp, tooMany } from './middleware.js';
import { authRoutes, SESSION_COOKIE } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { adminRoutes } from './routes/admin.js';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export async function createApp({ config, storage, log = console, appsDir = join(ROOT, 'apps'), providers: extraProviders = {} }) {
  const registry = new PermissionRegistry();
  const apps = new AppRegistry({ appsDir, permissionRegistry: registry, log });
  const s = {
    config, storage, registry, log, apps,
    paths: { apps: appsDir, dashboard: join(ROOT, 'dashboard'), shared: join(ROOT, 'shared') },
    permissions: new PermissionService({ storage, registry }),
    audit: new AuditLog(storage),
    users: new UserService({ storage }),
    sessions: new SessionService(storage, config.session),
    limiters: {
      global: new RateLimiter(config.rateLimits.global),
      loginIp: new RateLimiter(config.rateLimits.loginIp),
      loginEmail: new RateLimiter(config.rateLimits.loginEmail),
      ai: new RateLimiter(config.rateLimits.ai),
      signup: new RateLimiter(config.rateLimits.signup),
    },
  };
  s.authSettings = new AuthSettings({ storage, config });
  s.installer = new InstallService({ storage, registry: apps, permissions: s.permissions, audit: s.audit });
  const tools = new ToolRegistry({ installer: s.installer, permissions: s.permissions, audit: s.audit, apps });
  registerCoreTools(tools);
  s.aiTools = tools;
  s.reports = new ReportRegistry({ installer: s.installer, permissions: s.permissions, apps });
  s.ai = { providers: new ProviderRegistry(config, extraProviders), tools };
  s.ai.orchestrator = new AiOrchestrator({ storage, config, providers: s.ai.providers, tools, audit: s.audit, services: s });
  await ensureDefaultRoles(storage);
  await ensureBootstrapAdmin({ users: s.users, config, audit: s.audit, log });

  const router = new Router();
  authRoutes(router, s);
  userRoutes(router, s);
  adminRoutes(router, s);
  aiRoutes(router, s);
  reportRoutes(router, s);
  appRoutes(router, { ...s, registry: apps, installer: s.installer });
  await loadAppModules({ router, services: s, apps, appsDir, log });

  const purge = setInterval(() => s.sessions.purgeExpired().catch(() => {}), 3600_000);
  purge.unref();

  const server = http.createServer((req, res) => handle(req, res, s, router));
  return {
    server, services: s, handler: (req, res) => handle(req, res, s, router),
    async close() {
      clearInterval(purge);
      Object.values(s.limiters).forEach((l) => l.stop());
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      await storage.close(); // the github driver saves pending changes here
    },
  };
}

async function authenticate(req, s) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const session = await s.sessions.validate(token);
  if (!session) return {};
  const user = await s.users.getById(session.userId);
  if (!user || user.status !== 'active') { await s.sessions.col.delete(session.id); return {}; }
  return { user, session };
}

async function handle(req, res, s, router) {
  applySecurityHeaders(res, s.config.production);
  const ip = clientIp(req, s.config.trustProxy);
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
    if (!url.pathname.startsWith('/api/')) {
      if (await serveStatic(req, res, url, s)) return;
      throw new HttpError(404, 'Not found', 'not_found');
    }

    const g = s.limiters.global.hit(ip);
    if (!g.allowed) throw tooMany(g.retryAfterSec);

    const m = router.match(req.method, url.pathname);
    if (!m) throw new HttpError(404, 'Not found', 'not_found');
    if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed', 'method_not_allowed');

    const changes = STATE_CHANGING.has(req.method);
    if (changes) checkCsrf(req, s.config);

    let auth = {};
    if (m.route.auth) {
      auth = await authenticate(req, s);
      if (!auth.user) throw new HttpError(401, 'Authentication required', 'unauthenticated');
    }
    const body = changes ? await readJsonBody(req, m.route.bodyLimit) : undefined;
    const result = await m.route.handler({
      req, res, params: m.params, query: url.searchParams, body, ip,
      user: auth.user, session: auth.session, services: s,
    });
    if (result?.__reply) sendJson(res, result.status, result.body, result.headers);
    else sendJson(res, 200, result);
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.status === 413) res.setHeader('Connection', 'close');
      return sendJson(res, e.status, { error: { code: e.code, message: e.message } }, e.headers || {});
    }
    s.log.error?.('Unhandled error:', e);
    sendJson(res, 500, { error: { code: 'internal_error', message: 'Internal server error' } });
  }
}

// Run directly: node http/server.js
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadDotEnv();
  const config = loadConfig();
  const storage = await createStorage(config.storage);
  const g = config.storage.github;
  console.log(`Storage: ${config.storage.driver}${config.storage.driver === 'github' ? ` (repo ${g.repo}, branch ${g.branch})` : ` (${config.storage.sqlitePath})`}`);
  if (process.env.RENDER && config.storage.driver === 'sqlite') console.warn('WARNING: SQLite on Render is wiped on every restart. Set STORAGE_DRIVER=github (README section 11b).');
  if (!config.production) console.warn('WARNING: NODE_ENV is not "production"; set it on your host.');
  const app = await createApp({ config, storage });
  app.server.listen(config.port, config.host, () => console.log(`Universe API listening on http://${config.host}:${config.port}`));
  const stop = async () => { try { await app.close(); } catch (e) { console.error('Shutdown error:', e.message); } process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
