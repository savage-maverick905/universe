import { api, h, toast } from '../services/api.js';
import { icon } from '/shared/icons.js';
import { dialog, closer } from '/shared/ui.js';
import { S, addDays, weekdayOf, todayStr, fmtDate, empty } from '../lib.js';
import { taskRow, openTask } from './taskui.js';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
let cur = null; // first day of the month being shown, "YYYY-MM-01"

export async function calendarView({ frame, redraw }) {
  const today = todayStr(); cur = cur || `${today.slice(0, 7)}-01`;
  const gridStart = addDays(cur, -weekdayOf(cur)), gridEnd = addDays(gridStart, 41);
  let data; try { data = await api('GET', `/calendar?from=${gridStart}&to=${gridEnd}`); } catch (x) { frame('calendar', h('p', { class: 'err' }, x.message)); return; }
  const by = (arr, key) => { const m = new Map(); for (const x of arr) { const k = x[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
  const tasks = by(data.tasks, 'dueDate'), miles = by(data.milestones, 'dueDate'), dls = by(data.deadlines, 'deadline');
  const shift = (n) => { const [y, m] = cur.split('-').map(Number), t = y * 12 + (m - 1) + n; cur = `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}-01`; redraw(); };
  const dayDialog = (day) => {
    const ts = tasks.get(day) || [];
    dialog(fmtDate(day, true), (miles.get(day) || []).map((m) => h('p', { class: 'fine' }, `Milestone: ${m.title} (${m.projectName})`)), (dls.get(day) || []).map((p) => h('p', { class: 'fine' }, `Project deadline: ${p.name}`)),
      ts.length ? h('div', { class: 'tasks card flat' }, ts.map((t) => taskRow(t, () => { document.querySelector('dialog')?.close(); redraw(); }))) : empty('calendar', 'Nothing due on this day.'),
      h('div', { class: 'row actions' }, S.meta.canWriteTasks ? h('button', { class: 'btn', onclick: (e) => { e.currentTarget.closest('dialog').close(); openTask(null, { dueDate: day, onChange: redraw }); } }, icon('plus'), 'Add task for this day') : null, closer()));
  };
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const day = addDays(gridStart, i), inMonth = day.slice(0, 7) === cur.slice(0, 7), ts = tasks.get(day) || [], extra = [...(miles.get(day) || []).map((m) => `◆ ${m.title}`), ...(dls.get(day) || []).map((p) => `⚑ ${p.name}`)];
    const chips = [...extra.map((x) => h('span', { class: 'chip ms' }, x)), ...ts.map((t) => h('span', { class: `chip${t.status === 'done' ? ' done' : t.overdue ? ' late' : ''}` }, t.title))];
    cells.push(h('button', { type: 'button', class: `day${inMonth ? '' : ' out'}${day === today ? ' today' : ''}`, 'aria-label': `${fmtDate(day, true)}, ${ts.length} tasks due`, onclick: () => dayDialog(day) },
      h('span', { class: 'dn' }, String(+day.slice(8))), h('span', { class: 'chips' }, ...chips.slice(0, 3), chips.length > 3 ? h('span', { class: 'more' }, `+${chips.length - 3} more`) : null)));
  }
  const [y, m] = cur.split('-').map(Number);
  frame('calendar', h('div', { class: 'page-head' }, h('h1', {}, 'Calendar'), h('div', { class: 'row tight' },
    h('button', { class: 'btn ghost small', 'aria-label': 'Previous month', onclick: () => shift(-1) }, icon('back')), h('b', { class: 'month' }, `${MONTH_NAMES[m - 1]} ${y}`),
    h('button', { class: 'btn ghost small', 'aria-label': 'Next month', onclick: () => shift(1) }, h('span', { class: 'flip' }, icon('back'))), h('button', { class: 'btn ghost small', onclick: () => { cur = `${today.slice(0, 7)}-01`; redraw(); } }, 'Today'))),
    h('div', { class: 'cal' }, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => h('div', { class: 'dow' }, d)), cells),
    h('p', { class: 'fine' }, 'Shows due dates only. Nova does not sync with Google Calendar or any other calendar.'));
}
