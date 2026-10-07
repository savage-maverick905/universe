import { canView, viewProfile } from '../../auth/visibility.js';
import { resolveRange, PERIODS } from '../../core/reports.js';
import { badRequest } from '../../shared/errors.js';

// Core tools. Cross-user information ONLY flows through the same visibility check the API uses,
// so asking the AI can never reveal more than the person could see themselves.
export function registerCoreTools(tools) {
  tools.registerCore({
    name: 'users.findProfiles', access: 'read', requiredPermission: 'ai.use',
    description: 'Find other people in this ecosystem by display name and read ONLY the profile fields they have chosen to share with the current user.',
    parameters: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string', maxLength: 80, description: 'Part of a display name' } } },
    handler: async ({ query }, { user, services }) => {
      const q = query.trim().toLowerCase();
      if (!q) return { profiles: [] };
      const all = await services.users.list();
      // A person whose display name is hidden from the viewer cannot even be found by it.
      const hits = all.filter((u) => u.status === 'active' && u.id !== user.id && canView(user, u, 'displayName') && u.displayName.toLowerCase().includes(q)).slice(0, 10);
      return { profiles: hits.map((u) => viewProfile(user, u)) };
    },
  });

  tools.registerCore({
    name: 'reports.generate', access: 'read', requiredPermission: 'ai.use',
    description: 'Generate a report for the current user over a time period (daily, weekly, monthly, yearly, last N days, or a custom date range). Optionally limit it to one app and filter by category name or status. Only reports the user is allowed to run are produced.',
    parameters: { type: 'object', additionalProperties: false, required: ['period'], properties: {
      period: { type: 'string', enum: PERIODS }, days: { type: 'integer', minimum: 1, maximum: 3660, description: 'Needed when period is last_days' },
      from: { type: 'string', maxLength: 10, description: 'YYYY-MM-DD, for custom' }, to: { type: 'string', maxLength: 10, description: 'YYYY-MM-DD, for custom' },
      app: { type: 'string', maxLength: 40, description: 'App id such as inventory; omit for everything' }, category: { type: 'string', maxLength: 60 }, status: { type: 'string', maxLength: 40 } } },
    handler: async (a, { user, services }) => {
      const filters = {}; if (a.category) filters.category = a.category; if (a.status) filters.status = a.status;
      const r = await services.reports.run(user, { appId: a.app ?? null, range: resolveRange(a), filters, services });
      // Keep tool output small for the model: first 10 table rows per section.
      return { ...r, sections: r.sections.map((sec) => (sec.table ? { ...sec, table: { ...sec.table, rows: sec.table.rows.slice(0, 10), totalRows: sec.table.rows.length } } : sec)) };
    },
  });
}
