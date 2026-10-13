import { api, h, toast } from '../services/api.js';
import { icon } from '/shared/icons.js';
import { S, fmtDate, progressBar, empty, badge } from '../lib.js';
import { taskRow, quickAdd, openTask } from './taskui.js';
import { openProject } from './projects.js';

export async function overviewView({ frame, redraw }) {
  const o = await api('GET', '/overview');
  const c = o.counts, section = (title, tasks, cls = '') => (tasks.length ? h('section', { class: `card ${cls}` }, h('h3', {}, title), h('div', { class: 'tasks' }, tasks.map((t) => taskRow(t, redraw)))) : null);
  const stat = (value, text, cls = '') => h('div', { class: `stat-card ${cls}` }, h('b', {}, String(value)), h('span', {}, text));
  const brandNew = !c.total && !S.projects.length;

  const summaryBox = h('div', { class: 'ai-summary', hidden: '' });
  const summaryBtn = S.meta.ai ? h('button', { class: 'btn ghost small', type: 'button', onclick: async (e) => {
    const b = e.currentTarget; b.disabled = true; summaryBox.hidden = false; summaryBox.textContent = 'Writing your summary…';
    try { summaryBox.textContent = (await api('POST', '/ai/summary', {})).summary; } catch (x) { summaryBox.textContent = x.message; }
    b.disabled = false;
  } }, icon('sparkle'), 'Summarise my progress') : null;

  frame('overview',
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Overview'), h('p', { class: 'sub' }, fmtDate(o.today, true))), h('div', { class: 'row tight' }, summaryBtn, h('button', { class: 'btn', onclick: () => openTask(null, { onChange: redraw }) }, icon('plus'), 'New task'))),
    summaryBox,
    brandNew ? h('section', { class: 'card onboard' }, h('h2', {}, 'Welcome to Nova'), h('p', { class: 'sub' }, 'Nova turns ideas into plans and plans into finished work. Start small:'),
      h('ol', { class: 'steps' }, h('li', {}, 'Create a project for something you want to finish.'), h('li', {}, 'Add the first few tasks, with due dates if they have them.'), h('li', {}, 'Come back here to see what needs attention.')),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => openProject(null, { onChange: redraw }) }, icon('plus'), 'Create a project'), h('button', { class: 'btn ghost', onclick: () => openTask(null, { onChange: redraw }) }, 'Just add a task')))
    : [quickAdd({ onChange: redraw }),
      h('div', { class: 'stat-grid' }, stat(c.overdue, 'Overdue', c.overdue ? 'bad' : ''), stat(c.dueToday, 'Due today'), stat(c.dueSoon, 'Next 7 days'), stat(c.blocked, 'Blocked or waiting'), stat(c.doneLast7Days, 'Done this week')),
      !c.overdue && !c.dueToday && !c.dueSoon && !c.blocked ? empty('check', c.open ? 'Nothing is due this week. Nice and calm.' : 'All clear. Add a task to get going.') : null,
      h('div', { class: 'grid' }, section('Overdue', o.overdue, 'attn'), section('Due today', o.dueToday), section('Next 7 days', o.dueSoon), section('Blocked or waiting', o.blocked)),
      h('section', {}, h('div', { class: 'page-head sub-head' }, h('h2', {}, 'Projects'), h('a', { class: 'btn ghost small', href: '#/projects' }, 'All projects')),
        o.projects.length ? h('div', { class: 'grid' }, o.projects.slice(0, 6).map((p) => projectCard(p))) : empty('target', 'No active projects yet.', h('button', { class: 'btn small', onclick: () => openProject(null, { onChange: redraw }) }, icon('plus'), 'Create a project'))),
      o.upcomingMilestones.length ? h('section', { class: 'card' }, h('h3', {}, 'Upcoming milestones'), h('ul', { class: 'items' }, o.upcomingMilestones.map((m) => h('li', {}, m.title, h('div', { class: 'sub' }, `${m.projectName} · ${fmtDate(m.dueDate)}`))))) : null]);
}

export function projectCard(p) {
  return h('a', { class: 'card proj', href: `#/project/${p.id}`, style: p.color ? `--accent:${p.color}` : null },
    h('div', { class: 'proj-top' }, h('span', { class: 'proj-ic', 'aria-hidden': 'true' }, icon(p.icon || 'target')), h('b', {}, p.name), p.archived ? badge('Archived', 'off') : badge(S.meta.projectStatuses.find((s) => s.id === p.status)?.label || p.status, p.status === 'on_hold' ? 'warn' : '')),
    progressBar(p.progress.percent, p.color),
    h('small', { class: 'proj-meta' }, `${p.progress.percent}% · ${p.progress.done}/${p.progress.total} done`, p.progress.overdue ? ` · ${p.progress.overdue} overdue` : '', p.deadline ? ` · due ${fmtDate(p.deadline)}` : ''));
}
