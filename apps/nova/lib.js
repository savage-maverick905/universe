// Small helpers shared by Nova's screens. Text always goes in as text nodes (never innerHTML).
import { h, dialog, closer } from '/shared/ui.js';
import { icon } from '/shared/icons.js';

export const S = { meta: null, projects: [], me: null, today: '' };
export const label = (list, id) => list.find((x) => x.id === id)?.label ?? id ?? '';

// Calendar dates are plain "YYYY-MM-DD" strings. "Today" depends on the person's time zone setting.
export function todayStr() {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: S.meta?.settings?.timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  catch { return new Date().toISOString().slice(0, 10); }
}
const ms = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
export const addDays = (s, n) => new Date(ms(s) + n * 86_400_000).toISOString().slice(0, 10);
export const diffDays = (a, b) => Math.round((ms(b) - ms(a)) / 86_400_000);
export const weekdayOf = (s) => new Date(ms(s)).getUTCDay();
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtDate = (s, withYear) => (s ? `${MONTHS[+s.slice(5, 7) - 1]} ${+s.slice(8, 10)}${withYear || s.slice(0, 4) !== todayStr().slice(0, 4) ? `, ${s.slice(0, 4)}` : ''}` : '');
export function dueText(task) {
  if (!task.dueDate) return '';
  const d = diffDays(todayStr(), task.dueDate);
  if (task.status === 'done') return fmtDate(task.dueDate);
  if (d < 0) return `Overdue ${-d}d`; if (d === 0) return 'Today'; if (d === 1) return 'Tomorrow'; if (d < 7) return `In ${d} days`;
  return fmtDate(task.dueDate);
}

export const badge = (text, cls = '') => h('span', { class: `badge ${cls}`.trim() }, text);
export const prioBadge = (p) => h('span', { class: `badge prio ${p}` }, label(S.meta.priorities, p));

export function select(options, value, onchange, aria) {
  return h('select', { 'aria-label': aria, onchange: (e) => onchange(e.target.value) }, options.map(([v, t]) => h('option', { value: v, selected: v === value ? '' : null }, t)));
}
export const field = (text, el, hint) => h('label', {}, text, el, hint ? h('small', { class: 'hint' }, hint) : null);

export function progressBar(percent, color) {
  return h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': percent, 'aria-label': `${percent}% complete` }, h('i', { style: `width:${percent}%${color ? `;background:${color}` : ''}` }));
}
export function empty(ic, text, action) { return h('div', { class: 'empty' }, icon(ic), h('div', {}, text), action || null); }

// A yes/no question in a dialog. Resolves true only when the person presses the confirm button.
export function confirmBox(title, text, confirmLabel = 'Delete') {
  return new Promise((resolve) => {
    let ok = false;
    const d = dialog(title, h('p', { class: 'sub' }, text), h('div', { class: 'row actions' },
      h('button', { type: 'button', class: 'btn danger', onclick: (e) => { ok = true; e.currentTarget.closest('dialog').close(); } }, confirmLabel), closer('Cancel')));
    d.addEventListener('close', () => resolve(ok));
  });
}
export const projectOptions = (withNone = 'No project') => [['', withNone], ...S.projects.filter((p) => !p.archived).map((p) => [p.id, p.name])];
