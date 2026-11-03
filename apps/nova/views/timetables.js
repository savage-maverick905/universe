// Timetables: weekly plans that can be fixed ("6:00 to 7:00") or length-based ("1 hour", "30 min", placed one after another).
// Long-press an item to set its status for that day. Clashes between different timetables are flagged everywhere.
// The server resolves times and finds clashes; this file only presents them.
import { api, h, toast } from '../services/api.js';
import { icon } from '/shared/icons.js';
import { dialog, closer } from '/shared/ui.js';
import { S, field, confirmBox, empty, todayStr, addDays, fmtDate, weekdayOf } from '../lib.js';
import { fmtTime } from './eventui.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const COLORS = ['#FF6B1A', '#3DD68C', '#4DA3FF', '#C084FC', '#F5C84B', '#FF5C7A', '#2DD4BF', '#A3A3A3'];
const mondayOf = (d) => addDays(d, -((weekdayOf(d) + 6) % 7));
export const lenText = (min) => { const hh = Math.floor(min / 60), mm = min % 60; return [hh ? `${hh} h` : '', mm ? `${mm} min` : ''].filter(Boolean).join(' ') || '0 min'; };
const buzz = (ms = 14) => { try { navigator.vibrate?.(ms); } catch { /* unsupported */ } };

let sel = null;        // the date being looked at
let statuses = [];     // [{id,label}] from the server

// Tap = open, long-press (or right-click) = status menu.
function pressable(el, { tap, hold }) {
  let timer = null, fired = false, x0 = 0, y0 = 0;
  const stop = () => clearTimeout(timer);
  const fire = () => { if (fired) return; fired = true; buzz(); hold(); };
  el.addEventListener('pointerdown', (e) => { fired = false; x0 = e.clientX; y0 = e.clientY; stop(); timer = setTimeout(fire, 450); });
  el.addEventListener('pointermove', (e) => { if (Math.abs(e.clientX - x0) > 9 || Math.abs(e.clientY - y0) > 9) stop(); });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(t, stop);
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); stop(); fire(); });
  el.addEventListener('click', (e) => { if (fired) { e.preventDefault(); e.stopPropagation(); fired = false; return; } tap(e); });
}

export async function timetablesView({ frame, redraw }) {
  const today = todayStr(); sel = sel || today;
  let data, day;
  [data, day] = await Promise.all([api('GET', '/timetables'), api('GET', `/timetable-day?date=${sel}`)]); // errors go to the screen router (error or offline panel)
  statuses = data.statuses;
  const canWrite = S.meta.canWriteTasks, label = (id) => statuses.find((s) => s.id === id)?.label || id;
  const wk = Array.from({ length: 7 }, (_, i) => addDays(mondayOf(sel), i));
  const jump = (d) => { sel = d; redraw(); };

  const strip = h('div', { class: 'tt-week', role: 'group', 'aria-label': 'Day' }, wk.map((d) => h('button', { type: 'button', class: `${d === sel ? 'on' : ''}${d === today ? ' today' : ''}`, 'aria-pressed': String(d === sel), onclick: () => jump(d) },
    h('small', {}, DAYS[weekdayOf(d)]), h('b', {}, String(+d.slice(8, 10))))));

  const clashBox = data.clashes.length ? h('section', { class: 'card attn tt-clash' }, h('div', { class: 'row tight' }, h('span', { class: 'tt-warn' }, icon('flag')),
    h('div', { style: 'flex:1' }, h('b', {}, `${data.clashes.filter((c) => c.cross).length || data.clashes.length} overlap${data.clashes.length === 1 ? '' : 's'} found`),
      h('small', { class: 'sub', style: 'display:block' }, data.clashes.some((c) => c.cross) ? 'Items from different timetables fall at the same time.' : 'Items inside one timetable fall at the same time.')),
    h('button', { class: 'btn small', type: 'button', onclick: () => clashDialog(data, redraw) }, 'Review'))) : null;

  const rows = day.items.map((it) => {
    const st = it.status, linked = it.linked || [], openTasks = linked.filter((t) => t.status !== 'done').length;
    const row = h('div', { class: `tt-item${st ? ` st-${st}` : ''}${it.clash ? ' clash' : ''}`, role: 'button', tabindex: 0, style: `--c:${it.color}` },
      h('span', { class: 'tt-time' }, fmtTime(it.startTime), h('small', {}, fmtTime(it.endTime))),
      h('span', { class: 'tt-main' }, h('b', {}, it.title), h('small', {}, `${it.timetable} · ${lenText(it.durationMin)}${it.fixed ? '' : ' · flows'}`)),
      h('span', { class: 'task-badges' }, linked.length ? h('span', { class: 'badge', title: `${linked.length} linked task${linked.length === 1 ? '' : 's'}` }, h('span', { class: 'ico-s' }, icon('link')), ` ${openTasks ? `${openTasks} open` : 'all done'}`) : null,
        it.clash ? h('span', { class: 'badge bad' }, 'Clash') : null, st ? h('span', { class: `badge tt-st ${st}` }, label(st)) : null));
    const item = () => data.timetables.find((t) => t.id === it.timetableId)?.items.find((i) => i.id === it.itemId);
    pressable(row, { tap: () => { const tt = data.timetables.find((t) => t.id === it.timetableId); if (tt && item()) openItem(tt, item(), { onChange: redraw, date: sel }); },
      hold: () => canWrite ? statusMenu(it, sel, label, redraw) : toast(`${it.title}: ${st ? label(st) : 'no status yet'}`) });
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') row.click(); if (e.key === ' ') { e.preventDefault(); canWrite && statusMenu(it, sel, label, redraw); } });
    return row;
  });

  const done = day.totals.done, total = day.totals.items;
  const agenda = h('section', { class: 'card flat tt-agenda' }, rows.length ? rows : empty('clock', data.timetables.length ? `Nothing planned on ${LONG[weekdayOf(sel)]}.` : 'No timetables yet. Make one to plan your week.',
    canWrite && !data.timetables.length ? h('button', { class: 'btn', type: 'button', onclick: () => openTimetable(null, redraw) }, icon('plus'), 'New timetable') : null));

  const manage = data.timetables.map((tt) => h('section', { class: `card tt-card${tt.active ? '' : ' off'}`, style: `--c:${tt.color}` },
    h('div', { class: 'tt-card-h' }, h('span', { class: 'tt-dot' }), h('div', { style: 'flex:1;min-width:0' }, h('b', {}, tt.name), h('small', { class: 'sub', style: 'display:block' }, `${tt.items.length} item${tt.items.length === 1 ? '' : 's'} · duration items start at ${fmtTime(tt.startTime)}${tt.active ? '' : ' · paused'}`)),
      canWrite ? h('button', { class: 'btn ghost small', type: 'button', 'aria-label': `Edit ${tt.name}`, onclick: () => openTimetable(tt, redraw) }, icon('pencil')) : null),
    tt.items.length ? h('div', { class: 'tt-list' }, tt.items.map((it, i) => h('div', { class: 'tt-li' }, h('button', { type: 'button', class: 'tt-li-main', onclick: () => openItem(tt, it, { onChange: redraw, date: sel }) },
      h('b', {}, it.title), h('small', {}, `${it.days.length === 7 ? 'Every day' : it.days.map((d) => DAYS[d]).join(' ')} · ${it.startTime && it.endTime ? `${fmtTime(it.startTime)} – ${fmtTime(it.endTime)}` : `${lenText(it.durationMin)}${it.startTime ? ` from ${fmtTime(it.startTime)}` : ''}`}`)),
      canWrite ? h('span', { class: 'tt-move' }, h('button', { type: 'button', class: 'btn ghost small', disabled: i === 0 ? '' : null, 'aria-label': 'Move up', onclick: () => move(tt, it, -1, redraw) }, icon('up')),
        h('button', { type: 'button', class: 'btn ghost small', disabled: i === tt.items.length - 1 ? '' : null, 'aria-label': 'Move down', onclick: () => move(tt, it, 1, redraw) }, h('span', { class: 'flip-v' }, icon('up')))) : null))) : h('p', { class: 'fine' }, 'No items yet.'),
    canWrite ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => openItem(tt, null, { onChange: redraw, date: sel }) }, icon('plus'), 'Add item') : null));

  frame('timetables', h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Timetables'), h('p', { class: 'sub' }, `${LONG[weekdayOf(sel)]}, ${fmtDate(sel, true)}${total ? ` · ${done} of ${total} done` : ''}`)),
    h('div', { class: 'row tight' }, h('button', { class: 'btn ghost small', type: 'button', 'aria-label': 'Previous week', onclick: () => jump(addDays(sel, -7)) }, icon('back')),
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => jump(today) }, 'Today'),
      h('button', { class: 'btn ghost small', type: 'button', 'aria-label': 'Next week', onclick: () => jump(addDays(sel, 7)) }, h('span', { class: 'flip' }, icon('back'))),
      canWrite ? h('button', { class: 'btn', type: 'button', onclick: () => openTimetable(null, redraw) }, icon('plus'), 'New timetable') : null)),
    strip, clashBox, agenda, rows.length && canWrite ? h('p', { class: 'fine' }, 'Tip: press and hold an item to mark it done, skipped and more. Status is saved for this day only.') : null,
    manage.length ? h('h2', { class: 'tt-h2' }, 'Your timetables') : null, ...manage);
}

async function move(tt, it, dir, onChange) { try { await api('POST', `/timetables/${tt.id}/items/${it.id}/move`, { dir }); onChange(); } catch (x) { toast(x.message); } }

// ---- long-press menu: set what happened with this item on this date ----
function statusMenu(it, date, label, onChange) {
  const set = async (status) => { d.close(); try { await api('PUT', `/timetables/${it.timetableId}/items/${it.itemId}/status`, { date, status }); toast(status ? `${it.title}: ${label(status)}` : 'Status cleared'); onChange(); } catch (x) { toast(x.message); } };
  const d = dialog(it.title, h('p', { class: 'sub' }, `${LONG[weekdayOf(date)]}, ${fmtDate(date, true)} · ${fmtTime(it.startTime)} – ${fmtTime(it.endTime)}`),
    h('div', { class: 'menu tt-menu' }, statuses.map((s) => h('button', { type: 'button', class: it.status === s.id ? 'on' : '', onclick: () => set(s.id) }, h('i', { class: `tt-sdot ${s.id}` }), s.label, it.status === s.id ? icon('check') : null)),
      it.status ? h('button', { type: 'button', onclick: () => set(null) }, icon('undo'), 'Clear status') : null),
    h('div', { class: 'row actions' }, closer()));
}

function clashDialog(data, onChange) {
  const byDay = Map.groupBy(data.clashes, (c) => c.day), order = [1, 2, 3, 4, 5, 6, 0].filter((d) => byDay.has(d));
  const one = (c) => h('div', { class: 'tt-clash-row' }, h('b', {}, `${fmtTime(c.from)} – ${fmtTime(c.to)} `), h('small', {}, `(${c.minutes} min)${c.cross ? '' : ' · same timetable'}`),
    h('div', {}, [c.a, c.b].map((x) => h('button', { type: 'button', class: 'tt-pill', onclick: () => { d.close(); const tt = data.timetables.find((t) => t.id === x.timetableId), it = tt?.items.find((i) => i.id === x.itemId); if (tt && it) openItem(tt, it, { onChange, date: sel }); } },
      h('span', { class: 'tt-dot', style: `--c:${data.timetables.find((t) => t.id === x.timetableId)?.color || '#888'}` }), `${x.title} · ${x.timetable} (${fmtTime(x.startTime)}–${fmtTime(x.endTime)})`))));
  const d = dialog('Overlapping items', h('p', { class: 'sub' }, 'These fall at the same time. Change a time or a length, move an item, or pause a timetable.'),
    h('div', { class: 'tt-clash-list' }, order.map((day) => h('section', {}, h('h3', {}, LONG[day]), byDay.get(day).map(one)))), h('div', { class: 'row actions' }, closer()));
}

// ---- timetable editor ----
function openTimetable(tt, onChange) {
  const isNew = !tt, err = h('p', { class: 'err', role: 'alert' });
  let color = tt?.color || COLORS[0];
  const name = h('input', { value: tt?.name || '', maxlength: 80, required: '', placeholder: 'e.g. School, Work, Gym', autofocus: '' });
  const start = h('input', { type: 'time', value: tt?.startTime || '08:00', required: '' });
  const active = h('input', { type: 'checkbox', checked: tt?.active === false ? null : '' });
  const sw = h('div', { class: 'tt-swatches', role: 'group', 'aria-label': 'Colour' });
  const drawSw = () => sw.replaceChildren(COLORS.map((c) => h('button', { type: 'button', class: c === color ? 'on' : '', style: `--c:${c}`, 'aria-label': c, 'aria-pressed': String(c === color), onclick: () => { color = c; drawSw(); } })));
  drawSw();
  const save = h('button', { class: 'btn', type: 'submit' }, isNew ? 'Create' : 'Save');
  const submit = async (e) => { e.preventDefault(); err.textContent = ''; save.disabled = true;
    try { await api(isNew ? 'POST' : 'PATCH', isNew ? '/timetables' : `/timetables/${tt.id}`, { name: name.value, color, startTime: start.value, active: active.checked }); d.close(); toast(isNew ? 'Timetable created. Add your first item.' : 'Timetable saved'); onChange(); }
    catch (z) { err.textContent = z.message; save.disabled = false; } };
  const actions = [save, closer('Cancel')];
  if (!isNew) actions.push(h('button', { type: 'button', class: 'btn ghost danger', onclick: async () => {
    if (await confirmBox('Delete this timetable?', `"${tt.name}" and its ${tt.items.length} item${tt.items.length === 1 ? '' : 's'} will be removed. Linked tasks stay, they just lose the link.`)) { try { await api('DELETE', `/timetables/${tt.id}`); d.close(); toast('Timetable deleted'); onChange(); } catch (z) { err.textContent = z.message; } } } }, icon('trash'), 'Delete'));
  const d = dialog(isNew ? 'New timetable' : 'Edit timetable', h('form', { class: 'task-form', onsubmit: submit }, field('Name', name), h('div', {}, h('span', { class: 'fine' }, 'Colour'), sw),
    field('Day starts at', start, 'Items given only a length (like 1 hour) are placed one after another from here.'), h('label', { class: 'toggle-row' }, active, 'Active (paused timetables are ignored when checking overlaps)'),
    err, h('div', { class: 'row actions' }, ...actions)));
}

// ---- item editor ----
export async function openItem(tt, item, { onChange = () => {}, date = null } = {}) {
  const canWrite = S.meta.canWriteTasks, isNew = !item, err = h('p', { class: 'err', role: 'alert' });
  let dirty = false; // task links change data behind the editor, so redraw the screen when it closes
  const it = item || { title: '', days: weekdayOf(date || todayStr()) === 0 || weekdayOf(date || todayStr()) === 6 ? [weekdayOf(date || todayStr())] : [1, 2, 3, 4, 5], startTime: null, endTime: null, durationMin: 60, notes: '' };
  const days = new Set(it.days);
  let mode = it.startTime && it.endTime ? 'fixed' : 'length';
  const title = h('input', { value: it.title, maxlength: 120, required: '', autofocus: '', placeholder: 'e.g. Maths, Gym session, Study block' });
  const startF = h('input', { type: 'time', value: it.startTime || '' }), endF = h('input', { type: 'time', value: it.endTime || '' });
  const hrs = h('input', { type: 'number', min: 0, max: 23, value: Math.floor((it.durationMin || 60) / 60), inputmode: 'numeric', 'aria-label': 'Hours' });
  const mins = h('input', { type: 'number', min: 0, max: 59, step: 5, value: (it.durationMin || 60) % 60, inputmode: 'numeric', 'aria-label': 'Minutes' });
  const anchor = h('input', { type: 'time', value: mode === 'length' ? it.startTime || '' : '' });
  const notes = h('textarea', { rows: 2, maxlength: 1000 }, it.notes || '');
  const dayBox = h('div', { class: 'seg days', role: 'group', 'aria-label': 'Days' }, [1, 2, 3, 4, 5, 6, 0].map((i) => h('button', { type: 'button', class: days.has(i) ? 'on' : '', 'aria-pressed': String(days.has(i)), onclick: (e) => { days.has(i) ? days.delete(i) : days.add(i); e.currentTarget.classList.toggle('on'); e.currentTarget.setAttribute('aria-pressed', String(days.has(i))); } }, DAYS[i])));
  const modeBox = h('div', { class: 'seg', role: 'group', 'aria-label': 'Time type' });
  const timeBox = h('div', {});
  const draw = () => {
    modeBox.replaceChildren([['length', 'Length (hours / minutes)'], ['fixed', 'Fixed time']].map(([k, t]) => h('button', { type: 'button', class: mode === k ? 'on' : '', 'aria-pressed': String(mode === k), onclick: () => { mode = k; draw(); } }, t)));
    timeBox.replaceChildren(...(mode === 'fixed' ? [h('div', { class: 'two' }, field('Starts', startF), field('Ends', endF))]
      : [h('div', { class: 'two' }, field('Hours', hrs), field('Minutes', mins)), field('Starts at (optional)', anchor, 'Leave empty to start right after the previous item (or when the day starts).')]));
  };
  draw();
  if (!canWrite) [title, startF, endF, hrs, mins, anchor, notes].forEach((el) => el.setAttribute('disabled', ''));

  const read = () => {
    const body = { title: title.value, days: [...days].sort((a, b) => a - b), notes: notes.value };
    if (mode === 'fixed') Object.assign(body, { startTime: startF.value || null, endTime: endF.value || null, durationMin: null });
    else { const total = (+hrs.value || 0) * 60 + (+mins.value || 0); Object.assign(body, { startTime: anchor.value || null, endTime: null, durationMin: total > 0 ? total : null }); }
    return body;
  };
  const save = h('button', { class: 'btn', type: 'submit' }, isNew ? 'Add' : 'Save');
  const submit = async (e) => { e.preventDefault(); err.textContent = ''; save.disabled = true;
    try {
      const r = await api(isNew ? 'POST' : 'PATCH', isNew ? `/timetables/${tt.id}/items` : `/timetables/${tt.id}/items/${item.id}`, read());
      const mine = r.clashes.filter((c) => c.a.itemId === (r.item?.id || item?.id) || c.b.itemId === (r.item?.id || item?.id)), c = mine[0];
      d.close(); if (c) { const o = c.a.itemId === (r.item?.id || item?.id) ? c.b : c.a; toast(`Saved. Heads up: it overlaps "${o.title}"${o.timetableId !== tt.id ? ` in ${o.timetable}` : ''} (${fmtTime(c.from)}–${fmtTime(c.to)}).`); } else toast(isNew ? 'Item added' : 'Item saved');
      dirty = false; onChange();
    } catch (z) { err.textContent = z.message; save.disabled = false; } };
  const actions = [save, closer('Cancel')];
  if (!isNew && canWrite) actions.push(h('button', { type: 'button', class: 'btn ghost danger', onclick: async () => {
    if (await confirmBox('Delete this item?', `"${it.title}" will be removed from ${tt.name}. Its statuses go with it; linked tasks stay.`)) { try { await api('DELETE', `/timetables/${tt.id}/items/${item.id}`); d.close(); toast('Item deleted'); onChange(); } catch (z) { err.textContent = z.message; } } } }, icon('trash'), 'Delete'));

  // tasks linked to this item
  const linkBox = h('div', { class: 'tt-links' });
  const drawLinks = (list) => linkBox.replaceChildren(h('h3', {}, 'Tasks for this item'), list.length ? h('div', { class: 'tt-linked' }, list.map((t) => h('div', { class: `tt-lt${t.status === 'done' ? ' done' : ''}` }, icon(t.status === 'done' ? 'check' : 'target'), h('span', {}, t.title), t.dueDate ? h('small', {}, fmtDate(t.dueDate)) : null))) : h('p', { class: 'fine' }, 'No tasks linked yet.'),
    canWrite ? h('button', { type: 'button', class: 'btn ghost small', onclick: () => pickTasks(tt, item, list, (nl) => { item.linked = nl; drawLinks(nl); dirty = true; }) }, icon('link'), list.length ? 'Change linked tasks' : 'Link tasks') : null);
  if (!isNew) drawLinks(item.linked || []);

  const d = dialog(isNew ? `New item in ${tt.name}` : it.title, h('form', { class: 'task-form', onsubmit: submit }, field('What', title), h('div', {}, h('span', { class: 'fine' }, 'Days'), dayBox), h('div', {}, h('span', { class: 'fine' }, 'Time'), modeBox), timeBox, field('Notes', notes),
    isNew ? h('p', { class: 'fine' }, 'Save it first, then you can link tasks to it.') : linkBox, err, h('div', { class: 'row actions' }, ...(canWrite ? actions : [closer('Close')]))));
  d.addEventListener('close', () => { if (dirty) onChange(); });
}

async function pickTasks(tt, item, current, done) {
  let tasks = [];
  try { tasks = (await api('GET', '/tasks?open=true&limit=300&sort=title')).tasks; } catch (x) { toast(x.message); return; }
  for (const t of current) if (!tasks.some((x) => x.id === t.id)) tasks.unshift(t);
  const chosen = new Set(current.map((t) => t.id)), q = h('input', { type: 'search', placeholder: 'Search tasks', 'aria-label': 'Search tasks' }), list = h('div', { class: 'tt-pick' });
  const draw = () => { const f = q.value.trim().toLowerCase(); list.replaceChildren(tasks.filter((t) => !f || t.title.toLowerCase().includes(f)).map((t) => h('label', { class: 'tt-pick-row' },
    h('input', { type: 'checkbox', checked: chosen.has(t.id) ? '' : null, onchange: (e) => { e.target.checked ? chosen.add(t.id) : chosen.delete(t.id); } }), h('span', {}, t.title), t.dueDate ? h('small', {}, fmtDate(t.dueDate)) : null))); if (!list.children.length) list.append(h('p', { class: 'fine' }, tasks.length ? 'No matches.' : 'You have no open tasks. Create one first.')); };
  q.addEventListener('input', draw); draw();
  const err = h('p', { class: 'err', role: 'alert' });
  const ok = h('button', { type: 'button', class: 'btn', onclick: async () => { ok.disabled = true; try { const r = await api('PUT', `/timetables/${tt.id}/items/${item.id}/tasks`, { taskIds: [...chosen] }); d.close(); toast(`${r.linked.length} task${r.linked.length === 1 ? '' : 's'} linked`); done(r.linked); } catch (z) { err.textContent = z.message; ok.disabled = false; } } }, 'Save links');
  const d = dialog(`Link tasks to "${item.title}"`, q, list, err, h('div', { class: 'row actions' }, ok, closer('Cancel')));
}
