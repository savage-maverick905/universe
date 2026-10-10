// Display formatting only. All real arithmetic happens on the server in integer minor units; the browser never adds up money.
const EXP = { NGN: 2, USD: 2, GBP: 2, EUR: 2, GHS: 2, KES: 2, ZAR: 2, XOF: 0 }, SYM = { NGN: '₦', USD: '$', GBP: '£', EUR: '€', GHS: 'GH₵', KES: 'KSh', ZAR: 'R', XOF: 'CFA' };
export function setCurrencies(list) { for (const c of list || []) { EXP[c.code] = c.exp; SYM[c.code] = c.symbol || c.code; } }
const group = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
export function money(minor, code = 'NGN', { sign = false, compact = false } = {}) {
  const exp = EXP[code] ?? 2, scale = 10 ** exp, neg = minor < 0, abs = Math.abs(minor), sym = SYM[code] || code;
  if (compact && abs >= 100000 * scale) { const m = abs / scale; return `${neg ? '-' : ''}${sym}${m >= 1e9 ? `${(m / 1e9).toFixed(1)}B` : m >= 1e6 ? `${(m / 1e6).toFixed(1)}M` : `${Math.round(m / 1e3)}k`}`; }
  const whole = Math.floor(abs / scale), frac = abs % scale;
  return `${neg ? '-' : sign && minor > 0 ? '+' : ''}${sym}${group(String(whole))}${exp ? `.${String(frac).padStart(exp, '0')}` : ''}`;
}
// minor units -> a plain decimal string for editing in an input ("3500.50")
export function decimal(minor, code = 'NGN') { const exp = EXP[code] ?? 2, abs = Math.abs(minor), s = 10 ** exp; return `${minor < 0 ? '-' : ''}${Math.floor(abs / s)}${exp ? `.${String(abs % s).padStart(exp, '0')}` : ''}`; }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function day(d, today) {
  if (!d) return '';
  if (d === today) return 'Today';
  const [y, m, dd] = d.split('-').map(Number), t = new Date(Date.UTC(y, m - 1, dd));
  if (today) { const diff = Math.round((Date.parse(`${today}T00:00:00Z`) - t) / 864e5); if (diff === 1) return 'Yesterday'; }
  return `${DAYS[t.getUTCDay()]}, ${dd} ${MONTHS[m - 1]}${today && y !== Number(today.slice(0, 4)) ? ` ${y}` : ''}`;
}
export const monthLabel = (k) => { const [y, m] = k.split('-'); return k.length === 7 ? `${MONTHS[+m - 1]} ${y.slice(2)}` : k.length === 4 ? k : `${+k.slice(8)} ${MONTHS[+k.slice(5, 7) - 1]}`; };
export const TYPE_LABEL = { income: 'Income', expense: 'Expense', transfer: 'Transfer', refund: 'Refund', adjustment: 'Adjustment', loan_out: 'Loan given', loan_in: 'Loan received', repay_in: 'Repayment received', repay_out: 'Repayment made' };
export const POSITIVE = new Set(['income', 'refund', 'loan_in', 'repay_in']);
export function signedFor(t, acctId) { // how a transaction moves THIS view's money
  if (t.type === 'transfer') return acctId && acctId === t.toAccountId ? (t.toAmountMinor ?? t.amountMinor) : -(t.amountMinor + (t.feeMinor || 0));
  if (t.type === 'adjustment') return t.direction === 'decrease' ? -t.amountMinor : t.amountMinor;
  return POSITIVE.has(t.type) ? t.amountMinor : -t.amountMinor;
}
