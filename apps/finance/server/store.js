// Shared data access for Orbit. Every record carries ownerId; every lookup goes through own(), so another user's
// record behaves exactly like a missing one (404). There is deliberately NO admin or cross-user code path.
import { notFound } from '../../../shared/errors.js';
import { newId, nowIso } from '../../../shared/ids.js';
import { starterCategories } from './categories.js';
import { DEFAULT_TZ } from './dates.js';

export const SCHEMA_VERSION = 1;
const NAMES = { accounts: 'finance_accounts', cats: 'finance_categories', txns: 'finance_transactions', budgets: 'finance_budgets', debts: 'finance_debts',
  goals: 'finance_goals', recurring: 'finance_recurring', items: 'finance_networth', settings: 'finance_settings', idem: 'finance_idempotency', audit: 'finance_audit', chats: 'finance_chats' };

export function makeStore(s) {
  const { storage } = s, col = {};
  for (const [k, n] of Object.entries(NAMES)) col[k] = storage.collection(n, { indexes: ['ownerId'] });

  async function all(c, ownerId) { // the storage layer caps one read at 10000 documents, so page through
    const out = [];
    for (let offset = 0; ; offset += 10000) { const page = await c.find({ where: { ownerId }, limit: 10000, offset }); out.push(...page); if (page.length < 10000) break; }
    return out;
  }
  async function own(c, id, ownerId, what = 'Record') {
    const d = typeof id === 'string' ? await c.get(id) : null;
    if (!d || d.ownerId !== ownerId) throw notFound(`${what} not found`);
    return d;
  }
  // First use per user: settings + editable starter categories. Idempotent; safe to call on every request.
  async function ensureSetup(user) {
    const have = await col.settings.get(user.id);
    if (have) return have;
    return storage.transaction(async () => {
      if (await col.settings.get(user.id)) return col.settings.get(user.id);
      const now = nowIso();
      for (const c of starterCategories(user.id, newId, now)) await col.cats.insert(c);
      return col.settings.insert({ id: user.id, ownerId: user.id, schemaVersion: SCHEMA_VERSION, currency: 'NGN', timezone: DEFAULT_TZ, weekStartsOn: 1, customCurrencies: [], showOnDashboard: false, seededAt: now });
    });
  }
  // Keeps the last ~2000 audit entries per user. Audit rows record WHAT changed on WHICH record; they live in finance_*
  // collections only (never in the core audit log that admins can read).
  async function audit(ownerId, entry) {
    await col.audit.insert({ id: newId('fa'), ownerId, at: nowIso(), ...entry });
    if (Math.random() < 0.02) { const rows = await col.audit.find({ where: { ownerId }, orderBy: { field: 'at', dir: 'asc' }, limit: 10000 }); for (const r of rows.slice(0, Math.max(0, rows.length - 2000))) await col.audit.delete(r.id); }
  }
  const diff = (a, b, keys) => Object.fromEntries(keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => [k, [a[k] ?? null, b[k] ?? null]]));
  return { col, all, own, ensureSetup, audit, diff, storage };
}
