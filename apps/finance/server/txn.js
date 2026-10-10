// Creating, editing and voiding transactions. ONE code path used by the forms, the AI confirmation, imports,
// recurring bills and the debt screens, so every rule below applies no matter how a transaction arrives.
import { createHash } from 'node:crypto';
import { HttpError, badRequest, conflict } from '../../../shared/errors.js';
import { newId, nowIso } from '../../../shared/ids.js';
import { parseMoney, checkMinor, MoneyError, currencyInfo } from './money.js';
import { isDateStr, zonedToUtc, localDateOf, todayIn, addDays } from './dates.js';
import { TYPES, DEBT_TYPES, accountBalances, isPosted } from './ledger.js';
import { byId, pathOf } from './categories.js';

export const USER_TYPES = ['income', 'expense', 'transfer', 'refund', 'adjustment'];
const FIELDS = ['type', 'amount', 'amountMinor', 'accountId', 'toAccountId', 'toAmount', 'toAmountMinor', 'fee', 'feeMinor', 'feeCategoryId', 'direction',
  'categoryId', 'description', 'counterparty', 'tags', 'notes', 'date', 'time', 'refundOf', 'goalId', 'idempotencyKey', 'expectedVersion'];
const str = (x, name, max) => { if (x == null || x === '') return ''; if (typeof x !== 'string' || x.trim().length > max) throw badRequest(`${name} must be text of at most ${max} characters`); return x.trim(); };

export function makeTxnService(store) {
  const { col, all, own, audit, diff, storage } = store;
  const fail = (e) => { if (e instanceof MoneyError) throw badRequest(e.message, 'invalid_amount'); throw e; };

  // Turns untrusted input into a complete, validated document (or throws 400/409). Synchronous after the data is loaded.
  function build(ctx, raw, { existing = null, allowDebt = false } = {}) {
    const { settings, accounts, cats, refundsOf } = ctx, custom = settings.customCurrencies || [];
    for (const k of Object.keys(raw)) if (!FIELDS.includes(k)) throw badRequest(`Unknown field: ${k}`, 'validation_error');
    const m = { ...(existing ? pick(existing) : {}), ...raw };
    const type = m.type;
    if (existing && raw.type && raw.type !== existing.type) throw badRequest('A transaction\'s type cannot change. Void it and enter a new one.', 'type_locked');
    if (!TYPES.includes(type)) throw badRequest(`type must be one of: ${USER_TYPES.join(', ')}`, 'validation_error');
    if (DEBT_TYPES.includes(type) && !allowDebt) throw badRequest('Loans and repayments are recorded from the Debts screen so the debt stays in step.', 'use_debts');
    const A = byId(accounts), C = byId(cats);
    const acct = A.get(m.accountId); if (!acct) throw badRequest('Choose one of your accounts', 'unknown_account');
    if (acct.archived && !existing) throw badRequest(`${acct.name} is archived. Restore it to record new transactions.`, 'account_archived');
    const lockedDebt = existing?.debtId && (raw.amount !== undefined || raw.amountMinor !== undefined) ;
    const doc = { type, accountId: acct.id, currency: acct.currency };
    try {
      if (raw.amountMinor !== undefined || raw.amount !== undefined || !existing) doc.amountMinor = raw.amountMinor !== undefined ? checkMinor(raw.amountMinor, 'amountMinor') : parseMoney(raw.amount, acct.currency, custom);
      else doc.amountMinor = existing.amountMinor;
      if (doc.amountMinor < 1) throw new MoneyError('Amount must be greater than zero');
    } catch (e) { fail(e); }
    if (existing?.debtId && doc.amountMinor !== existing.amountMinor) throw conflict('The amount of a loan or repayment cannot be edited. Void it and record it again.', 'debt_amount_locked');
    if (existing && (acct.id !== existing.accountId) && existing.debtId && acct.currency !== existing.currency) throw badRequest('Account currency must match', 'currency_mismatch');

    const cat = (id, kind, label) => {
      if (id == null || id === '') return null;
      const c = C.get(id); if (!c) throw badRequest(`${label}: category not found`, 'unknown_category');
      if (c.kind !== kind) throw badRequest(`${label}: choose an ${kind} category`, 'category_kind');
      if (c.archived && !(existing && existing.categoryId === id)) throw badRequest(`${label}: "${pathOf(C, id)}" is archived`, 'category_archived');
      return c.id;
    };
    if (type === 'income') doc.categoryId = cat(m.categoryId, 'income', 'Category');
    else if (type === 'expense') doc.categoryId = cat(m.categoryId, 'expense', 'Category');
    else if (type === 'refund') {
      if (m.refundOf) {
        const orig = ctx.original; if (!orig || orig.id !== m.refundOf || orig.type !== 'expense' || !isPosted(orig)) throw badRequest('A refund must point to one of your recorded expenses', 'bad_refund_target');
        if (orig.currency !== acct.currency) throw badRequest('A refund must be in the same currency as the original expense', 'currency_mismatch');
        const already = (refundsOf || []).filter((r) => isPosted(r) && r.id !== existing?.id).reduce((s, r) => s + r.amountMinor, 0);
        if (doc.amountMinor > orig.amountMinor - already) throw conflict(`Only ${orig.amountMinor - already} minor units of that expense can still be refunded`, 'refund_exceeds');
        doc.refundOf = orig.id; doc.categoryId = orig.categoryId ?? null; // refunds reduce spending in the ORIGINAL category
      } else doc.categoryId = cat(m.categoryId, 'expense', 'Category');
    } else if (m.categoryId) throw badRequest(`${type} transactions do not take a category`, 'validation_error');
    else doc.categoryId = null;

    if (type === 'transfer') {
      const to = A.get(m.toAccountId); if (!to) throw badRequest('Choose the account the money goes to', 'unknown_account');
      if (to.id === acct.id) throw badRequest('Choose two different accounts', 'same_account');
      if (to.archived && !(existing && existing.toAccountId === to.id)) throw badRequest(`${to.name} is archived`, 'account_archived');
      doc.toAccountId = to.id; doc.toCurrency = to.currency;
      try {
        if (to.currency === acct.currency) doc.toAmountMinor = doc.amountMinor;
        else {
          const given = raw.toAmountMinor !== undefined ? checkMinor(raw.toAmountMinor, 'toAmountMinor') : raw.toAmount !== undefined ? parseMoney(raw.toAmount, to.currency, custom) : existing?.toAmountMinor;
          if (!given) throw new MoneyError(`${acct.currency} to ${to.currency}: enter the amount that arrives in ${to.name}`);
          doc.toAmountMinor = given;
        }
        const fee = raw.feeMinor !== undefined ? checkMinor(raw.feeMinor, 'feeMinor', { allowZero: true }) : raw.fee !== undefined ? (raw.fee === '' || raw.fee == null ? 0 : parseMoney(raw.fee, acct.currency, custom)) : existing?.feeMinor || 0;
        doc.feeMinor = fee;
      } catch (e) { fail(e); }
      doc.feeCategoryId = doc.feeMinor ? cat(m.feeCategoryId, 'expense', 'Fee category') : null;
    } else if (m.toAccountId || raw.feeMinor || raw.fee) throw badRequest('Only transfers have a destination account or fee', 'validation_error');

    if (type === 'adjustment') {
      if (!['increase', 'decrease'].includes(m.direction)) throw badRequest('direction must be "increase" or "decrease"', 'validation_error');
      doc.direction = m.direction;
    } else if (raw.direction) throw badRequest('direction only applies to adjustments', 'validation_error');

    doc.description = str(m.description, 'description', 200); doc.counterparty = str(m.counterparty, 'counterparty', 100); doc.notes = str(m.notes, 'notes', 1000);
    if (!Array.isArray(m.tags ?? [])) throw badRequest('tags must be a list', 'validation_error');
    doc.tags = [...new Set((m.tags || []).map((t) => str(t, 'tag', 30).toLowerCase()).filter(Boolean))].slice(0, 20);
    if (m.goalId) { if (!ctx.goalIds.has(m.goalId)) throw badRequest('Unknown goal', 'unknown_goal'); doc.goalId = m.goalId; } else doc.goalId = null;
    if (existing?.debtId) { doc.debtId = existing.debtId; }
    if (ctx.debtId) doc.debtId = ctx.debtId;

    // when it happened: local calendar date + the instant, in the user's own time zone
    const tz = settings.timezone, today = todayIn(tz, ctx.now);
    let date = raw.date ?? existing?.localDate ?? today, time = raw.time;
    if (!isDateStr(date)) throw badRequest('date must look like 2026-01-31', 'invalid_date');
    if (date < '2000-01-01' || date > addDays(today, 366)) throw badRequest('That date looks wrong. Check the year.', 'invalid_date');
    if (time === undefined) time = existing && raw.date === undefined ? localTime(existing.occurredAt, tz) : date === today ? localTime(ctx.now.toISOString(), tz) : '12:00';
    try { doc.occurredAt = zonedToUtc(date, time, tz); } catch { throw badRequest('time must look like 14:30', 'invalid_date'); }
    doc.localDate = localDateOf(doc.occurredAt, tz);
    return doc;
  }
  const pick = (t) => ({ type: t.type, accountId: t.accountId, toAccountId: t.toAccountId, toAmountMinor: t.toAmountMinor, feeMinor: t.feeMinor, feeCategoryId: t.feeCategoryId, direction: t.direction, categoryId: t.categoryId, description: t.description, counterparty: t.counterparty, tags: t.tags, notes: t.notes, refundOf: t.refundOf, goalId: t.goalId });
  const localTime = (iso, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

  async function context(ownerId, { now = new Date(), refundOf = null, debtId = null } = {}) {
    const [settings, accounts, cats, goals] = await Promise.all([col.settings.get(ownerId), all(col.accounts, ownerId), all(col.cats, ownerId), all(col.goals, ownerId)]);
    const ctx = { settings, accounts, cats, now, goalIds: new Set(goals.map((g) => g.id)), debtId };
    if (refundOf) { ctx.original = await col.txns.get(refundOf); if (ctx.original && ctx.original.ownerId !== ownerId) ctx.original = null; ctx.refundsOf = await col.txns.find({ where: { ownerId, refundOf }, limit: 10000 }); }
    return ctx;
  }
  const fingerprint = (d) => createHash('sha256').update(JSON.stringify([d.type, d.accountId, d.toAccountId ?? null, d.amountMinor, d.toAmountMinor ?? null, d.feeMinor ?? 0, d.categoryId ?? null, d.localDate, d.description, d.counterparty, d.direction ?? null, d.refundOf ?? null, d.debtId ?? null, d.goalId ?? null])).digest('hex');
  const idemId = (ownerId, key) => `${ownerId}_${createHash('sha256').update(String(key)).digest('hex').slice(0, 32)}`;

  async function warningsFor(ownerId, doc) {
    const ids = new Set([doc.accountId, doc.toAccountId].filter(Boolean)), accounts = (await all(col.accounts, ownerId)).filter((a) => ids.has(a.id));
    const bal = accountBalances(accounts, (await all(col.txns, ownerId)).filter((t) => ids.has(t.accountId) || ids.has(t.toAccountId)));
    return accounts.filter((a) => (bal.get(a.id) || 0) < 0 && a.kind !== 'credit').map((a) => ({ code: 'negative_balance', accountId: a.id, message: `${a.name} is now below zero. If that is not right, an opening balance or an earlier transaction may be missing.` }));
  }

  // Idempotent insert. MUST be called inside storage.transaction (so a failure undoes everything, including callers' other writes).
  // The same key + same content returns the original transaction; the same key with different content is refused.
  async function insertTx(user, raw, { source = 'manual', key, allowDebt = false, debtId = null, extra = {} } = {}) {
    const idempotencyKey = key ?? raw.idempotencyKey;
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 100) throw badRequest('idempotencyKey (8-100 characters) is required so a retry can never create a duplicate', 'idempotency_required');
    const { idempotencyKey: _k, ...body } = raw;
    const ctx = await context(user.id, { refundOf: body.refundOf, debtId });
    const iid = idemId(user.id, idempotencyKey), prior = await col.idem.get(iid), doc = build(ctx, body, { allowDebt });
    if (prior) {
      if (prior.fingerprint !== fingerprint(doc)) throw new HttpError(422, 'That idempotency key was already used for a different transaction.', 'idempotency_mismatch');
      return { transaction: await col.txns.get(prior.resultId), replayed: true };
    }
    const now = nowIso();
    const t = await col.txns.insert({ id: newId('txn'), schemaVersion: 1, ownerId: user.id, ...doc, ...extra, status: 'posted', source, version: 1, createdBy: user.id, createdAt: now, updatedAt: now });
    await col.idem.insert({ id: iid, ownerId: user.id, fingerprint: fingerprint(doc), resultId: t.id, at: now });
    await audit(user.id, { action: 'transaction.create', entityType: 'transaction', entityId: t.id, source });
    return { transaction: t, replayed: false };
  }
  async function create(user, raw, opts = {}) {
    const result = await storage.transaction(() => insertTx(user, raw, opts));
    return result.replayed ? { ...result, warnings: [] } : { ...result, warnings: await warningsFor(user.id, result.transaction) };
  }

  async function update(user, id, raw) {
    const { expectedVersion, ...body } = raw;
    if (!Number.isInteger(expectedVersion)) throw badRequest('expectedVersion is required, so you never overwrite a newer edit', 'version_required');
    const result = await storage.transaction(async () => {
      const old = await own(col.txns, id, user.id, 'Transaction');
      if (old.status === 'voided') throw conflict('A voided transaction cannot be edited', 'voided');
      if (old.version !== expectedVersion) throw new HttpError(409, 'This transaction was changed somewhere else. Reload it and try again.', 'stale', null);
      const ctx = await context(user.id, { refundOf: old.type === 'refund' ? old.refundOf : null });
      const doc = build(ctx, body, { existing: old, allowDebt: !!old.debtId });
      const t = await col.txns.update(id, { ...doc, version: old.version + 1 });
      await audit(user.id, { action: 'transaction.update', entityType: 'transaction', entityId: id, source: 'manual', changes: diff(old, t, ['amountMinor', 'accountId', 'toAccountId', 'categoryId', 'description', 'counterparty', 'localDate', 'feeMinor', 'tags', 'notes', 'goalId']) });
      return t;
    });
    return { transaction: result, warnings: await warningsFor(user.id, result) };
  }

  async function voidTxn(user, id, { reason = '', expectedVersion } = {}) {
    return storage.transaction(async () => {
      const t = await own(col.txns, id, user.id, 'Transaction');
      if (t.status === 'voided') return t; // already done: safe to retry
      if (Number.isInteger(expectedVersion) && t.version !== expectedVersion) throw new HttpError(409, 'This transaction was changed somewhere else. Reload it and try again.', 'stale');
      if (t.type === 'expense') { const live = (await col.txns.find({ where: { ownerId: user.id, refundOf: t.id }, limit: 1000 })).filter(isPosted); if (live.length) throw conflict('This expense has refunds recorded against it. Void the refunds first.', 'has_refunds'); }
      if (t.fundsDebtId) throw conflict('This transaction created a loan. Delete or archive the debt instead.', 'funds_debt');
      const v = await col.txns.update(id, { status: 'voided', voidedAt: nowIso(), voidReason: String(reason).slice(0, 200), voidedBy: user.id, version: t.version + 1 });
      await audit(user.id, { action: 'transaction.void', entityType: 'transaction', entityId: id, source: 'manual' });
      return v;
    });
  }
  async function remove(user, id) {
    return storage.transaction(async () => {
      const t = await own(col.txns, id, user.id, 'Transaction');
      if (t.status !== 'voided') throw conflict('Void the transaction first. Only voided transactions can be deleted permanently.', 'not_voided');
      await col.txns.delete(id);
      await audit(user.id, { action: 'transaction.delete', entityType: 'transaction', entityId: id, source: 'manual' });
      return { ok: true };
    });
  }
  return { build, context, insertTx, create, update, voidTxn, remove, warningsFor, fingerprint, idemId };
}
