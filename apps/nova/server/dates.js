// Nova dates. Task and project dates are CALENDAR dates ("YYYY-MM-DD") with no time of day and no time zone, so a task
// due on 2026-10-12 is due on that day wherever you are. Only "what is today?" depends on the person's time zone.
// All arithmetic runs on UTC midnights, so daylight-saving changes can never shift a date.
const RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY = 86_400_000;

export const toMs = (s) => { const m = RE.exec(s); return Date.UTC(+m[1], +m[2] - 1, +m[3]); };
export const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);
export function isDate(s) {
  if (typeof s !== 'string' || !RE.test(s)) return false;
  const ms = toMs(s);
  return Number.isFinite(ms) && fromMs(ms) === s && +s.slice(0, 4) >= 1970 && +s.slice(0, 4) <= 2200;
}
export const addDays = (s, n) => fromMs(toMs(s) + n * DAY);
export const diffDays = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY); // b minus a
export const weekday = (s) => new Date(toMs(s)).getUTCDay(); // 0 = Sunday
export const mondayOf = (s) => addDays(s, -((weekday(s) + 6) % 7));

// anchor + n months, keeping the anchor's day of month but clamping to the month's length (Jan 31 + 1 month = Feb 28/29).
export function addMonths(anchor, n) {
  const [y, m, d] = anchor.split('-').map(Number);
  const total = y * 12 + (m - 1) + n, ty = Math.floor(total / 12), tm = total % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return fromMs(Date.UTC(ty, tm, Math.min(d, last)));
}

export function validTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; } catch { return false; }
}
// Today's calendar date in a time zone.
export function todayIn(tz = 'UTC', now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: validTimeZone(tz) ? tz : 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

export const FREQS = ['daily', 'weekly', 'monthly', 'yearly'];

// The first occurrence of a recurring task that is AFTER `due` and not before `today`.
// "Not before today": finishing a daily task three days late gives you today's copy, not three overdue copies.
// Returns null when the series is over (past its end date or out of repeats).
export function nextOccurrence(rec, due, today) {
  if (!rec || !isDate(due)) return null;
  if (rec.remaining != null && rec.remaining <= 0) return null;
  const interval = rec.interval || 1, anchor = isDate(rec.anchor) ? rec.anchor : due;
  const lower = toMs(today) > toMs(due) ? today : addDays(due, 1); // earliest date allowed
  let out = null;
  if (rec.freq === 'daily') {
    const k = Math.max(0, Math.ceil(diffDays(anchor, lower) / interval));
    out = addDays(anchor, k * interval);
  } else if (rec.freq === 'weekly') {
    const days = rec.byDay?.length ? rec.byDay : [weekday(anchor)], base = mondayOf(anchor);
    for (let i = 0; i <= 7 * interval + 7 && !out; i++) {
      const d = addDays(lower, i);
      if (toMs(d) >= toMs(anchor) && days.includes(weekday(d)) && Math.floor(diffDays(base, d) / 7) % interval === 0) out = d;
    }
  } else if (rec.freq === 'monthly' || rec.freq === 'yearly') {
    const step = rec.freq === 'yearly' ? 12 * interval : interval;
    const [ay, am] = anchor.split('-').map(Number), [ly, lm] = lower.split('-').map(Number);
    let k = Math.max(0, Math.floor((ly * 12 + lm - (ay * 12 + am)) / step) - 1);
    for (let i = 0; i < 400 && !out; i++, k++) { const d = addMonths(anchor, k * step); if (toMs(d) >= toMs(lower)) out = d; }
  }
  if (!out) return null;
  if (rec.until && toMs(out) > toMs(rec.until)) return null;
  return out;
}
