// Task row, quick-add and the task editor. Every change goes through the server, which enforces ownership and rules;
// this file only presents them. `onChange` lets the calling screen redraw after a save.
import { api, h, toast } from '../services/api.js';
import { icon } from '/shared/icons.js';
import { dialog, closer } from '/shared/ui.js';
import { checkCelebrate } from './celebrate.js';
import { S, label, dueText, badge, prioBadge, select, field, projectOptions, confirmBox, todayStr, addDays, fmtDate } from '../lib.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export async function toggleDone(t, onChange) {
  try {
    const r = await api('POST', `/tasks/${t.id}/${t.status === 'done' ? 'reopen' : 'complete'}`);
    if (r.next) toast(`Done. Next one is due ${fmtDate(r.next.dueDate)}`); else if (t.status !== 'done') toast('Task completed');
    onChange(); if (t.status !== 'done') setTimeout(checkCelebrate, 350);
  } catch (x) { toast(x.message); onChange(); }
}

export function taskRow(t, onChange, { showProject = true } = {}) {
  const done = t.status === 'done';
  const box = h('input', { type: 'checkbox', checked: done ? '' : null, 'aria-label': done ? `Reopen ${t.title}` : `Complete ${t.title}`, onclick: (e) => { e.stopPropagation(); toggleDone(t, onChange); } });
  const meta = [showProject && t.projectName, t.milestoneTitle, t.subtaskCounts.total ? `${t.subtaskCounts.done}/${t.subtaskCounts.total} subtasks` : '', t.tags.map((x) => `#${x}`).join(' ')].filter(Boolean).join(' · ');
  const due = dueText(t);
  return h('div', { class: `task p-${t.priority}${done ? ' done' : ''}` }, box,
    h('button', { class: 'task-main', type: 'button', onclick: () => openTask(t, { onChange }) },
      h('b', {}, t.title), meta ? h('small', {}, meta) : null),
    h('span', { class: 'task-badges' },
      t.recurrence ? h('span', { class: 'rec', title: 'Repeats', 'aria-label': 'Repeats' }, icon('repeat')) : null,
      t.waitingOn ? badge(`Waiting on ${t.waitingOn}`, 'warn') : null,
      t.status === 'blocked' ? badge('Blocked', 'bad') : null,
      due ? badge(due, t.overdue ? 'bad' : '') : null, t.priority === 'high' || t.priority === 'urgent' ? prioBadge(t.priority) : null));
}

// One line to capture a task. Enter saves it; "More" opens the full editor with the text carried over.
export function quickAdd({ projectId = null, onChange }) {
  const input = h('input', { type: 'text', placeholder: 'Add a task and press Enter', 'aria-label': 'New task title', maxlength: 200 });
  const form = h('form', { class: 'quick', onsubmit: async (e) => {
    e.preventDefault(); const title = input.value.trim(); if (!title) return;
    input.disabled = true;
    try { await api('POST', '/tasks', { title, ...(projectId ? { projectId } : {}) }); input.value = ''; onChange(); } catch (x) { toast(x.message); }
    input.disabled = false; input.focus();
  } }, input, h('button', { class: 'btn small', type: 'submit' }, icon('plus'), h('span', { class: 'lbl' }, 'Add')),
  h('button', { class: 'btn ghost small', type: 'button', onclick: () => openTask(null, { onChange, projectId, title: input.value.trim() }) }, 'More'));
  return form;
}

export async function openTask(task, { onChange = () => {}, projectId = null, title = '', dueDate = null } = {}) {
  const isNew = !task, canWrite = S.meta.canWriteTasks;
  const t = task ? (await api('GET', `/tasks/${task.id}`).catch((x) => { toast(x.message); return null; }))?.task : { title, description: '', projectId, milestoneId: null, status: 'todo', priority: 'medium', startDate: null, dueDate, assigneeId: S.me.user.id, tags: [], notes: '', subtasks: [], dependsOn: [], recurrence: null, archived: false };
  if (!t) return;
  const err = h('p', { class: 'err', role: 'alert' });
  const f = {
    title: h('input', { value: t.title, maxlength: 200, required: '', autofocus: '' }),
    description: h('textarea', { rows: 2, maxlength: 4000 }, t.description),
    project: select(projectOptions(), t.projectId || '', () => loadMilestones(), 'Project'),
    milestone: h('select', { 'aria-label': 'Milestone' }),
    status: select(S.meta.statuses.map((s) => [s.id, s.label]), t.status, () => {}, 'Status'),
    priority: select(S.meta.priorities.map((p) => [p.id, p.label]), t.priority, () => {}, 'Priority'),
    start: h('input', { type: 'date', value: t.startDate || '' }), due: h('input', { type: 'date', value: t.dueDate || '' }),
    tags: h('input', { value: t.tags.join(', '), placeholder: 'work, urgent', maxlength: 300 }),
    mine: h('input', { type: 'checkbox', checked: t.assigneeId ? '' : null }),
    notes: h('textarea', { rows: 3, maxlength: 8000 }, t.notes),
  };
  if (!canWrite) Object.values(f).forEach((el) => el.setAttribute?.('disabled', ''));
  async function loadMilestones(selected = null) {
    const pid = f.project.value; let ms = [];
    if (pid) try { ms = (await api('GET', `/projects/${pid}`)).project.milestones; } catch { /* the project may be gone */ }
    f.milestone.replaceChildren(h('option', { value: '' }, ms.length ? 'No milestone' : 'No milestones in this project'), ...ms.map((m) => h('option', { value: m.id, selected: m.id === selected ? '' : null }, m.title)));
    f.milestone.disabled = !pid || !ms.length || !canWrite;
  }
  loadMilestones(t.milestoneId);

  // Subtasks
  let subs = t.subtasks.map((x) => ({ ...x }));
  const subList = h('div', { class: 'subs' }), subInput = h('input', { placeholder: 'Add a subtask', maxlength: 200, 'aria-label': 'New subtask' });
  const drawSubs = () => subList.replaceChildren(subs.map((x, i) => h('div', { class: 'sub-row' },
    h('input', { type: 'checkbox', checked: x.done ? '' : null, 'aria-label': `Subtask done: ${x.title}`, disabled: canWrite ? null : '', onchange: (e) => { x.done = e.target.checked; } }),
    h('span', {}, x.title), canWrite ? h('button', { type: 'button', class: 'btn ghost small', 'aria-label': `Remove subtask ${x.title}`, onclick: () => { subs.splice(i, 1); drawSubs(); } }, icon('x')) : null)));
  const addSub = () => { const v = subInput.value.trim(); if (v && subs.length < 50) { subs.push({ id: null, title: v, done: false }); subInput.value = ''; drawSubs(); } subInput.focus(); };
  subInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addSub(); } });
  drawSubs();

  // Dependencies: pick from the other open tasks
  const deps = h('select', { multiple: '', size: 4, 'aria-label': 'Depends on' });
  api('GET', '/tasks?open=true&limit=300&sort=title').then(({ tasks }) => deps.replaceChildren(...tasks.filter((x) => x.id !== t.id).map((x) => h('option', { value: x.id, selected: t.dependsOn.includes(x.id) ? '' : null }, x.title))));
  const missingDeps = t.dependencies?.filter((d) => d.status === 'done') || []; // finished dependencies are not in the open list; keep them
  if (!canWrite) deps.setAttribute('disabled', '');

  // Repeat
  const rec = t.recurrence, recFreq = select([['', 'Does not repeat'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly']], rec?.freq || '', () => drawRec(), 'Repeat');
  const interval = h('input', { type: 'number', min: 1, max: 99, value: rec?.interval || 1, 'aria-label': 'Repeat every' });
  const days = new Set(rec?.byDay || []);
  const endMode = select([['never', 'Never ends'], ['until', 'Ends on a date'], ['count', 'Ends after a number of times']], rec?.until ? 'until' : rec?.remaining != null ? 'count' : 'never', () => drawRec(), 'Repeat ends');
  const endDate = h('input', { type: 'date', value: rec?.until || '' }), endCount = h('input', { type: 'number', min: 2, max: 365, value: rec?.remaining != null ? rec.remaining + 1 : 5, 'aria-label': 'Total number of times' });
  const recBox = h('div', { class: 'rec-box' });
  const drawRec = () => {
    const fr = recFreq.value, unit = { daily: 'day(s)', weekly: 'week(s)', monthly: 'month(s)', yearly: 'year(s)' }[fr];
    recBox.replaceChildren(...(!fr ? [] : [h('div', { class: 'row' }, 'Every', interval, unit),
      fr === 'weekly' ? h('div', { class: 'seg days', role: 'group', 'aria-label': 'On these days' }, DAYS.map((d, i) => h('button', { type: 'button', class: days.has(i) ? 'on' : '', 'aria-pressed': String(days.has(i)), onclick: (e) => { days.has(i) ? days.delete(i) : days.add(i); e.currentTarget.classList.toggle('on'); e.currentTarget.setAttribute('aria-pressed', String(days.has(i))); } }, d))) : null,
      endMode, endMode.value === 'until' ? endDate : null, endMode.value === 'count' ? h('div', { class: 'row' }, 'Total times', endCount) : null,
      h('p', { class: 'fine' }, 'The next one is created when you complete this one. A repeating task needs a due date.')]));
  };
  drawRec(); if (!canWrite) recFreq.setAttribute('disabled', '');

  const read = () => {
    const body = { title: f.title.value, description: f.description.value, projectId: f.project.value || null, milestoneId: f.milestone.value || null, status: f.status.value, priority: f.priority.value,
      startDate: f.start.value || null, dueDate: f.due.value || null, tags: f.tags.value.split(',').map((x) => x.trim()).filter(Boolean), assignedToMe: f.mine.checked, notes: f.notes.value,
      subtasks: subs.map((x) => ({ ...(x.id ? { id: x.id } : {}), title: x.title, done: !!x.done })),
      dependsOn: [...[...deps.selectedOptions].map((o) => o.value), ...missingDeps.map((d) => d.id)] };
    const fr = recFreq.value;
    body.recurrence = !fr ? null : { freq: fr, interval: Number(interval.value) || 1, ...(fr === 'weekly' ? { byDay: [...days] } : {}),
      ...(endMode.value === 'until' ? { until: endDate.value || null } : endMode.value === 'count' ? { count: Number(endCount.value) } : {}) };
    return body;
  };
  const submit = async (e) => {
    e.preventDefault(); err.textContent = ''; save.disabled = true;
    try { await api(isNew ? 'POST' : 'PATCH', isNew ? '/tasks' : `/tasks/${t.id}`, read()); d.close(); toast(isNew ? 'Task added' : 'Task saved'); onChange(); }
    catch (x) { err.textContent = x.message; save.disabled = false; }
  };
  const save = h('button', { class: 'btn', type: 'submit' }, isNew ? 'Add task' : 'Save');

  // AI drafting is optional and only fills this form; nothing is saved until you press Add task.
  let ai = null;
  if (isNew && S.meta.ai) {
    const text = h('input', { placeholder: 'Describe it in your own words, e.g. "email Ada the invoice by Friday"', maxlength: 1000, 'aria-label': 'Describe the task for AI drafting' }), aiErr = h('p', { class: 'err', role: 'alert' });
    const go = h('button', { type: 'button', class: 'btn ghost small', onclick: async () => {
      if (text.value.trim().length < 3) return; go.disabled = true; aiErr.textContent = '';
      try {
        const { draft } = await api('POST', '/ai/draft-task', { text: text.value });
        f.title.value = draft.title; f.description.value = draft.description; f.priority.value = draft.priority; f.due.value = draft.dueDate || ''; f.tags.value = draft.tags.join(', ');
        if (draft.projectId) { f.project.value = draft.projectId; loadMilestones(); }
        toast('Draft filled in. Review it, then add the task.');
      } catch (x) { aiErr.textContent = x.message; }
      go.disabled = false;
    } }, icon('sparkle'), 'Draft with AI');
    ai = h('div', { class: 'ai-draft' }, h('div', { class: 'row' }, text, go), aiErr);
  }

  const fine = h('details', {}, h('summary', {}, 'Subtasks, dependencies, repeat and notes'),
    h('h3', {}, 'Subtasks'), subList, canWrite ? h('div', { class: 'row' }, subInput, h('button', { type: 'button', class: 'btn ghost small', onclick: addSub }, 'Add')) : null,
    field('Depends on (finish these first)', deps, 'Hold Ctrl or Cmd to pick several'), h('h3', {}, 'Repeat'), recFreq, recBox, field('Notes', f.notes));
  if (!isNew || subs.length || t.notes || t.recurrence || t.dependsOn.length) fine.open = true;

  const actions = [save, closer('Cancel')];
  if (!isNew && canWrite) {
    actions.push(h('button', { type: 'button', class: 'btn ghost', onclick: async () => { try { await api('PATCH', `/tasks/${t.id}`, { archived: !t.archived }); d.close(); toast(t.archived ? 'Task restored' : 'Task archived'); onChange(); } catch (x) { err.textContent = x.message; } } }, t.archived ? 'Restore' : 'Archive'));
    if (S.meta.canDeleteTasks) actions.push(h('button', { type: 'button', class: 'btn ghost danger', onclick: async () => { if (await confirmBox('Delete this task?', `"${t.title}" will be deleted for good. Archive it instead if you may need it again.`)) { try { await api('DELETE', `/tasks/${t.id}`); d.close(); toast('Task deleted'); onChange(); } catch (x) { err.textContent = x.message; } } } }, icon('trash'), 'Delete'));
  }
  const d = dialog(isNew ? 'New task' : 'Task', h('form', { class: 'task-form', onsubmit: submit }, ai, field('Title', f.title), field('Description', f.description),
    h('div', { class: 'two' }, field('Project', f.project), field('Milestone', f.milestone), field('Status', f.status), field('Priority', f.priority), field('Start date', f.start), field('Due date', f.due)),
    field('Tags', f.tags, 'Separate with commas'), h('label', { class: 'toggle-row' }, f.mine, 'Assigned to me'), fine, err, h('div', { class: 'row actions' }, ...(canWrite ? actions : [closer('Close')]))));
  if (isNew) f.title.focus();
}
