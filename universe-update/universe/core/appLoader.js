import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { notFound } from '../shared/errors.js';

// Loads apps/<id>/server/index.js (if present) and lets it register API routes.
// Routes are confined to /api/apps/<id>/ and answer 404 unless the app is installed AND enabled.
export async function loadAppModules({ router, services, apps, appsDir, log = console }) {
  for (const app of apps.list()) {
    const file = join(appsDir, app.id, 'server', 'index.js');
    if (!existsSync(file)) continue;
    const prefix = `/api/apps/${app.id}/`;
    const scoped = {
      add(method, path, handler, opts) {
        if (!path.startsWith(prefix)) throw new Error(`App "${app.id}" may only register routes under ${prefix}`);
        router.add(method, path, async (ctx) => {
          if (!(await services.installer.isActive(app.id))) throw notFound();
          return handler(ctx);
        }, opts);
      },
    };
    try { await (await import(pathToFileURL(file).href)).register({ router: scoped, services, app }); }
    catch (e) { log.error?.(`App "${app.id}" failed to load:`, e); }
  }
}
