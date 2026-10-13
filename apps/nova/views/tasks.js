import { api, h, toast } from '../services/api.js';
import { icon } from '/shared/icons.js';
import { S, select, empty, badge, prioBadge, dueText, todayStr, addDays, projectOptions } from '../lib.js';
import { taskRow, quickAdd, openTask } from './taskui.js';

const F = { q: '', project: '', status: '', priority: '', due: '', sort: 'dueDate', dir: 'asc', archived: false, hideDone: true };

export async function tasksView({ frame, redraw }) {
  const list = h('div', { class: 'tasks card flat', 'aria-live': 'polite' }), count = h('p', { class: 'count' });
  async function load() {
    const qs = new URLSearchParams({ sort: F.sort, dir: F.dir, archived: F.archived, limit: 500 });
    for (const k of ['q', 'project', 'status', 'priority', 'due']) if (F[k]) qs.set(k, F[k]);
    if (F.hideDone && !F.status && !F.archived) qs.set('open', 'true');
    let r; try { r = await api('GET', `/tasks?${qs}`); } catch (x) { list.replaceChildren(h('p', { class: 'err' }, x.message)); return; }
    const filtered = F.q || F.project || F.status || F.priority || F.due;
    count.textContent = r.total === 1 ? '1 task' : `${r.total} tasks`;
    list.replaceChildren(...(r.tasks.length ? r.tasks.map((t) => taskRow(t, load)) : [empty('check', filtered ? 'No tasks match these filters.' : F.archived ? 'No archived tasks.' : 'No open tasks yet. Add one above.')]));
  }
  const search = h('input', { type: 'search', placeholder: 'Search tasks', 'aria-label': 'Search tasks', value: F.q }); let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { F.q = search.value; load(); }, 250); });
  const set = (k) => (v) => { F[k] = v; load(); };
  frame('tasks', h('div', { class: 'page-head' }, h('h1', {}, 'Tasks'), h('button', { class: 'btn', onclick: () => openTask(null, { onChange: load }) }, icon('plus'), 'New task')),
    quickAdd({ onChange: load }),
    h('div', { class: 'tools' }, h('div', { class: 'search' }, icon('search'), search),
      select(projectOptions('Any project').concat([['none', 'No project']]).map(([v, t]) => [v, t]), F.project, set('project'), 'Filter by project'),
      select([['', 'Any status'], ...S.meta.statuses.map((s) => [s.id, s.label])], F.status, set('status'), 'Filter by status'),
      select([['', 'Any priority'], ...S.meta.priorities.map((s) => [s.id, s.label])], F.priority, set('priority'), 'Filter by priority'),
      select([['', 'Any due date'], ['overdue', 'Overdue'], ['today', 'Due today'], ['week', 'Next 7 days'], ['none', 'No due date']], F.due, set('due'), 'Filter by due date'),
      select([['dueDate|asc', 'Due date'], ['priority|asc', 'Priority'], ['status|asc', 'Status'], ['title|asc', 'Title A to Z'], ['updatedAt|desc', 'Recently changed'], ['createdAt|desc', 'Newest']], `${F.sort}|${F.dir}`, (v) => { [F.sort, F.dir] = v.split('|'); load(); }, 'Sort'),
      select([['false', 'Active tasks'], ['true', 'Archived tasks']], String(F.archived), (v) => { F.archived = v === 'true'; load(); }, 'Show')),
    h('label', { class: 'toggle-row' }, h('input', { type: 'checkbox', checked: F.hideDone ? '' : null, onchange: (e) => { F.hideDone = e.target.checked; load(); } }), 'Hide finished tasks'),
    count, list);
  await load();
}

// ---- Board ----
const BF = { project: '', q: '' };
export async function boardView({ frame }) {
  const board = h('div', { class: 'board' });
  async function load() {
    const qs = new URLSearchParams({ limit: 1000, sort: 'priority' }); if (BF.project) qs.set('project', BF.project); if (BF.q) qs.set('q', BF.q);
    let tasks; try { tasks = (await api('GET', `/tasks?${qs}`)).tasks; } catch (x) { board.replaceChildren(h('p', { class: 'err' }, x.message)); return; }
    const recent = addDays(todayStr(), -14); // keep the Done column short: last two weeks
    const move = async (id, status) => { try { await api('PATCH', `/tasks/${id}`, { status }); } catch (x) { toast(x.message); } load(); };
    board.replaceChildren(...S.meta.statuses.map((s) => {
      const items = tasks.filter((t) => t.status === s.id && (s.id !== 'done' || (t.completedAt || '').slice(0, 10) >= recent));
      const col = h('section', { class: 'col', 'aria-label': `${s.label}, ${items.length} tasks`,
        ondragover: (e) => { e.preventDefault(); col.classList.add('over'); }, ondragleave: () => col.classList.remove('over'),
        ondrop: (e) => { e.preventDefault(); col.classList.remove('over'); const id = e.dataTransfer.getData('text/plain'); if (id && S.meta.canWriteTasks) move(id, s.id); } },
        h('h3', {}, s.label, h('span', { class: 'n' }, String(items.length))),
        ...(items.length ? items.map((t) => card(t)) : [h('p', { class: 'fine' }, 'Nothing here')]));
      return col;
    }));
    function card(t) {
      const due = dueText(t);
      return h('article', { class: `bcard${t.status === 'done' ? ' done' : ''}`, draggable: S.meta.canWriteTasks ? 'true' : null, ondragstart: (e) => e.dataTransfer.setData('text/plain', t.id) },
        h('button', { class: 'bcard-title', type: 'button', onclick: () => openTask(t, { onChange: load }) }, t.title),
        h('div', { class: 'bcard-meta' }, t.projectName ? h('small', {}, t.projectName) : null, due ? badge(due, t.overdue ? 'bad' : '') : null, prioBadge(t.priority), t.waitingOn ? badge(`Waiting on ${t.waitingOn}`, 'warn') : null),
        S.meta.canWriteTasks ? select(S.meta.statuses.map((x) => [x.id, x.label]), t.status, (v) => move(t.id, v), `Move ${t.title} to`) : null);
    }
  }
  const search = h('input', { type: 'search', placeholder: 'Search the board', 'aria-label': 'Search the board', value: BF.q }); let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { BF.q = search.value; load(); }, 250); });
  frame('board', h('div', { class: 'page-head' }, h('h1', {}, 'Board'), h('button', { class: 'btn', onclick: () => openTask(null, { onChange: load, projectId: BF.project || null }) }, icon('plus'), 'New task')),
    h('div', { class: 'tools two-col' }, h('div', { class: 'search' }, icon('search'), search), select(projectOptions('All projects'), BF.project, (v) => { BF.project = v; load(); }, 'Project')),
    h('p', { class: 'fine' }, 'Drag a card to another column, or use the menu on the card. Finished tasks stay for two weeks.'), board);
  await load();
}
