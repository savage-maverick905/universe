import { HttpError, badRequest, notFound } from '../shared/errors.js';

export const PERIODS = ['daily', 'weekly', 'monthly', 'yearly', 'last_days', 'custom'];
const DAY = 86_400_000, MAX_DAYS = 3660;
const iso = (d) => d.toISOString().slice(0, 10);
const validDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && iso(new Date(`${s}T00:00:00Z`)) === s;

// All dates are UTC calendar dates for now (per-user time zones are Planned).
export function resolveRange({ period, from, to, days } = {}, now = new Date()) {
  const today = iso(now), back = (n) => iso(new Date(now.getTime() - (n - 1) * DAY));
  switch (period) {
    case 'daily': return { from: today, to: today, label: 'Today' };
    case 'weekly': return { from: back(7), to: today, label: 'Last 7 days' };
    case 'monthly': return { from: back(30), to: today, label: 'Last 30 days' };
    case 'yearly': return { from: back(365), to: today, label: 'Last 365 days' };
    case 'last_days':
      if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw badRequest(`days must be a whole number from 1 to ${MAX_DAYS}`);
      return { from: back(days), to: today, label: `Last ${days} days` };
    case 'custom': {
      if (!validDate(from) || !validDate(to)) throw badRequest('from and to must be dates like 2026-01-31');
      if (from > to) throw badRequest('from must not be after to');
      if ((Date.parse(to) - Date.parse(from)) / DAY >= MAX_DAYS) throw badRequest(`A custom range can cover at most ${MAX_DAYS} days`);
      return { from, to, label: `${from} to ${to}` };
    }
    default: throw badRequest(`period must be one of: ${PERIODS.join(', ')}`);
  }
}

/**
 * Report contract. A provider handler receives { user, range:{from,to,label}, filters, services } and returns
 *   { title, sections: [{ heading, stats?: [{label,value}], table?: {columns, rows}, text? }] }
 * Providers must be declared in the app manifest (`reports`), which supplies the required permission.
 * Supported filters today: category (a name), status. Providers ignore filters they do not understand.
 */
export class ReportRegistry {
  constructor({ installer, permissions, apps }) { Object.assign(this, { installer, permissions, apps }); this.providers = new Map(); }
  registerApp(appId, id, { handler }) {
    const decl = this.apps.get(appId)?.reports?.find((r) => r.id === id);
    if (!decl) throw new Error(`Report "${id}" is not declared in ${appId}/manifest.json`);
    this.providers.set(`${appId}.${id}`, { ...decl, appId, appName: this.apps.get(appId).name, handler });
  }
  async available(user) {
    const out = [];
    for (const [key, p] of this.providers) {
      if (!(await this.installer.isActive(p.appId)) || !(await this.permissions.can(user, p.requiredPermission))) continue;
      out.push({ key, appId: p.appId, appName: p.appName, id: p.id, title: p.title });
    }
    return out;
  }
  // report: "all" (everything this user may run, optionally limited to one app) or a specific key.
  async run(user, { report = 'all', appId = null, range, filters = {}, services }) {
    const avail = await this.available(user);
    let chosen = report === 'all' ? avail.filter((r) => !appId || r.appId === appId) : avail.filter((r) => r.key === report);
    if (report !== 'all' && !chosen.length) throw notFound('That report is not available');
    if (report === 'all' && appId && !chosen.length) throw notFound('No report is available for that app');
    const sections = [];
    for (const r of chosen) {
      const out = await this.providers.get(r.key).handler({ user, range, filters, services });
      for (const s of out.sections) sections.push({ ...s, heading: chosen.length > 1 ? `${r.appName}: ${s.heading}` : s.heading, source: r.key });
    }
    if (!sections.length) sections.push({ heading: 'Nothing to report', text: 'No installed app has a report you are allowed to run.' });
    const title = chosen.length === 1 ? chosen[0].title : appId ? `${chosen[0]?.appName ?? ''} report` : 'Ecosystem report';
    return { title, range, filters, generatedAt: new Date().toISOString(), sections };
  }
}
