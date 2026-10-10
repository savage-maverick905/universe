// Debt operations shared by the Debts screens and the AI confirmation, so both follow identical rules.
import { createHash } from 'node:crypto';
import { badRequest, conflict, notFound } from '../../../shared/errors.js';
import { nowIso } from '../../../shared/ids.js';
import { debtState, fundingType, repaymentType } from './debts.js';
import { todayIn } from './dates.js';

const derived = (...p) => createHash('sha256').update(p.join('|')).digest('hex').slice(0, 40);

export function makeDebtOps(store, txn) {
  const { col, all, own, audit, storage } = store;
  // Creates the debt and (unless noCash) the cash movement in ONE all-or-nothing step. Safe to retry with the same key.
  async function createDebt(user, o) {
    const debtId = `debt_${derived(user.id, o.key)}`;
    return storage.transaction(async () => {
      const prior = await col.debts.get(debtId);
      if (prior) { if (prior.ownerId !== user.id) throw notFound('Debt not found'); return { debt: prior, replayed: true }; }
      const now = nowIso(), debt = { id: debtId, schemaVersion: 1, ownerId: user.id, direction: o.direction, counterparty: o.counterparty, principalMinor: o.principalMinor, currency: o.currency,
        startDate: o.startDate, dueDate: o.dueDate || null, notes: o.notes || '', events: [], archived: false, fundingTransactionId: null, version: 1, createdAt: now, updatedAt: now };
      await col.debts.insert(debt);
      let out = debt;
      if (!o.noCash) {
        const r = await txn.insertTx(user, { type: fundingType(debt), accountId: o.accountId, amountMinor: o.principalMinor, date: o.startDate, time: o.time,
          description: o.direction === 'lent' ? `Lent to ${o.counterparty}` : `Borrowed from ${o.counterparty}`, counterparty: o.counterparty }, { key: `fund:${debtId}`, allowDebt: true, debtId, extra: { fundsDebtId: debtId }, source: o.source });
        out = await col.debts.update(debtId, { fundingTransactionId: r.transaction.id });
      }
      await audit(user.id, { action: 'debt.create', entityType: 'debt', entityId: debtId, source: o.source || 'manual' });
      return { debt: out, replayed: false };
    });
  }
  async function repay(user, o) {
    return storage.transaction(async () => {
      const d = await own(col.debts, o.debtId, user.id, 'Debt'), st = await col.settings.get(user.id), today = todayIn(st.timezone);
      const txns = (await all(col.txns, user.id)).filter((t) => t.debtId === d.id), state = debtState(d, txns, today);
      const seen = await col.idem.get(txn.idemId(user.id, `rep:${d.id}:${o.key}`));
      if (!seen) {
        if (d.archived) throw conflict('This debt is archived', 'archived');
        if (o.amountMinor > state.outstandingMinor) throw conflict(`That is more than the ${state.outstandingMinor} minor units still outstanding.`, 'overpayment');
      }
      const r = await txn.insertTx(user, { type: repaymentType(d), accountId: o.accountId, amountMinor: o.amountMinor, date: o.date, time: o.time, notes: o.notes,
        description: d.direction === 'lent' ? `Repayment from ${d.counterparty}` : `Repayment to ${d.counterparty}`, counterparty: d.counterparty }, { key: `rep:${d.id}:${o.key}`, allowDebt: true, debtId: d.id, source: o.source });
      await audit(user.id, { action: 'debt.repayment', entityType: 'debt', entityId: d.id, source: o.source || 'manual' });
      const all2 = r.replayed ? txns : [...txns, r.transaction];
      return { transaction: r.transaction, replayed: r.replayed, debt: { ...d, ...debtState(d, all2, today) } };
    });
  }
  return { createDebt, repay };
}
