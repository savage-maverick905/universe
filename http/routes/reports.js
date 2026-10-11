import { v, allowKeys } from '../../shared/validate.js';
import { badRequest, notFound } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import { reply } from '../http.js';
import { resolveRange, PERIODS } from '../../core/reports.js';

const MAX_SAVED = 50;

export function reportRoutes(router, s) {
  const { reports } = s;
  const saved = s.storage.collection('reports', { indexes: ['userId'] });

  router.add('GET', '/api/reports/available', async ({ user }) => ({ reports: await reports.available(user), periods: PERIODS }));

  router.add('POST', '/api/reports/run', async ({ user, body, req, res, session }) => {
    const b = allowKeys(v.object(body), ['report', 'app', 'period', 'days', 'from', 'to', 'filters', 'save']);
    const f = allowKeys(v.object(b.filters ?? {}, 'filters'), ['category', 'status'], 'filters');
    const filters = {};
    if (f.category != null && f.category !== '') filters.category = v.string(f.category, 'filters.category', { max: 60 });
    if (f.status != null && f.status !== '') filters.status = v.string(f.status, 'filters.status', { max: 40 });
    const range = resolveRange({ period: b.period, from: b.from, to: b.to, days: b.days });
    const result = await reports.run(user, { report: b.report == null ? 'all' : v.string(b.report, 'report', { max: 80 }),
      appId: b.app == null ? null : v.id(b.app, 'app'), range, filters, services: s, request: { req, res, session } });
    if (b.save === true) {
      // Sections protected by an app's PIN (marked sensitive) are shown now but never stored.
      const stored = { ...result, sections: result.sections.map((x) => (x.sensitive && !x.gate ? { heading: x.heading, text: 'Not saved: this section is protected by your Finance PIN.', source: x.source } : x)) };
      const doc = await saved.insert({ id: newId('rep'), userId: user.id, title: result.title, request: { report: b.report ?? 'all', period: b.period }, result: stored });
      const mine = await saved.find({ where: { userId: user.id }, orderBy: { field: 'createdAt', dir: 'desc' }, limit: 1000 });
      for (const old of mine.slice(MAX_SAVED)) await saved.delete(old.id); // keep the newest 50
      return reply(200, { ...result, savedId: doc.id });
    }
    return result;
  });

  router.add('GET', '/api/reports/saved', async ({ user }) => ({
    reports: (await saved.find({ where: { userId: user.id }, orderBy: { field: 'createdAt', dir: 'desc' }, limit: MAX_SAVED }))
      .map((r) => ({ id: r.id, title: r.title, range: r.result.range, createdAt: r.createdAt })),
  }));
  const ownSaved = async (user, id) => { const r = await saved.get(id); if (!r || r.userId !== user.id) throw notFound('Report not found'); return r; };
  router.add('GET', '/api/reports/saved/:id', async ({ user, params }) => ({ report: (await ownSaved(user, params.id)).result }));
  router.add('DELETE', '/api/reports/saved/:id', async ({ user, params }) => { await saved.delete((await ownSaved(user, params.id)).id); return { ok: true }; });
}
