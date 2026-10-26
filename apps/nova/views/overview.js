import { api, h, toast } from '../services/api.js';
import { icon } from '/shared/icons.js';
import { S, fmtDate, progressBar, empty, badge } from '../lib.js';
import { taskRow, quickAdd, openTask } from './taskui.js';
import { openProject } from './projects.js';
import { eventRow, openEvent } from './eventui.js';

export async function overviewView({ frame, redraw }) {
  const o = await api('GET', '/overview');
  const c = o.counts, section = (title, tasks, cls = '') => (tasks.length ? h('section', { class: `card ${cls}` }, h('h3', {}, title), h('div', { class: 'tasks' }, tasks.map((t) => taskRow(t, redraw)))) : null);
  const stat = (value, text, cls = '') => h('div', { class: `stat-card ${cls}` }, h('b', {}, String(value)), h('span', {}, text));
  const brandNew = !c.total && !S.projects.length;
  const hr = new Date().getHours(), greet = hr < 5 ? 'Still up' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening', mood = hr < 5 || hr >= 21 ? 'night' : hr < 12 ? 'morning' : hr < 18 ? 'day' : 'evening';
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const lead = brandNew ? 'Let\'s set up your first project. It only takes a minute.' : c.overdue ? `${plural(c.overdue, 'task')} could use your attention, then you are on track.` : c.dueToday ? `${plural(c.dueToday, 'task')} to finish today. You have got this.` : c.eventsToday ? `${plural(c.eventsToday, 'event')} on today. Nothing due.` : c.doneLast7Days ? `Nothing due today, and you finished ${plural(c.doneLast7Days, 'task')} this week. Nice work.` : 'Nothing due today. A calm day.';

  const summaryBox = h('div', { class: 'ai-summary', hidden: '' });
  const summaryBtn = S.meta.ai ? h('button', { class: 'btn ghost small', type: 'button', onclick: async (e) => {
    const b = e.currentTarget; b.disabled = true; summaryBox.hidden = false; summaryBox.textContent = 'Writing your summary…';
    try { summaryBox.textContent = (await api('POST', '/ai/summary', {})).summary; } catch (x) { summaryBox.textContent = x.message; }
    b.disabled = false;
  } }, icon('sparkle'), 'Summarise my progress') : null;

  frame('overview',
    h('div', { class: `novahero mood-${mood}` }, h('small', {}, fmtDate(o.today, true)), h('h1', {}, `${greet}, ${S.me.user.displayName.split(' ')[0]} 👋`), h('p', { class: 'lead' }, lead),
      h('div', { class: 'row tight' }, summaryBtn, S.meta.canWriteTasks ? h('button', { class: 'btn ghost small', onclick: () => openEvent(null, { onChange: redraw }) }, icon('calendar'), 'New event') : null)),
    summaryBox,
    brandNew ? h('section', { class: 'card onboard' }, h('h2', {}, 'Welcome to Nova'), h('p', { class: 'sub' }, 'Nova turns ideas into plans and plans into finished work. Start small:'),
      h('ol', { class: 'steps' }, h('li', {}, 'Create a project for something you want to finish.'), h('li', {}, 'Add the first few tasks, with due dates if they have them.'), h('li', {}, 'Come back here to see what needs attention.')),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => openProject(null, { onChange: redraw }) }, icon('plus'), 'Create a project'), h('button', { class: 'btn ghost', onclick: () => openTask(null, { onChange: redraw }) }, 'Just add a task')))
    : [quickAdd({ onChange: redraw }),
      h('div', { class: 'stat-grid' }, stat(c.overdue, 'Overdue', c.overdue ? 'bad' : ''), stat(c.eventsToday, 'Events today'), stat(c.dueToday, 'Due today'), stat(c.dueSoon, 'Next 7 days'), stat(c.blocked, 'Blocked or waiting'), stat(c.doneLast7Days, 'Done this week')),
      !c.overdue && !c.dueToday && !c.dueSoon && !c.blocked && !o.upcomingEvents.length && !o.todayEvents.length ? empty('check', c.open ? 'Nothing is due this week. Nice and calm.' : 'All clear. Add a task to get going.') : null,
      o.todayEvents.length || o.upcomingEvents.length ? h('section', { class: 'card' }, h('div', { class: 'row between' }, h('h3', {}, o.todayEvents.length ? 'On today' : 'Coming up'), h('a', { class: 'btn ghost small', href: '#/schedule' }, 'Full schedule')),
        h('div', { class: 'tasks' }, [...o.todayEvents, ...(o.todayEvents.length ? [] : o.upcomingEvents.slice(0, 4))].map((e) => h('div', {}, e.occurrenceDate !== o.today && !o.todayEvents.length ? h('small', { class: 'ev-day' }, fmtDate(e.occurrenceDate)) : null, eventRow(e, redraw))))) : null,
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
