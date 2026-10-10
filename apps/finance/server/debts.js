// Debts: money you lent (receivable) or borrowed (payable). Repayments are cash movements but NOT income or expense.
import { isPosted } from './ledger.js';

export function debtState(debt, txns, today) {
  const linked = txns.filter((t) => t.debtId === debt.id && isPosted(t));
  const repaid = linked.filter((t) => t.type === 'repay_in' || t.type === 'repay_out').reduce((s, t) => s + t.amountMinor, 0);
  const writtenOff = (debt.events || []).filter((e) => e.kind === 'written_off').reduce((s, e) => s + e.amountMinor, 0);
  const outstanding = Math.max(0, debt.principalMinor - repaid - writtenOff);
  const status = debt.archived ? 'archived' : outstanding === 0 ? (writtenOff > 0 && repaid + writtenOff >= debt.principalMinor && repaid === 0 ? 'written_off' : 'settled') : 'open';
  return { repaidMinor: repaid, writtenOffMinor: writtenOff, outstandingMinor: outstanding, status,
    overdue: status === 'open' && !!debt.dueDate && !!today && debt.dueDate < today };
}

// Chronological history: creation, the cash movements linked to it, and write-offs/notes.
export function debtHistory(debt, txns) {
  const rows = [{ at: debt.startDate, kind: 'created', amountMinor: debt.principalMinor, note: debt.direction === 'lent' ? 'Money lent' : 'Money borrowed' }];
  for (const t of txns) if (t.debtId === debt.id) rows.push({ at: t.localDate, kind: t.status === 'voided' ? 'voided' : t.type, amountMinor: t.amountMinor, transactionId: t.id, note: t.description || '' });
  for (const e of debt.events || []) rows.push({ at: e.date, kind: e.kind, amountMinor: e.amountMinor || 0, note: e.note || '' });
  return rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}
export const repaymentType = (debt) => (debt.direction === 'lent' ? 'repay_in' : 'repay_out');
export const fundingType = (debt) => (debt.direction === 'lent' ? 'loan_out' : 'loan_in');
