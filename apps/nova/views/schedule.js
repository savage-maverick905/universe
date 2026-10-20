// Schedule: one agenda for the next weeks, mixing events and activities with the tasks that fall due.
import { api, h } from '../services/api.js';
import { icon } from '/shared/icons.js';
import { S, addDays, todayStr, fmtDate, diffDays, empty } from '../lib.js';
import { taskRow } from './taskui.js';
import { eventRow, openEvent } from './eventui.js';

let start = null;
export async function scheduleView({ frame, redraw }) {
  const today = todayStr(); start = start || today;
  const to = addDays(start, 13);
  let ev, tk;
  try { [ev, tk] = await Promise.all([api('GET', `/events?from=${start}&to=${to}`), api('GET', `/tasks?open=true&from=${start}&to=${to}&limit=500`)]); }
  catch (x) { frame('schedule', h('p', { class: 'err' }, x.message)); return; }
  const late = start === today ? (await api('GET', '/tasks?due=overdue&open=true&limit=50')).tasks : [];
  const events = Map.groupBy(ev.events, (e) => e.occurrenceDate), tasks = Map.groupBy(tk.tasks, (t) => t.dueDate);
  const dayName = (d) => (d === today ? 'Today' : d === addDays(today, 1) ? 'Tomorrow' : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${d}T00:00:00Z`).getUTCDay()]);
  const days = [];
  for (let i = 0; i < 14; i++) {
    const d = addDays(start, i), es = events.get(d) || [], ts = tasks.get(d) || [];
    if (!es.length && !ts.length && d !== today) continue;
    days.push(h('section', { class: `sday${d === today ? ' today' : ''}` }, h('div', { class: 'sday-h' }, h('b', {}, dayName(d)), h('span', {}, fmtDate(d)), h('button', { class: 'btn ghost small', 'aria-label': `Add event on ${fmtDate(d)}`, onclick: () => openEvent(null, { date: d, onChange: redraw }) }, icon('plus'))),
      es.length || ts.length ? h('div', { class: 'card flat' }, es.map((e) => eventRow(e, redraw)), ts.map((t) => taskRow(t, redraw))) : h('p', { class: 'fine' }, 'Nothing planned.')));
  }
  const shift = (n) => { start = addDays(start, n); redraw(); };
  frame('schedule', h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Schedule'), h('p', { class: 'sub' }, `${fmtDate(start, true)} – ${fmtDate(to, true)}`)),
    h('div', { class: 'row tight' }, h('button', { class: 'btn ghost small', 'aria-label': 'Previous two weeks', onclick: () => shift(-14) }, icon('back')), h('button', { class: 'btn ghost small', onclick: () => { start = today; redraw(); } }, 'Today'),
      h('button', { class: 'btn ghost small', 'aria-label': 'Next two weeks', onclick: () => shift(14) }, h('span', { class: 'flip' }, icon('back'))),
      S.meta.canWriteTasks ? h('button', { class: 'btn', onclick: () => openEvent(null, { onChange: redraw }) }, icon('plus'), 'New event') : null)),
    late.length ? h('section', { class: 'card attn' }, h('h3', {}, 'Overdue tasks'), h('div', { class: 'tasks' }, late.map((t) => taskRow(t, redraw)))) : null,
    days.length ? days : empty('calendar', 'Nothing scheduled for these two weeks.'),
    h('p', { class: 'fine' }, 'Events and activities sit alongside the tasks that are due. Overlapping events are marked "Clash".'));
}
