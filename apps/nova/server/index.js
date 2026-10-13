// Nova: Universe's project, task and execution manager. Loaded by core/appLoader.js, which calls register().
// Routes live under /api/apps/nova/ and answer 404 until an admin installs Nova.
import { makeCore } from './core.js';
import { makeAi } from './ai.js';
import { makeReport } from './report.js';
import { routes } from './routes.js';

export function register({ router, services: s }) {
  const core = makeCore(s), ai = makeAi(s, core);
  routes({ router, s, core, ai });
  ai.registerTools();
  s.reports?.registerApp('nova', 'nova-overview', { handler: makeReport(core) });
}
