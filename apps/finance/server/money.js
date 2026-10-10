// Money is ALWAYS an integer count of minor units (kobo, cents). No floating point is used anywhere:
// parsing works on digit strings and BigInt, formatting works on integer division.
export const CURRENCIES = {
  NGN: { exp: 2, symbol: '₦', name: 'Nigerian naira' }, USD: { exp: 2, symbol: '$', name: 'US dollar' },
  GBP: { exp: 2, symbol: '£', name: 'Pound sterling' }, EUR: { exp: 2, symbol: '€', name: 'Euro' },
  GHS: { exp: 2, symbol: 'GH₵', name: 'Ghanaian cedi' }, KES: { exp: 2, symbol: 'KSh', name: 'Kenyan shilling' },
  ZAR: { exp: 2, symbol: 'R', name: 'South African rand' }, XOF: { exp: 0, symbol: 'CFA', name: 'West African CFA franc' },
};
export const MAX_MINOR = 10 ** 13; // 100 billion naira: far below Number.MAX_SAFE_INTEGER, so sums stay exact
export const CODE_RE = /^[A-Z]{3,5}$/;

// custom: [{ code, exp, symbol }] from the user's settings (the extensible part of the currency model)
export function currencyInfo(code, custom = []) {
  const c = CURRENCIES[code] || custom.find((x) => x.code === code);
  return c ? { code, exp: c.exp, symbol: c.symbol || code, name: c.name || code } : null;
}

export class MoneyError extends Error { constructor(m) { super(m); this.name = 'MoneyError'; } }

// "3,500", "₦3,500.50", "3.5k", "NGN 41000", 3500 -> integer minor units. Throws MoneyError on anything unclear.
export function parseMoney(input, code = 'NGN', custom = []) {
  const info = currencyInfo(code, custom);
  if (!info) throw new MoneyError(`Unknown currency ${code}`);
  let s = typeof input === 'number' ? (Number.isFinite(input) ? String(input) : '') : String(input ?? '');
  if (/e/i.test(s) && typeof input === 'number') throw new MoneyError('Amount is too large or too small to read');
  s = s.trim().toLowerCase().replace(/[\s,_']/g, '');
  for (const sym of [info.symbol.toLowerCase(), code.toLowerCase(), '₦', 'ngn']) if (sym && s.startsWith(sym)) { s = s.slice(sym.length); break; }
  let mult = 1n;
  if (/[km]$/.test(s)) { mult = s.endsWith('k') ? 1000n : 1000000n; s = s.slice(0, -1); }
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new MoneyError('Amount must be a plain number like 3500 or 3,500.50');
  const frac = m[2] || '';
  if (mult === 1n && frac.length > info.exp) throw new MoneyError(`${code} amounts have at most ${info.exp} decimal places`);
  const scale = 10n ** BigInt(info.exp);
  // whole.frac * mult * scale, exactly
  const fracDigits = frac.length;
  const total = (BigInt(m[1]) * 10n ** BigInt(fracDigits) + BigInt(frac || '0')) * mult * scale / 10n ** BigInt(fracDigits);
  if ((BigInt(m[1]) * 10n ** BigInt(fracDigits) + BigInt(frac || '0')) * mult * scale % 10n ** BigInt(fracDigits) !== 0n) throw new MoneyError(`${code} amounts have at most ${info.exp} decimal places`);
  if (total > BigInt(MAX_MINOR)) throw new MoneyError('Amount is too large');
  return Number(total);
}

// Validates an amount that arrives already in minor units (API bodies). Must be a positive safe integer.
export function checkMinor(x, name = 'amount', { allowZero = false } = {}) {
  if (!Number.isSafeInteger(x) || x < (allowZero ? 0 : 1) || x > MAX_MINOR) throw new MoneyError(`${name} must be ${allowZero ? 'zero or ' : ''}a positive whole number of minor units (max ${MAX_MINOR})`);
  return x;
}

const group = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
export function formatMoney(minor, code = 'NGN', custom = [], { sign = false } = {}) {
  const info = currencyInfo(code, custom) || { exp: 2, symbol: code };
  const neg = minor < 0, abs = Math.abs(minor), scale = 10 ** info.exp;
  const whole = Math.floor(abs / scale), frac = abs % scale; // integer ops on safe integers: exact
  const f = info.exp ? `.${String(frac).padStart(info.exp, '0')}` : '';
  return `${neg ? '-' : sign && minor > 0 ? '+' : ''}${info.symbol}${group(String(whole))}${f}`;
}
// Plain decimal string for CSV/exports: 350050 -> "3500.50"
export function toDecimal(minor, code = 'NGN', custom = []) {
  const info = currencyInfo(code, custom) || { exp: 2 };
  const neg = minor < 0, abs = Math.abs(minor), scale = 10 ** info.exp;
  return `${neg ? '-' : ''}${Math.floor(abs / scale)}${info.exp ? `.${String(abs % scale).padStart(info.exp, '0')}` : ''}`;
}
