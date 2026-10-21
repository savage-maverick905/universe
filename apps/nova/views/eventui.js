// Events and activities: the row shown in lists, and the editor. The server enforces every rule; this file only presents them.
import { api, h, toast } from '../services/api.js';
import { icon } from '/shared/icons.js';
import { dialog, closer } from '/shared/ui.js';
import { S, select, field, projectOptions, confirmBox, todayStr, fmtDate, addDays, diffDays } from '../lib.js';

export const fmtTime = (t) => { if (!t) return ''; const hh = +t.slice(0, 2); return `${hh % 12 || 12}:${t.slice(3, 5)} ${hh < 12 ? 'AM' : 'PM'}`; };
export const whenText = (e) => (e.allDay ? 'All day' : `${fmtTime(e.startTime)}${e.endTime ? ` – ${fmtTime(e.endTime)}` : ''}`);

export function eventRow(e, onChange) {
  const meta = [e.dayCount > 1 ? `Day ${e.dayIndex} of ${e.dayCount}` : '', e.kind !== 'event' ? S.meta.eventKinds.find((k) => k.id === e.kind)?.label : '', e.location, e.projectName].filter(Boolean).join(' · ');
  return h('button', { class: `event${e.clash ? ' clash' : ''}`, type: 'button', onclick: () => openEvent(e, { onChange }) },
    h('span', { class: 'ev-time' }, e.allDay ? 'All day' : fmtTime(e.startTime), e.endTime && !e.allDay ? h('small', {}, fmtTime(e.endTime)) : null),
    h('span', { class: 'ev-main' }, h('b', {}, e.title), meta ? h('small', {}, meta) : null),
    h('span', { class: 'task-badges' }, e.recurrence ? h('span', { class: 'rec', title: 'Repeats' }, icon('repeat')) : null, e.clash ? h('span', { class: 'badge bad', title: 'Overlaps another event' }, 'Clash') : null));
}

export async function openEvent(ev, { onChange = () => {}, date = null } = {}) {
  const canWrite = S.meta.canWriteTasks, isNew = !ev;
  const e = ev ? (await api('GET', `/events/${ev.id}`).catch((x) => { toast(x.message); return null; }))?.event : { title: '', description: '', location: '', kind: 'event', date: date || todayStr(), endDate: null, allDay: false, startTime: '09:00', endTime: '10:00', projectId: null, recurrence: null, dayTimes: {} };
  if (!e) return;
  const err = h('p', { class: 'err', role: 'alert' });
  const f = {
    title: h('input', { value: e.title, maxlength: 200, required: '', autofocus: '', placeholder: 'e.g. Dentist, Football practice, Team call' }),
    kind: select(S.meta.eventKinds.map((k) => [k.id, k.label]), e.kind, () => {}, 'Type'),
    allDay: h('input', { type: 'checkbox', checked: e.allDay ? '' : null }),
    date: h('input', { type: 'date', value: e.date, required: '' }), endDate: h('input', { type: 'date', value: e.endDate || '' }),
    start: h('input', { type: 'time', value: e.startTime || '' }), end: h('input', { type: 'time', value: e.endTime || '' }),
    location: h('input', { value: e.location, maxlength: 200, placeholder: 'Optional' }), description: h('textarea', { rows: 2, maxlength: 4000 }, e.description),
    project: select(projectOptions(), e.projectId || '', () => {}, 'Project'),
  };
  const rec = e.recurrence, freq = select([['', 'Does not repeat'], ['daily', 'Every day'], ['weekly', 'Every week'], ['monthly', 'Every month'], ['yearly', 'Every year']], rec?.freq || '', () => draw(), 'Repeat');
  const until = h('input', { type: 'date', value: rec?.until || '', 'aria-label': 'Repeat until' }), every = h('input', { type: 'number', min: 1, max: 99, value: rec?.interval || 1, 'aria-label': 'Repeat every' });
  const own = { ...(e.dayTimes || {}) }, dayBox = h('div', { class: 'daytimes' }); // different times on different days of a multi-day event
  const drawDays = () => {
    const a = f.date.value, b = f.endDate.value;
    if (!a || !b || b <= a || diffDays(a, b) > 30) { dayBox.replaceChildren(); dayBox.hidden = true; return; }
    dayBox.hidden = false; const rows = [];
    for (let i = 0; i <= diffDays(a, b); i++) {
      const day = addDays(a, i), cur = own[day], mode = cur ? (cur.allDay ? 'allday' : 'custom') : 'same';
      const s1 = h('input', { type: 'time', value: cur?.startTime || f.start.value || '09:00', 'aria-label': `Start on ${day}` }), e1 = h('input', { type: 'time', value: cur?.endTime || '', 'aria-label': `End on ${day}` });
      const tw = h('span', { class: 'row tight' }, s1, e1), m = select([['same', 'Same as above'], ['allday', 'All day'], ['custom', 'Own times']], mode, () => sync(), `Times on ${day}`);
      const sync = () => { if (m.value === 'same') delete own[day]; else if (m.value === 'allday') own[day] = { allDay: true }; else own[day] = { startTime: s1.value, endTime: e1.value || null }; tw.hidden = m.value !== 'custom'; };
      tw.hidden = mode !== 'custom'; s1.addEventListener('change', sync); e1.addEventListener('change', sync);
      rows.push(h('div', { class: 'dt-row' }, h('b', {}, fmtDate(day)), m, tw));
    }
    dayBox.replaceChildren(h('h3', {}, 'Times for each day'), h('p', { class: 'fine' }, 'Leave a day as "Same as above" to use the main start and end time.'), ...rows);
  };
  f.date.addEventListener('change', drawDays); f.endDate.addEventListener('change', drawDays); drawDays();
  const recBox = h('div', { class: 'rec-box' }), times = h('div', { class: 'two' }, field('Starts', f.start), field('Ends', f.end));
  const draw = () => { times.hidden = f.allDay.checked; recBox.replaceChildren(...(freq.value ? [h('div', { class: 'row' }, 'Every', every, { daily: 'day(s)', weekly: 'week(s)', monthly: 'month(s)', yearly: 'year(s)' }[freq.value]), field('Repeat until (optional)', until)] : [])); };
  f.allDay.addEventListener('change', draw); draw();
  if (!canWrite) { Object.values(f).forEach((x) => x.setAttribute?.('disabled', '')); freq.setAttribute('disabled', ''); }
  const read = () => ({ title: f.title.value, kind: f.kind.value, description: f.description.value, location: f.location.value, date: f.date.value, endDate: f.endDate.value || null, allDay: f.allDay.checked,
    startTime: f.allDay.checked ? null : f.start.value || null, endTime: f.allDay.checked ? null : f.end.value || null, projectId: f.project.value || null,
    dayTimes: f.endDate.value && f.endDate.value > f.date.value ? Object.fromEntries(Object.entries(own).filter(([k]) => k >= f.date.value && k <= f.endDate.value)) : {},
    recurrence: freq.value ? { freq: freq.value, interval: Number(every.value) || 1, until: until.value || null } : null });
  const save = h('button', { class: 'btn', type: 'submit' }, isNew ? 'Add to schedule' : 'Save');
  const submit = async (x) => { x.preventDefault(); err.textContent = ''; save.disabled = true;
    try { await api(isNew ? 'POST' : 'PATCH', isNew ? '/events' : `/events/${e.id}`, read()); d.close(); toast(isNew ? 'Added to your schedule' : 'Event saved'); onChange(); }
    catch (z) { err.textContent = z.message; save.disabled = false; } };
  const actions = [save, closer('Cancel')];
  if (!isNew && canWrite && S.meta.canDeleteTasks) actions.push(h('button', { type: 'button', class: 'btn ghost danger', onclick: async () => {
    if (await confirmBox('Delete this event?', `"${e.title}" will be removed${e.recurrence ? ', along with every repeat of it' : ''}.`)) { try { await api('DELETE', `/events/${e.id}`); d.close(); toast('Event deleted'); onChange(); } catch (z) { err.textContent = z.message; } } } }, icon('trash'), 'Delete'));
  const d = dialog(isNew ? 'New event or activity' : 'Event', h('form', { class: 'task-form', onsubmit: submit }, field('What', f.title),
    h('div', { class: 'two' }, field('Type', f.kind), field('Project', f.project)), h('label', { class: 'toggle-row' }, f.allDay, 'All day'),
    h('div', { class: 'two' }, field('Date', f.date), field('Ends on (multi-day)', f.endDate)), times, dayBox, field('Where', f.location), field('Notes', f.description),
    h('h3', {}, 'Repeat'), freq, recBox, err, h('div', { class: 'row actions' }, ...(canWrite ? actions : [closer('Close')]))));
}
