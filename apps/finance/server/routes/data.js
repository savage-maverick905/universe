import { v, allowKeys } from '../../../../shared/validate.js';
import { badRequest, conflict, notFound } from '../../../../shared/errors.js';
import { newId, nowIso } from '../../../../shared/ids.js';
import { reply } from '../../../../http/http.js';
import { parseMoney, MoneyError, currencyInfo, CURRENCIES } from '../money.js';
import { isDateStr, todayIn, namedRange, RANGE_NAMES } from '../dates.js';
import { accountBalances, accountHistory, queryTransactions, isPosted } from '../ledger.js';
import { byId, pathOf, descendantIds, parentProblem, depthOf, KINDS } from '../categories.js';

export const ACCOUNT_KINDS = ['cash', 'bank', 'mobile_money', 'savings', 'wallet', 'credit', 'investment', 'other'];
export const PRESETS = [ // suggestions only; any name works
  { name: 'Cash', kind: 'cash' }, { name: 'OPay', kind: 'mobile_money' }, { name: 'PalmPay', kind: 'mobile_money' }, { name: 'Moniepoint', kind: 'bank' },
  { name: 'Kuda', kind: 'bank' }, { name: 'GTBank', kind: 'bank' }, { name: 'Access Bank', kind: 'bank' }, { name: 'Zenith Bank', kind: 'bank' }, { name: 'First Bank', kind: 'bank' }, { name: 'UBA', kind: 'bank' },
];
const COLOR = /^#[0-9a-fA-F]{6}$/;

export function dataRoutes({ router, s, store, txn, guard, P }) {
  const { col, all, own, audit, diff, storage } = store;
  const use = (h, o) => guard('finance.access', h, o);
  const strip = ({ ownerId, ...d }) => d;
  const bump = (d) => ({ version: (d.version || 1) + 1 });

  // ===================== meta =====================
  router.add('GET', `${P}/meta`, use(async ({ user }) => {
    const st = await col.settings.get(user.id);
    return { accountKinds: ACCOUNT_KINDS, presets: PRESETS, currencies: [...Object.entries(CURRENCIES).map(([code, c]) => ({ code, ...c })), ...st.customCurrencies], types: ['income', 'expense', 'transfer', 'refund', 'adjustment'], ranges: RANGE_NAMES, today: todayIn(st.timezone) };
  }));

  // ===================== accounts =====================
  async function accountView(user, a, bal) { return { ...strip(a), balanceMinor: bal.get(a.id) || 0 }; }
  router.add('GET', `${P}/accounts`, use(async ({ user, query }) => {
    const [accounts, txns] = await Promise.all([all(col.accounts, user.id), all(col.txns, user.id)]);
    const bal = accountBalances(accounts, txns), withArchived = query.get('archived') === 'true';
    return { accounts: accounts.filter((a) => withArchived || !a.archived).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name)).map((a) => ({ ...strip(a), balanceMinor: bal.get(a.id) || 0 })) };
  }));

  function parseAccount(b, st, existing) {
    const out = {}, custom = st.customCurrencies;
    if (!existing || 'name' in b) out.name = v.string(b.name, 'name', { min: 1, max: 60 });
    if (!existing || 'kind' in b) out.kind = v.enum(b.kind ?? 'bank', 'kind', ACCOUNT_KINDS);
    if ('provider' in b) out.provider = b.provider ? v.string(b.provider, 'provider', { max: 60 }) : '';
    if (!existing || 'currency' in b) { out.currency = b.currency ?? st.currency; if (!currencyInfo(out.currency, custom)) throw badRequest('Unknown currency'); }
    const cur = out.currency ?? existing.currency;
    if ('openingBalanceMinor' in b || 'openingBalance' in b) {
      try { out.openingBalanceMinor = 'openingBalanceMinor' in b ? (Number.isSafeInteger(b.openingBalanceMinor) && Math.abs(b.openingBalanceMinor) <= 1e13 ? b.openingBalanceMinor : (() => { throw new MoneyError('openingBalanceMinor must be a whole number'); })()) : (String(b.openingBalance).trim().startsWith('-') ? -parseMoney(String(b.openingBalance).trim().slice(1), cur, custom) : parseMoney(b.openingBalance, cur, custom)); }
      catch (e) { if (e instanceof MoneyError) throw badRequest(e.message, 'invalid_amount'); throw e; }
    } else if (!existing) out.openingBalanceMinor = 0;
    if ('openingDate' in b) { if (!isDateStr(b.openingDate)) throw badRequest('openingDate must look like 2026-01-31'); out.openingDate = b.openingDate; }
    if ('group' in b) out.group = b.group ? v.string(b.group, 'group', { max: 40 }) : '';
    if ('color' in b) { if (b.color && !COLOR.test(b.color)) throw badRequest('color must look like #ED6627'); out.color = b.color || null; }
    if ('icon' in b) out.icon = b.icon ? v.string(b.icon, 'icon', { max: 8 }) : null;
    if ('notes' in b) out.notes = v.string(b.notes ?? '', 'notes', { max: 500 });
    if ('sortOrder' in b) { if (!Number.isInteger(b.sortOrder)) throw badRequest('sortOrder must be a whole number'); out.sortOrder = b.sortOrder; }
    if ('excludeFromNetWorth' in b) out.excludeFromNetWorth = !!b.excludeFromNetWorth;
    return out;
  }
  const ACC_KEYS = ['name', 'kind', 'provider', 'currency', 'openingBalance', 'openingBalanceMinor', 'openingDate', 'group', 'color', 'icon', 'notes', 'sortOrder', 'excludeFromNetWorth', 'expectedVersion'];

  router.add('POST', `${P}/accounts`, use(async ({ user, body }) => {
    const b = allowKeys(v.object(body), ACC_KEYS), st = await col.settings.get(user.id), f = parseAccount(b, st, null);
    return storage.transaction(async () => {
      const existing = (await all(col.accounts, user.id)).filter((a) => !a.archived && a.name.toLowerCase() === f.name.toLowerCase());
      if (existing.length) throw conflict(`You already have an account called "${f.name}"`, 'duplicate_name');
      const now = nowIso(), a = await col.accounts.insert({ id: newId('acc'), schemaVersion: 1, ownerId: user.id, provider: '', group: '', notes: '', archived: false, sortOrder: 100, openingDate: todayIn(st.timezone), excludeFromNetWorth: false, ...f, version: 1, createdAt: now, updatedAt: now });
      await audit(user.id, { action: 'account.create', entityType: 'account', entityId: a.id, source: 'manual' });
      return reply(201, { account: { ...strip(a), balanceMinor: a.openingBalanceMinor } });
    });
  }));

  async function accountDetail(user, id) {
    const a = await own(col.accounts, id, user.id, 'Account'), txns = (await all(col.txns, user.id)).filter((t) => t.accountId === id || t.toAccountId === id);
    return { a, txns, bal: accountBalances([a], txns).get(id) || 0 };
  }
  router.add('GET', `${P}/accounts/:id`, use(async ({ user, params }) => { const { a, bal } = await accountDetail(user, params.id); return { account: { ...strip(a), balanceMinor: bal } }; }));
  router.add('GET', `${P}/accounts/:id/history`, use(async ({ user, params, query }) => {
    const { a, txns } = await accountDetail(user, params.id), hist = accountHistory(a, txns), byTx = new Map(txns.map((t) => [t.id, t]));
    const limit = Math.min(Math.max(parseInt(query.get('limit'), 10) || 50, 1), 200), offset = Math.max(parseInt(query.get('offset'), 10) || 0, 0);
    return { total: hist.length, items: hist.slice(offset, offset + limit).map((h) => ({ ...h, transaction: strip(byTx.get(h.transactionId)) })) };
  }));
  router.add('PATCH', `${P}/accounts/:id`, use(async ({ user, params, body }) => {
    const b = allowKeys(v.object(body), ACC_KEYS), st = await col.settings.get(user.id);
    return storage.transaction(async () => {
      const old = await own(col.accounts, params.id, user.id, 'Account');
      if (Number.isInteger(b.expectedVersion) && b.expectedVersion !== old.version) throw conflict('This account was changed somewhere else. Reload and try again.', 'stale');
      const f = parseAccount(b, st, old);
      if (f.currency && f.currency !== old.currency && (await col.txns.count({ ownerId: user.id, accountId: old.id })) + (await col.txns.count({ ownerId: user.id, toAccountId: old.id }))) throw conflict('The currency cannot change once an account has transactions.', 'currency_locked');
      if (f.name && (await all(col.accounts, user.id)).some((a) => a.id !== old.id && !a.archived && a.name.toLowerCase() === f.name.toLowerCase())) throw conflict(`You already have an account called "${f.name}"`, 'duplicate_name');
      const a = await col.accounts.update(old.id, { ...f, ...bump(old) });
      await audit(user.id, { action: 'account.update', entityType: 'account', entityId: a.id, source: 'manual', changes: diff(old, a, Object.keys(f)) });
      return { account: strip(a) };
    });
  }));
  for (const [action, archived] of [['archive', true], ['restore', false]]) {
    router.add('POST', `${P}/accounts/:id/${action}`, use(async ({ user, params }) => storage.transaction(async () => {
      const old = await own(col.accounts, params.id, user.id, 'Account');
      const a = await col.accounts.update(old.id, { archived, ...bump(old) });
      await audit(user.id, { action: `account.${action}`, entityType: 'account', entityId: a.id, source: 'manual' });
      return { account: strip(a) };
    })));
  }
  router.add('DELETE', `${P}/accounts/:id`, use(async ({ user, params }) => storage.transaction(async () => {
    const a = await own(col.accounts, params.id, user.id, 'Account');
    const n = (await col.txns.count({ ownerId: user.id, accountId: a.id })) + (await col.txns.count({ ownerId: user.id, toAccountId: a.id }));
    if (n) throw conflict(`This account has ${n} transactions. Archive it instead; its history is kept.`, 'has_transactions');
    await col.accounts.delete(a.id); await audit(user.id, { action: 'account.delete', entityType: 'account', entityId: a.id, source: 'manual' });
    return { ok: true };
  })));

  // ===================== categories =====================
  const catView = (map, c) => ({ ...strip(c), path: pathOf(map, c.id), depth: depthOf(map, c.id) });
  router.add('GET', `${P}/categories`, use(async ({ user, query }) => {
    const cats = await all(col.cats, user.id), map = byId(cats), withArchived = query.get('archived') === 'true';
    return { categories: cats.filter((c) => withArchived || !c.archived).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name)).map((c) => catView(map, c)) };
  }));
  const CAT_KEYS = ['name', 'kind', 'parentId', 'icon', 'color', 'sortOrder'];
  function parseCat(b, existing) {
    const o = {};
    if (!existing || 'name' in b) o.name = v.string(b.name, 'name', { min: 1, max: 60 });
    if (!existing) o.kind = v.enum(b.kind, 'kind', KINDS); else if ('kind' in b && b.kind !== existing.kind) throw badRequest('A category\'s type (income/expense) cannot change');
    if ('icon' in b) o.icon = b.icon ? v.string(b.icon, 'icon', { max: 8 }) : null;
    if ('color' in b) { if (b.color && !COLOR.test(b.color)) throw badRequest('color must look like #ED6627'); o.color = b.color || null; }
    if ('sortOrder' in b) { if (!Number.isInteger(b.sortOrder)) throw badRequest('sortOrder must be a whole number'); o.sortOrder = b.sortOrder; }
    if ('parentId' in b) o.parentId = b.parentId || null;
    return o;
  }
  router.add('POST', `${P}/categories`, use(async ({ user, body }) => {
    const f = parseCat(allowKeys(v.object(body), CAT_KEYS), null);
    return storage.transaction(async () => {
      const cats = await all(col.cats, user.id), problem = parentProblem(cats, { parentId: f.parentId, kind: f.kind });
      if (problem) throw badRequest(problem, 'bad_parent');
      if (cats.some((c) => !c.archived && c.kind === f.kind && (c.parentId || null) === (f.parentId || null) && c.name.toLowerCase() === f.name.toLowerCase())) throw conflict(`"${f.name}" already exists here`, 'duplicate_name');
      const now = nowIso(), c = await col.cats.insert({ id: newId('cat'), schemaVersion: 1, ownerId: user.id, parentId: null, icon: null, color: null, sortOrder: 1000, archived: false, ...f, version: 1, createdAt: now, updatedAt: now });
      await audit(user.id, { action: 'category.create', entityType: 'category', entityId: c.id, source: 'manual' });
      return reply(201, { category: catView(byId([...cats, c]), c) });
    });
  }));
  router.add('PATCH', `${P}/categories/:id`, use(async ({ user, params, body }) => {
    const b = allowKeys(v.object(body), CAT_KEYS);
    return storage.transaction(async () => {
      const old = await own(col.cats, params.id, user.id, 'Category'), cats = await all(col.cats, user.id), f = parseCat(b, old);
      if ('parentId' in f) { const problem = parentProblem(cats, { id: old.id, parentId: f.parentId, kind: old.kind }); if (problem) throw badRequest(problem, 'bad_parent'); }
      const c = await col.cats.update(old.id, { ...f, ...bump(old) });
      await audit(user.id, { action: 'category.update', entityType: 'category', entityId: c.id, source: 'manual', changes: diff(old, c, Object.keys(f)) });
      return { category: catView(byId(cats.map((x) => (x.id === c.id ? c : x))), c) };
    });
  }));
  for (const [action, archived] of [['archive', true], ['restore', false]]) {
    router.add('POST', `${P}/categories/:id/${action}`, use(async ({ user, params, body }) => storage.transaction(async () => {
      const old = await own(col.cats, params.id, user.id, 'Category'), cats = await all(col.cats, user.id), cascade = !!body?.cascade;
      const ids = cascade ? [...descendantIds(cats, old.id)] : [old.id];
      if (archived && !cascade && cats.some((c) => c.parentId === old.id && !c.archived)) throw conflict('This category has active subcategories. Archive them too, or archive with subcategories.', 'has_children');
      if (!archived && old.parentId && cats.find((c) => c.id === old.parentId)?.archived) throw conflict('Restore the parent category first.', 'parent_archived');
      for (const id of ids) await col.cats.update(id, { archived });
      await audit(user.id, { action: `category.${action}`, entityType: 'category', entityId: old.id, source: 'manual', changes: { cascade: [null, cascade] } });
      return { ok: true, affected: ids.length };
    })));
  }
  // Delete = move everything that uses it to another category of the same type first. History is never orphaned.
  router.add('DELETE', `${P}/categories/:id`, use(async ({ user, params, query }) => storage.transaction(async () => {
    const old = await own(col.cats, params.id, user.id, 'Category'), cats = await all(col.cats, user.id);
    if (cats.some((c) => c.parentId === old.id)) throw conflict('Move or delete this category\'s subcategories first (or archive it).', 'has_children');
    const [txns, budgets, rules] = await Promise.all([all(col.txns, user.id), all(col.budgets, user.id), all(col.recurring, user.id)]);
    const tx = txns.filter((t) => t.categoryId === old.id || t.feeCategoryId === old.id), bu = budgets.filter((b) => b.categoryId === old.id), ru = rules.filter((r) => r.categoryId === old.id);
    const used = tx.length + bu.length + ru.length;
    const to = query.get('reassignTo');
    if (used && !to) throw conflict(`"${old.name}" is used by ${tx.length} transactions, ${bu.length} budgets and ${ru.length} recurring items. Choose a category to move them to, or archive it instead.`, 'in_use');
    if (used) {
      if (to === old.id) throw badRequest('Choose a different category');
      const target = await own(col.cats, to, user.id, 'Target category');
      if (target.kind !== old.kind) throw badRequest('Move them to a category of the same type');
      if (target.archived) throw badRequest('The target category is archived');
      for (const t of tx) await col.txns.update(t.id, { ...(t.categoryId === old.id ? { categoryId: to } : {}), ...(t.feeCategoryId === old.id ? { feeCategoryId: to } : {}), version: (t.version || 1) + 1 });
      for (const b of bu) await col.budgets.update(b.id, { categoryId: to });
      for (const r of ru) await col.recurring.update(r.id, { categoryId: to });
    }
    await col.cats.delete(old.id);
    await audit(user.id, { action: 'category.delete', entityType: 'category', entityId: old.id, source: 'manual', changes: { reassignedTo: [null, to || null], moved: [null, used] } });
    return { ok: true, moved: used };
  })));

  // ===================== transactions =====================
  const MAXQ = 200;
  function filtersFrom(query, st, cats) {
    const g = (k) => query.get(k) || '', f = { q: g('q').slice(0, 100), sort: g('sort'), dir: g('dir'), limit: g('limit'), offset: g('offset'), status: g('status') || 'posted' };
    if (g('type')) f.types = g('type').split(',').filter(Boolean).slice(0, 10);
    if (g('accountId')) f.accountId = g('accountId');
    if (g('categoryId')) { f.categoryIds = g('categoryId') === 'none' ? [null] : [...descendantIds(cats, g('categoryId'))]; }
    if (g('range')) { try { Object.assign(f, namedRange(g('range'), todayIn(st.timezone), { weekStartsOn: st.weekStartsOn, from: g('from'), to: g('to') })); } catch (e) { throw badRequest(e.message); } }
    else { if (g('from')) { if (!isDateStr(g('from'))) throw badRequest('from is not a date'); f.from = g('from'); } if (g('to')) { if (!isDateStr(g('to'))) throw badRequest('to is not a date'); f.to = g('to'); } }
    try { if (g('min')) f.minMinor = parseMoney(g('min'), st.currency, st.customCurrencies); if (g('max')) f.maxMinor = parseMoney(g('max'), st.currency, st.customCurrencies); } catch (e) { throw badRequest(e.message); }
    if (g('tag')) f.tag = g('tag').slice(0, 30); if (g('debtId')) f.debtId = g('debtId'); if (g('goalId')) f.goalId = g('goalId');
    return f;
  }
  router.add('GET', `${P}/transactions`, use(async ({ user, query }) => {
    const [st, cats, accounts, txns] = await Promise.all([col.settings.get(user.id), all(col.cats, user.id), all(col.accounts, user.id), all(col.txns, user.id)]);
    const cm = byId(cats), am = byId(accounts), f = filtersFrom(query, st, cats);
    const r = queryTransactions(txns, f, { categoryPath: (id) => pathOf(cm, id), accountName: (id) => am.get(id)?.name || '' });
    return { ...r, items: r.items.map((t) => ({ ...strip(t), categoryPath: pathOf(cm, t.categoryId) })) };
  }));
  router.add('POST', `${P}/transactions`, use(async ({ user, body }) => {
    const r = await txn.create(user, v.object(body), { source: 'manual' });
    return reply(r.replayed ? 200 : 201, { transaction: strip(r.transaction), replayed: r.replayed, warnings: r.warnings });
  }));
  router.add('GET', `${P}/transactions/:id`, use(async ({ user, params }) => {
    const t = await own(col.txns, params.id, user.id, 'Transaction'), cats = byId(await all(col.cats, user.id));
    const [refunds, trail] = await Promise.all([col.txns.find({ where: { ownerId: user.id, refundOf: t.id }, limit: 200 }), col.audit.find({ where: { ownerId: user.id, entityId: t.id }, orderBy: { field: 'at', dir: 'asc' }, limit: 100 })]);
    return { transaction: { ...strip(t), categoryPath: pathOf(cats, t.categoryId) }, refunds: refunds.map(strip), history: trail.map(strip) };
  }));
  router.add('PATCH', `${P}/transactions/:id`, use(async ({ user, params, body }) => { const r = await txn.update(user, params.id, v.object(body)); return { transaction: strip(r.transaction), warnings: r.warnings }; }));
  router.add('POST', `${P}/transactions/:id/void`, use(async ({ user, params, body }) => {
    const b = allowKeys(v.object(body), ['confirm', 'reason', 'expectedVersion']);
    if (b.confirm !== true) throw badRequest('Voiding must be confirmed (confirm: true)', 'confirmation_required');
    return { transaction: strip(await txn.voidTxn(user, params.id, { reason: b.reason ?? '', expectedVersion: b.expectedVersion })) };
  }));
  router.add('DELETE', `${P}/transactions/:id`, use(async ({ user, params, body }) => {
    if (body?.confirm !== true) throw badRequest('Deleting must be confirmed (confirm: true)', 'confirmation_required');
    return txn.remove(user, params.id);
  }));
}
