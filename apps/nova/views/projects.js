import { api, h, toast } from '../services/api.js';
import { icon } from '/shared/icons.js';
import { dialog, closer } from '/shared/ui.js';
import { S, select, field, empty, badge, progressBar, fmtDate, confirmBox, label } from '../lib.js';
import { taskRow, quickAdd, openTask } from './taskui.js';
import { projectCard } from './overview.js';

let showArchived = false, taskFilter = 'open';

export async function projectsView({ frame, redraw }) {
  const { projects } = await api('GET', `/projects?archived=${showArchived}`);
  frame('projects', h('div', { class: 'page-head' }, h('h1', {}, 'Projects'), S.meta.canWriteProjects ? h('button', { class: 'btn', onclick: () => openProject(null, { onChange: redraw }) }, icon('plus'), 'New project') : null),
    select([['false', 'Active projects'], ['true', 'Archived projects']], String(showArchived), (v) => { showArchived = v === 'true'; redraw(); }, 'Show'),
    projects.length ? h('div', { class: 'grid spaced' }, projects.map(projectCard)) : empty('target', showArchived ? 'No archived projects.' : 'No projects yet. A project groups the tasks that lead to one outcome.',
      showArchived || !S.meta.canWriteProjects ? null : h('button', { class: 'btn small', onclick: () => openProject(null, { onChange: redraw }) }, icon('plus'), 'Create your first project')));
}

export async function projectView(id, { frame, redraw, go }) {
  let p; try { p = (await api('GET', `/projects/${id}`)).project; } catch (x) { frame('projects', h('p', { class: 'err' }, x.status === 404 ? 'This project was not found.' : x.message), h('a', { class: 'btn ghost', href: '#/projects' }, 'Back to projects')); return; }
  const qs = new URLSearchParams({ project: id, sort: 'dueDate', limit: 500, archived: taskFilter === 'archived' }); if (taskFilter === 'open') qs.set('open', 'true');
  const { tasks } = await api('GET', `/tasks?${qs}`);
  const w = S.meta.canWriteProjects, pr = p.progress;

  const aiBox = h('div', { class: 'ai-summary', hidden: '' });
  const aiBtns = S.meta.ai && w ? [
    h('button', { class: 'btn ghost small', type: 'button', onclick: () => breakdownDialog(p, redraw) }, icon('sparkle'), 'Suggest tasks'),
    h('button', { class: 'btn ghost small', type: 'button', onclick: async (e) => { const b = e.currentTarget; b.disabled = true; aiBox.hidden = false; aiBox.textContent = 'Writing summary…'; try { aiBox.textContent = (await api('POST', '/ai/summary', { projectId: id })).summary; } catch (x) { aiBox.textContent = x.message; } b.disabled = false; } }, icon('sparkle'), 'Summarise')] : [];

  const ms = h('section', { class: 'card' }, h('div', { class: 'page-head sub-head' }, h('h3', {}, 'Milestones'), w ? h('button', { class: 'btn ghost small', onclick: () => milestoneDialog(p, null, redraw) }, icon('plus'), 'Add') : null),
    p.milestones.length ? h('div', { class: 'ms-list' }, p.milestones.map((m) => h('div', { class: `ms${m.completed ? ' done' : ''}` },
      h('input', { type: 'checkbox', checked: m.completed ? '' : null, disabled: w ? null : '', 'aria-label': `Milestone complete: ${m.title}`, onchange: async (e) => { try { await api('PATCH', `/milestones/${m.id}`, { completed: e.target.checked }); } catch (x) { toast(x.message); } redraw(); } }),
      h('button', { class: 'task-main', type: 'button', onclick: () => w && milestoneDialog(p, m, redraw) }, h('b', {}, m.title), h('small', {}, [m.dueDate ? `Due ${fmtDate(m.dueDate)}` : 'No date', m.progress.total ? `${m.progress.done}/${m.progress.total} tasks` : 'No tasks linked'].join(' · '))),
      progressBar(m.progress.percent, p.color))))
      : h('p', { class: 'sub' }, 'Milestones mark the big steps. Add one, then link tasks to it when you edit them.'));

  frame('projects', h('p', {}, h('a', { href: '#/projects', class: 'back' }, icon('back'), 'Projects')),
    h('div', { class: 'page-head' }, h('div', { class: 'proj-title', style: p.color ? `--accent:${p.color}` : null }, h('span', { class: 'proj-ic big', 'aria-hidden': 'true' }, icon(p.icon || 'target')), h('div', {}, h('h1', {}, p.name),
      h('div', { class: 'row tight' }, badge(label(S.meta.projectStatuses, p.status), p.status === 'on_hold' ? 'warn' : ''), badge(`${label(S.meta.priorities, p.priority)} priority`), p.archived ? badge('Archived', 'off') : null, p.deadline ? badge(`Due ${fmtDate(p.deadline)}`) : null))),
      w ? h('button', { class: 'btn ghost small', onclick: () => openProject(p, { onChange: redraw, onDeleted: () => go('#/projects') }) }, icon('pencil'), 'Edit') : null),
    p.description ? h('p', { class: 'sub pre' }, p.description) : null, p.tags.length ? h('p', { class: 'fine' }, p.tags.map((t) => `#${t}`).join(' ')) : null,
    h('section', { class: 'card' }, h('div', { class: 'row between' }, h('b', {}, `${pr.percent}% complete`), h('small', { class: 'sub' }, `${pr.done} of ${pr.total} tasks done${pr.overdue ? ` · ${pr.overdue} overdue` : ''}`)), progressBar(pr.percent, p.color),
      h('p', { class: 'fine' }, 'Repeating tasks and archived tasks are not counted.'), h('div', { class: 'row tight' }, ...aiBtns)), aiBox, ms,
    h('section', {}, h('div', { class: 'page-head sub-head' }, h('h2', {}, 'Tasks'), select([['open', 'Open'], ['all', 'All'], ['archived', 'Archived']], taskFilter, (v) => { taskFilter = v; redraw(); }, 'Show tasks')),
      S.meta.canWriteTasks && !p.archived ? quickAdd({ projectId: id, onChange: redraw }) : null,
      tasks.length ? h('div', { class: 'tasks card flat' }, tasks.map((t) => taskRow(t, redraw, { showProject: false }))) : empty('check', taskFilter === 'open' ? 'No open tasks in this project.' : 'No tasks here.',
        S.meta.canWriteTasks && S.meta.ai && w && taskFilter === 'open' ? h('button', { class: 'btn small', onclick: () => breakdownDialog(p, redraw) }, icon('sparkle'), 'Suggest tasks with AI') : null)));
}

export function openProject(p, { onChange = () => {}, onDeleted = null } = {}) {
  const isNew = !p, err = h('p', { class: 'err', role: 'alert' });
  let icon_ = p?.icon || '', color = p?.color || '';
  const f = { name: h('input', { value: p?.name || '', maxlength: 120, required: '' }), description: h('textarea', { rows: 3, maxlength: 4000 }, p?.description || ''),
    status: select(S.meta.projectStatuses.map((s) => [s.id, s.label]), p?.status || 'active', () => {}, 'Status'), priority: select(S.meta.priorities.map((s) => [s.id, s.label]), p?.priority || 'medium', () => {}, 'Priority'),
    start: h('input', { type: 'date', value: p?.startDate || '' }), deadline: h('input', { type: 'date', value: p?.deadline || '' }), tags: h('input', { value: (p?.tags || []).join(', '), maxlength: 300 }),
    color: h('input', { type: 'color', value: color || '#ED6627', 'aria-label': 'Colour', oninput: (e) => { color = e.target.value; } }) };
  const icons = h('div', { class: 'icon-pick', role: 'group', 'aria-label': 'Icon' });
  const drawIcons = () => icons.replaceChildren(['', ...S.meta.icons].map((n) => h('button', { type: 'button', class: icon_ === n ? 'on' : '', 'aria-pressed': String(icon_ === n), 'aria-label': n || 'Default icon', onclick: () => { icon_ = n; drawIcons(); } }, icon(n || 'target'))));
  drawIcons();
  const save = h('button', { class: 'btn', type: 'submit' }, isNew ? 'Create project' : 'Save');
  const actions = [save, closer('Cancel')];
  if (!isNew) {
    actions.push(h('button', { type: 'button', class: 'btn ghost', onclick: async () => { try { await api('PATCH', `/projects/${p.id}`, { archived: !p.archived }); d.close(); toast(p.archived ? 'Project restored' : 'Project archived'); onChange(); } catch (x) { err.textContent = x.message; } } }, p.archived ? 'Restore' : 'Archive'));
    if (S.meta.canDeleteProjects) actions.push(h('button', { type: 'button', class: 'btn ghost danger', onclick: async () => {
      if (!(await confirmBox('Delete this project?', `"${p.name}" and all of its tasks and milestones will be deleted for good. This cannot be undone. Archive the project instead to keep everything.`, 'Delete project and tasks'))) return;
      try { await api('DELETE', `/projects/${p.id}?confirm=true`); d.close(); toast('Project deleted'); S.projects = S.projects.filter((x) => x.id !== p.id); onDeleted ? onDeleted() : onChange(); } catch (x) { err.textContent = x.message; } } }, icon('trash'), 'Delete'));
  }
  const d = dialog(isNew ? 'New project' : 'Edit project', h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ''; save.disabled = true;
    const body = { name: f.name.value, description: f.description.value, icon: icon_ || null, color: color || null, status: f.status.value, priority: f.priority.value, startDate: f.start.value || null, deadline: f.deadline.value || null, tags: f.tags.value.split(',').map((x) => x.trim()).filter(Boolean) };
    try { const r = await api(isNew ? 'POST' : 'PATCH', isNew ? '/projects' : `/projects/${p.id}`, body); d.close(); toast(isNew ? 'Project created' : 'Project saved'); if (isNew) location.hash = `#/project/${r.project.id}`; onChange(); }
    catch (x) { err.textContent = x.message; save.disabled = false; }
  } }, field('Name', f.name), field('Description', f.description), h('div', { class: 'two' }, field('Status', f.status), field('Priority', f.priority), field('Start date', f.start), field('Deadline', f.deadline)),
  field('Tags', f.tags, 'Separate with commas'), h('div', { class: 'two' }, field('Colour', f.color), h('div', {}, h('span', { class: 'lbl-text' }, 'Icon'), icons)), err, h('div', { class: 'row actions' }, ...actions)));
  f.name.focus();
}

function milestoneDialog(p, m, onChange) {
  const err = h('p', { class: 'err', role: 'alert' }), title = h('input', { value: m?.title || '', maxlength: 120, required: '' }), due = h('input', { type: 'date', value: m?.dueDate || '' }), desc = h('textarea', { rows: 2, maxlength: 2000 }, m?.description || '');
  const actions = [h('button', { class: 'btn', type: 'submit' }, m ? 'Save' : 'Add milestone'), closer('Cancel')];
  if (m) actions.push(h('button', { type: 'button', class: 'btn ghost danger', onclick: async () => { if (await confirmBox('Delete milestone?', 'Its tasks are kept; they just stop being linked to it.')) { try { await api('DELETE', `/milestones/${m.id}`); d.close(); onChange(); } catch (x) { err.textContent = x.message; } } } }, icon('trash'), 'Delete'));
  const d = dialog(m ? 'Edit milestone' : 'New milestone', h('form', { onsubmit: async (e) => { e.preventDefault(); err.textContent = '';
    try { const body = { title: title.value, dueDate: due.value || null, description: desc.value }; await api(m ? 'PATCH' : 'POST', m ? `/milestones/${m.id}` : `/projects/${p.id}/milestones`, body); d.close(); onChange(); } catch (x) { err.textContent = x.message; } } },
  field('Title', title), field('Due date', due), field('Description', desc), err, h('div', { class: 'row actions' }, ...actions)));
  title.focus();
}

// AI task suggestions: shown as a checklist you edit. Nothing is saved until you press Add.
function breakdownDialog(p, onChange) {
  const goal = h('input', { placeholder: 'What should be true when this is done? (optional)', maxlength: 500, 'aria-label': 'Goal' }), out = h('div', { class: 'sugg' }), err = h('p', { class: 'err', role: 'alert' });
  const go = h('button', { class: 'btn', type: 'button', onclick: async () => {
    go.disabled = true; err.textContent = ''; out.replaceChildren(h('p', { class: 'sub' }, 'Thinking…'));
    try {
      const { suggestions } = await api('POST', '/ai/breakdown', { projectId: p.id, goal: goal.value });
      const rows = suggestions.map((s) => ({ s, on: h('input', { type: 'checkbox', checked: '', 'aria-label': `Add: ${s.title}` }) }));
      const add = h('button', { class: 'btn', type: 'button', onclick: async () => {
        const chosen = rows.filter((r) => r.on.checked).map((r) => ({ title: r.s.title, description: r.s.description, priority: r.s.priority, ...(r.s.dueDate ? { dueDate: r.s.dueDate } : {}) }));
        if (!chosen.length) return; add.disabled = true;
        try { await api('POST', '/tasks/batch', { projectId: p.id, tasks: chosen }); d.close(); toast(`${chosen.length} tasks added`); onChange(); } catch (x) { err.textContent = x.message; add.disabled = false; }
      } }, 'Add selected tasks');
      out.replaceChildren(h('p', { class: 'sub' }, 'Untick any you do not want. These are suggestions only.'), rows.map(({ s, on }) => h('label', { class: 'sugg-row' }, on, h('span', {}, h('b', {}, s.title), h('small', {}, [label(S.meta.priorities, s.priority), s.dueDate ? `due ${fmtDate(s.dueDate)}` : '', s.description].filter(Boolean).join(' · '))))), add);
    } catch (x) { out.replaceChildren(); err.textContent = x.message; }
    go.disabled = false;
  } }, icon('sparkle'), 'Suggest tasks');
  const d = dialog(`Suggest tasks for ${p.name}`, h('p', { class: 'sub' }, 'The AI reads the project name, description and existing task titles, then proposes tasks for you to review.'), h('div', { class: 'row' }, goal, go), err, out, h('div', { class: 'row actions' }, closer()));
}
