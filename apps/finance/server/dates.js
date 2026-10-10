// Calendar dates are plain "YYYY-MM-DD" strings in the USER'S time zone. A transaction stores the instant it happened
// (occurredAt, UTC) AND the local date it falls on (localDate), computed once with the time zone in force at the time.
// Every report buckets by localDate, so totals do not shift when someone travels or changes their time zone setting.
export const DEFAULT_TZ = 'Africa/Lagos';
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDateStr(s) {
  const m = DATE_RE.exec(String(s)); if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
export function isValidTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return typeof tz === 'string' && tz.length < 60; } catch { return false; } }

const fmtCache = new Map();
function parts(instant, tz) {
  let f = fmtCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); fmtCache.set(tz, f); }
  const o = {}; for (const p of f.formatToParts(instant)) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}
export const localDateOf = (instant, tz = DEFAULT_TZ) => { const p = parts(new Date(instant), tz); return `${String(p.y).padStart(4, '0')}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };
export const todayIn = (tz = DEFAULT_TZ, now = new Date()) => localDateOf(now, tz);

// Local wall-clock time in `tz` -> UTC ISO string. Handles DST by re-checking the offset.
export function zonedToUtc(date, time = '12:00', tz = DEFAULT_TZ) {
  if (!isDateStr(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Invalid date or time');
  const [y, mo, d] = date.split('-').map(Number), [h, mi] = time.split(':').map(Number);
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = parts(new Date(guess), tz), got = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    const diff = want - got; if (diff === 0) break; guess += diff;
  }
  return new Date(guess).toISOString();
}

export function addDays(date, n) { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
export function addMonths(date, n) { // clamps to the end of shorter months (31 Jan + 1 month = 28/29 Feb)
  const [y, m, d] = date.split('-').map(Number), t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
export const dow = (date) => new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
export const startOfWeek = (date, weekStartsOn = 1) => addDays(date, -((dow(date) - weekStartsOn + 7) % 7));
export const startOfMonth = (date) => `${date.slice(0, 7)}-01`;
export const endOfMonth = (date) => addDays(addMonths(startOfMonth(date), 1), -1);

// Named ranges for reports. Always inclusive on both ends, always local dates.
export function namedRange(name, today, { weekStartsOn = 1, from, to } = {}) {
  switch (name) {
    case 'today': return { from: today, to: today };
    case 'yesterday': { const y = addDays(today, -1); return { from: y, to: y }; }
    case 'this_week': { const s = startOfWeek(today, weekStartsOn); return { from: s, to: addDays(s, 6) }; }
    case 'last_week': { const s = addDays(startOfWeek(today, weekStartsOn), -7); return { from: s, to: addDays(s, 6) }; }
    case 'this_month': return { from: startOfMonth(today), to: endOfMonth(today) };
    case 'last_month': { const s = addMonths(startOfMonth(today), -1); return { from: s, to: endOfMonth(s) }; }
    case 'this_year': return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` };
    case 'last_30_days': return { from: addDays(today, -29), to: today };
    case 'custom': {
      if (!isDateStr(from) || !isDateStr(to)) throw new Error('Custom ranges need from and to dates like 2026-01-31');
      if (from > to) throw new Error('"from" must not be after "to"');
      if (daysBetween(from, to) > 3660) throw new Error('Ranges are limited to 10 years');
      return { from, to };
    }
    default: throw new Error(`Unknown range "${name}"`);
  }
}
export const RANGE_NAMES = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'this_year', 'last_30_days', 'custom'];

// The bucket a localDate falls in, for trend charts.
export function bucketKey(date, granularity, weekStartsOn = 1) {
  if (granularity === 'day') return date;
  if (granularity === 'week') return startOfWeek(date, weekStartsOn);
  if (granularity === 'month') return date.slice(0, 7);
  if (granularity === 'year') return date.slice(0, 4);
  throw new Error('granularity must be day, week, month or year');
}
