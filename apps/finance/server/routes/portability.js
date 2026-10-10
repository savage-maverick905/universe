// CSV export, CSV import (map -> preview -> confirm) and JSON backup/restore. All need the unlock cookie.
import { createHash } from 'node:crypto';
import { v, allowKeys } from '../../../../shared/validate.js';
import { badRequest, conflict } from '../../../../shared/errors.js';
import { reply } from '../../../../http/http.js';
import { toDecimal, parseMoney } from '../money.js';
import { isDateStr } from '../dates.js';
import { byId, pathOf } from '../categories.js';
import { parseCsv, toCsv } from '../csv.js';
import { matchName } from '../names.js';

const COLS = ['date', 'type', 'amount', 'currency', 'account', 'to_account', 'to_amount', 'fee', 'category', 'description', 'counterparty', 'tags', 'notes', 'status', 'id'];
const BACKUP_COLLECTIONS = { accounts: 'finance_accounts', categories: 'finance_categories', transactions: 'finance_transactions', budgets: 'finance_budgets', debts: 'finance_debts', goals: 'finance_goals', recurring: 'finance_recurring', networth: 'finance_networth' };

export function portabilityRoutes({ router, s, store, txn, guard, P }) {
  const { col, all, storage, audit } = store;
  const use = (h, o) => guard('finance.export', h, o);
  const strip = ({ ownerId, ...d }) => d;

  router.add('GET', `${P}/export/transactions.csv`, use(async ({ user, query, ip }) => {
    const [st, accounts, cats, txns] = await Promise.all([col.settings.get(user.id), all(col.accounts, user.id), all(col.cats, user.id), all(col.txns, user.id)]);
    const am = byId(accounts), cm = byId(cats), custom = st.customCurrencies, from = query.get('from'), to = query.get('to');
    const rows = txns.filter((t) => (!from || t.localDate >= from) && (!to || t.localDate <= to)).sort((a, b) => (a.localDate < b.localDate ? -1 : 1)).map((t) => [t.localDate, t.type, toDecimal(t.amountMinor, t.currency, custom), t.currency, am.get(t.accountId)?.name || '', am.get(t.toAccountId)?.name || '', t.toAmountMinor != null && t.type === 'transfer' ? toDecimal(t.toAmountMinor, t.toCurrency, custom) : '', t.feeMinor ? toDecimal(t.feeMinor, t.currency, custom) : '', pathOf(cm, t.categoryId), t.description, t.counterparty, (t.tags || []).join(' '), t.notes, t.status || 'posted', t.id]);
    await s.audit.record({ actorId: user.id, action: 'finance.export_csv', ip, meta: { rows: rows.length } });
    return reply(200, { csv: toCsv([COLS, ...rows]), filename: `orbit-transactions-${new Date().toISOString().slice(0, 10)}.csv`, rows: rows.length });
  }));

  router.add('GET', `${P}/export/backup`, use(async ({ user, ip }) => {
    const out = { format: 'orbit-backup', schemaVersion: 1, exportedAt: new Date().toISOString(), settings: strip(await col.settings.get(user.id)), collections: {} };
    for (const [k, name] of Object.entries(BACKUP_COLLECTIONS)) out.collections[k] = (await all(col[{ accounts: 'accounts', categories: 'cats', transactions: 'txns', budgets: 'budgets', debts: 'debts', goals: 'goals', recurring: 'recurring', networth: 'items' }[k]], user.id)).map(strip);
    await s.audit.record({ actorId: user.id, action: 'finance.export_backup', ip });
    return out;
  }));

  // Restore: validated, additive (never overwrites an existing record, never touches another user's data), all or nothing.
  router.add('POST', `${P}/restore`, use(async ({ user, body, ip }) => {
    const b = allowKeys(v.object(body), ['backup', 'confirm', 'dryRun']), bk = v.object(b.backup, 'backup');
    if (bk.format !== 'orbit-backup' || bk.schemaVersion !== 1 || typeof bk.collections !== 'object') throw badRequest('This is not an Orbit backup file', 'bad_backup');
    const plan = {}, docs = [];
    const MAP = { accounts: 'accounts', categories: 'cats', transactions: 'txns', budgets: 'budgets', debts: 'debts', goals: 'goals', recurring: 'recurring', networth: 'items' };
    for (const [k, key] of Object.entries(MAP)) {
      const list = bk.collections[k] ?? []; if (!Array.isArray(list) || list.length > 50000) throw badRequest(`${k} is not a valid list`, 'bad_backup');
      let add = 0, skip = 0;
      for (const d of list) {
        if (!d || typeof d !== 'object' || !/^[A-Za-z0-9_-]{1,100}$/.test(d.id || '')) throw badRequest(`A record in ${k} has no valid id`, 'bad_backup');
        if (k === 'transactions' && (!Number.isSafeInteger(d.amountMinor) || d.amountMinor < 1 || !isDateStr(d.localDate))) throw badRequest('A transaction in the backup is invalid', 'bad_backup');
        const ex = await col[key].get(d.id);
        if (ex) { if (ex.ownerId !== user.id) throw conflict('The backup contains an id that belongs to someone else. Nothing was restored.', 'id_collision'); skip++; continue; }
        add++; docs.push([key, { ...d, ownerId: user.id }]);
      }
      plan[k] = { add, skip };
    }
    if (b.dryRun || b.confirm !== true) return { applied: false, plan, note: 'Nothing was changed. Send confirm: true to restore the records marked "add". Existing records are never overwritten.' };
    await storage.transaction(async () => { for (const [key, d] of docs) await col[key].insert(d); await audit(user.id, { action: 'restore', entityType: 'backup', entityId: 'backup', source: 'manual', changes: { added: [null, docs.length] } }); });
    await s.audit.record({ actorId: user.id, action: 'finance.restore', ip, meta: { added: docs.length } });
    return { applied: true, plan };
  }), { bodyLimit: 4 * 1024 * 1024 });

  // ---- CSV import ----
  // mapping: { date, amount, description?, type?, account?, category?, counterparty?, notes?, tags? } = column names from the header row.
  // The server re-parses and re-validates everything on confirm; the preview is advice, never trusted.
  async function analyse(user, csv, mapping, defaults) {
    const st = await col.settings.get(user.id), [accounts, cats, txns] = await Promise.all([all(col.accounts, user.id), all(col.cats, user.id), all(col.txns, user.id)]);
    const table = parseCsv(String(csv)); if (table.length < 2) throw badRequest('The file has no data rows');
    if (table.length > 5001) throw badRequest('Import at most 5000 rows at a time');
    const head = table[0].map((h) => h.trim()), idx = (n) => (n ? head.indexOf(n) : -1);
    for (const need of ['date', 'amount']) if (idx(mapping[need]) < 0) throw badRequest(`Map a column for "${need}"`);
    const defAcct = accounts.find((a) => a.id === defaults.accountId); if (!defAcct && idx(mapping.account) < 0) throw badRequest('Choose a default account or map an account column');
    const aItems = accounts.filter((a) => !a.archived).map((a) => ({ id: a.id, names: [a.name], a })), cItems = cats.filter((c) => !c.archived).map((c) => ({ id: c.id, names: [pathOf(byId(cats), c.id), c.name], c }));
    const seen = new Set(txns.filter((t) => t.status !== 'voided').map((t) => dupKey(t.accountId, t.localDate, t.amountMinor, t.type, t.description)));
    const rows = [];
    table.slice(1).forEach((r, i) => {
      const get = (n) => (idx(n) >= 0 ? (r[idx(n)] ?? '').trim() : ''), out = { row: i + 2, errors: [] };
      try {
        const acct = idx(mapping.account) >= 0 && get(mapping.account) ? matchName(get(mapping.account), aItems).match?.a : defAcct;
        if (!acct) throw new Error(`Unknown account "${get(mapping.account)}"`);
        let raw = get(mapping.amount).replace(/[()]/g, (m) => (m === '(' ? '-' : '')), neg = raw.trim().startsWith('-'); raw = raw.replace(/^[-+]/, '');
        const amountMinor = parseMoney(raw, acct.currency, st.customCurrencies);
        let type = get(mapping.type).toLowerCase(); if (!['income', 'expense'].includes(type)) type = neg ? 'expense' : defaults.positiveIs === 'expense' ? 'expense' : 'income';
        if (mapping.type && !['income', 'expense', ''].includes(get(mapping.type).toLowerCase())) throw new Error('Type must be income or expense (transfers and debts cannot be imported)');
        const date = normaliseDate(get(mapping.date)); if (!date) throw new Error('Unreadable date (use YYYY-MM-DD or DD/MM/YYYY)');
        const cat = get(mapping.category) ? matchName(get(mapping.category), cItems.filter((c) => c.c.kind === type)).match?.c : null;
        Object.assign(out, { type, accountId: acct.id, amountMinor, date, description: get(mapping.description).slice(0, 200), counterparty: get(mapping.counterparty).slice(0, 100), notes: get(mapping.notes).slice(0, 1000), tags: get(mapping.tags).split(/[\s,;]+/).filter(Boolean).slice(0, 20), categoryId: cat?.id ?? null });
        out.duplicate = seen.has(dupKey(acct.id, date, amountMinor, type, out.description));
        seen.add(dupKey(acct.id, date, amountMinor, type, out.description)); // duplicates inside the file count too
      } catch (e) { out.errors.push(e.message); }
      rows.push(out);
    });
    return { rows, headers: head };
  }
  const dupKey = (a, d, m, t, desc) => createHash('sha1').update([a, d, m, t, (desc || '').toLowerCase().replace(/\s+/g, ' ')].join('|')).digest('hex');
  function normaliseDate(x) {
    if (isDateStr(x)) return x; const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(x); if (!m) return null;
    const d = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; return isDateStr(d) ? d : null; // day first, as is usual in Nigeria
  }
  const IMP = ['csv', 'mapping', 'defaults', 'skipDuplicates', 'confirm', 'batchId'];
  const bodyLimit = 1024 * 1024;
  router.add('POST', `${P}/import/preview`, use(async ({ user, body }) => {
    const b = allowKeys(v.object(body), IMP), a = await analyse(user, b.csv, v.object(b.mapping ?? {}, 'mapping'), v.object(b.defaults ?? {}, 'defaults'));
    return { headers: a.headers, total: a.rows.length, valid: a.rows.filter((r) => !r.errors.length).length, duplicates: a.rows.filter((r) => r.duplicate).length, invalid: a.rows.filter((r) => r.errors.length).length, preview: a.rows.slice(0, 50) };
  }), { bodyLimit });
  router.add('POST', `${P}/import/confirm`, use(async ({ user, body }) => {
    const b = allowKeys(v.object(body), IMP); if (b.confirm !== true) throw badRequest('Importing must be confirmed (confirm: true)', 'confirmation_required');
    if (typeof b.batchId !== 'string' || b.batchId.length < 8) throw badRequest('batchId is required so a retry cannot import the file twice', 'idempotency_required');
    const a = await analyse(user, b.csv, v.object(b.mapping ?? {}, 'mapping'), v.object(b.defaults ?? {}, 'defaults')), skip = b.skipDuplicates !== false;
    const bad = a.rows.filter((r) => r.errors.length); if (bad.length) throw badRequest(`${bad.length} rows have problems (first: row ${bad[0].row}: ${bad[0].errors[0]}). Fix the file and preview again.`, 'invalid_rows');
    const todo = a.rows.filter((r) => !(skip && r.duplicate));
    const result = await storage.transaction(async () => { let created = 0, replayed = 0;
      for (const r of todo) { const x = await txn.insertTx(user, { type: r.type, accountId: r.accountId, amountMinor: r.amountMinor, categoryId: r.categoryId, description: r.description, counterparty: r.counterparty, notes: r.notes, tags: r.tags, date: r.date, time: '12:00' }, { key: `imp:${createHash('sha1').update(`${b.batchId}:${r.row}`).digest('hex')}`, source: 'import' }); x.replayed ? replayed++ : created++; }
      return { created, replayed }; });
    await s.audit.record({ actorId: user.id, action: 'finance.import_csv', meta: { created: result.created } });
    return { ...result, skippedDuplicates: a.rows.length - todo.length };
  }), { bodyLimit });
}
