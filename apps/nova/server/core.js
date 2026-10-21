// Nova's business logic. Routes, the dashboard widgets, the report and the AI tools all call these functions, so every path to the
// data follows the same rules: ownership checks, validation of references, dependencies, recurrence and progress.
import { badRequest, conflict, notFound } from '../../../shared/errors.js';
import { newId, nowIso } from '../../../shared/ids.js';
import { addDays, diffDays, expandDates, isDate, minutes, nextOccurrence, todayIn, toMs, validTimeZone } from './dates.js';
import { SCHEMA_VERSION, eventDefaults, projectDefaults, taskDefaults } from './schema.js';

export const LIMITS = { projects: 300, tasks: 10_000, milestonesPerProject: 50, events: 5000 };
const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };
const STATUS_RANK = { blocked: 0, in_progress: 1, todo: 2, backlog: 3, done: 4 };
const strip = ({ ownerId, ...d }) => d;
export const isRoutine = (t) => !!t.recurrence || !!t.seriesId; // routines repeat; they are not part of "finishing" a project

export function makeCore(s) {
  const projects = s.storage.collection('nova_projects', { indexes: ['ownerId'] });
  const tasks = s.storage.collection('nova_tasks', { indexes: ['ownerId'] });
  const milestones = s.storage.collection('nova_milestones', { indexes: ['ownerId'] });
  const settings = s.storage.collection('nova_settings', { indexes: ['ownerId'] });
  const proposals = s.storage.collection('nova_proposals', { indexes: ['ownerId'] });
  const events = s.storage.collection('nova_events', { indexes: ['ownerId'] });
  const cols = { projects, tasks, milestones, settings, proposals, events };

  // ---- Who owns what. Another person's id looks exactly like an id that does not exist (404). ----
  const mineOf = (col) => (user) => col.find({ where: { ownerId: user.id }, limit: 20000 });
  const allProjects = mineOf(projects), allTasks = mineOf(tasks), allMilestones = mineOf(milestones);
  const ownOf = (col, label) => async (id, user) => { const d = id ? await col.get(id) : null; if (!d || d.ownerId !== user.id) throw notFound(`${label} not found`); return d; };
  const ownEvent = ownOf(events, 'Event'), ownProject = ownOf(projects, 'Project'), ownTask = ownOf(tasks, 'Task'), ownMilestone = ownOf(milestones, 'Milestone');

  // ---- Settings and "today" ----
  async function getSettings(user) {
    const d = await settings.get(user.id);
    return { timezone: validTimeZone(d?.timezone) ? d.timezone : 'UTC', configured: !!d };
  }
  async function saveSettings(user, patch) {
    const cur = await settings.get(user.id);
    if (cur) await settings.update(user.id, patch);
    else await settings.insert({ id: user.id, ownerId: user.id, schemaVersion: SCHEMA_VERSION, timezone: 'UTC', ...patch });
    return getSettings(user);
  }
  const today = async (user) => todayIn((await getSettings(user)).timezone);

  // ---- Progress ----
  // Project progress = finished tasks / all tasks, ignoring archived tasks and routines (a repeating task is never "done").
  function progressOf(projectTasks, todayStr) {
    const real = projectTasks.filter((t) => !t.archived && !isRoutine(t));
    const done = real.filter((t) => t.status === 'done').length;
    const open = projectTasks.filter((t) => !t.archived && t.status !== 'done');
    const overdue = open.filter((t) => t.dueDate && t.dueDate < todayStr).length;
    const nextDue = open.filter((t) => t.dueDate && t.dueDate >= todayStr).map((t) => t.dueDate).sort()[0] ?? null;
    return { total: real.length, done, percent: real.length ? Math.round((done / real.length) * 100) : 0, open: open.length, overdue, nextDue };
  }
  const projectView = (p, ptasks, todayStr) => ({ ...strip(p), progress: progressOf(ptasks, todayStr) });

  // ---- Reading ----
  const dep = (all) => { const m = new Map(all.map((t) => [t.id, t])); return (t) => (t.dependsOn || []).filter((id) => m.has(id) && m.get(id).status !== 'done'); };
  function taskView(t, ctx) {
    const waiting = ctx.openDeps(t);
    return { ...strip(t), projectName: ctx.pname.get(t.projectId) ?? null, milestoneTitle: ctx.mname.get(t.milestoneId) ?? null,
      overdue: t.status !== 'done' && !t.archived && !!t.dueDate && t.dueDate < ctx.today, waitingOn: waiting.length,
      subtaskCounts: { total: t.subtasks?.length || 0, done: (t.subtasks || []).filter((x) => x.done).length } };
  }
  async function context(user) {
    const [ps, ts, ms, td] = await Promise.all([allProjects(user), allTasks(user), allMilestones(user), today(user)]);
    return { ps, ts, ms, today: td, pname: new Map(ps.map((p) => [p.id, p.name])), mname: new Map(ms.map((m) => [m.id, m.title])), openDeps: dep(ts) };
  }
  // Open work that counts for "what needs attention": not archived, not in an archived project.
  const liveTasks = (ctx) => { const gone = new Set(ctx.ps.filter((p) => p.archived).map((p) => p.id)); return ctx.ts.filter((t) => !t.archived && !gone.has(t.projectId)); };

  async function listProjects(user, { archived = false } = {}) {
    const ctx = await context(user), by = Map.groupBy(ctx.ts, (t) => t.projectId);
    return ctx.ps.filter((p) => !!p.archived === archived).sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999') || a.name.localeCompare(b.name))
      .map((p) => projectView(p, by.get(p.id) || [], ctx.today));
  }
  async function getProject(user, id) {
    const p = await ownProject(id, user), ctx = await context(user);
    const mine = ctx.ts.filter((t) => t.projectId === p.id);
    const ms = ctx.ms.filter((m) => m.projectId === p.id).sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || a.createdAt.localeCompare(b.createdAt))
      .map((m) => ({ ...strip(m), progress: progressOf(mine.filter((t) => t.milestoneId === m.id), ctx.today) }));
    return { ...projectView(p, mine, ctx.today), milestones: ms };
  }

  function sortTasks(list, sort, dir) {
    const mul = dir === 'desc' ? -1 : 1, nul = (d) => d || '9999-99-99';
    const cmp = { dueDate: (a, b) => nul(a.dueDate).localeCompare(nul(b.dueDate)), priority: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
      status: (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status], title: (a, b) => a.title.localeCompare(b.title),
      createdAt: (a, b) => a.createdAt.localeCompare(b.createdAt), updatedAt: (a, b) => a.updatedAt.localeCompare(b.updatedAt) }[sort] || (() => 0);
    return list.sort((a, b) => mul * cmp(a, b) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt.localeCompare(b.createdAt));
  }
  async function listTasks(user, f = {}) {
    const ctx = await context(user), t0 = ctx.today;
    let list = ctx.ts.filter((t) => !!t.archived === !!f.archived);
    if (f.projectId === 'none') list = list.filter((t) => !t.projectId); else if (f.projectId) list = list.filter((t) => t.projectId === f.projectId);
    if (f.milestoneId) list = list.filter((t) => t.milestoneId === f.milestoneId);
    if (f.status) list = list.filter((t) => t.status === f.status);
    if (f.open) list = list.filter((t) => t.status !== 'done');
    if (f.priority) list = list.filter((t) => t.priority === f.priority);
    if (f.tag) list = list.filter((t) => t.tags.includes(f.tag.toLowerCase()));
    if (f.due === 'overdue') list = list.filter((t) => t.status !== 'done' && t.dueDate && t.dueDate < t0);
    else if (f.due === 'today') list = list.filter((t) => t.dueDate === t0);
    else if (f.due === 'week') list = list.filter((t) => t.dueDate && t.dueDate >= t0 && t.dueDate <= addDays(t0, 7));
    else if (f.due === 'none') list = list.filter((t) => !t.dueDate);
    if (f.from) list = list.filter((t) => t.dueDate && t.dueDate >= f.from);
    if (f.to) list = list.filter((t) => t.dueDate && t.dueDate <= f.to);
    if (f.q) { const q = f.q.toLowerCase(); list = list.filter((t) => `${t.title} ${t.description} ${t.notes} ${t.tags.join(' ')}`.toLowerCase().includes(q)); }
    const total = list.length;
    list = sortTasks(list, f.sort || 'dueDate', f.dir || 'asc').slice(f.offset || 0, (f.offset || 0) + (f.limit || 500));
    return { tasks: list.map((t) => taskView(t, ctx)), total };
  }
  async function getTask(user, id) { const t = await ownTask(id, user), ctx = await context(user);
    return { ...taskView(t, ctx), dependencies: (t.dependsOn || []).filter((d) => ctx.ts.some((x) => x.id === d)).map((d) => { const x = ctx.ts.find((y) => y.id === d); return { id: x.id, title: x.title, status: x.status }; }) }; }

  async function overview(user) {
    const ctx = await context(user), live = liveTasks(ctx), t0 = ctx.today, open = live.filter((t) => t.status !== 'done');
    const view = (t) => taskView(t, ctx), byDue = (a, b) => (a.dueDate || '').localeCompare(b.dueDate || '') || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    const overdue = open.filter((t) => t.dueDate && t.dueDate < t0).sort(byDue);
    const dueToday = open.filter((t) => t.dueDate === t0).sort(byDue);
    const dueSoon = open.filter((t) => t.dueDate && t.dueDate > t0 && t.dueDate <= addDays(t0, 7)).sort(byDue);
    const blocked = open.filter((t) => t.status === 'blocked' || ctx.openDeps(t).length).sort(byDue);
    const weekAgo = addDays(t0, -7);
    const by = Map.groupBy(ctx.ts, (t) => t.projectId);
    const activeProjects = ctx.ps.filter((p) => !p.archived && p.status !== 'completed').map((p) => projectView(p, by.get(p.id) || [], t0));
    const upcomingMilestones = ctx.ms.filter((m) => !m.completed && m.dueDate && ctx.ps.some((p) => p.id === m.projectId && !p.archived)).sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 5)
      .map((m) => ({ ...strip(m), projectName: ctx.pname.get(m.projectId) }));
    const evs = eventsIn(await mineOf(events)(user), t0, addDays(t0, 7), ctx.pname), todayEvents = evs.filter((e) => e.occurrenceDate <= t0), upcomingEvents = evs.filter((e) => e.occurrenceDate > t0).slice(0, 10);
    return { today: t0, todayEvents, upcomingEvents, counts: { eventsToday: todayEvents.length, open: open.length, overdue: overdue.length, dueToday: dueToday.length, dueSoon: dueSoon.length, blocked: blocked.length, projects: activeProjects.length,
        doneLast7Days: live.filter((t) => t.completedAt && t.completedAt.slice(0, 10) >= weekAgo).length, total: ctx.ts.filter((t) => !t.archived).length },
      overdue: overdue.slice(0, 20).map(view), dueToday: dueToday.slice(0, 20).map(view), dueSoon: dueSoon.slice(0, 20).map(view), blocked: blocked.slice(0, 20).map(view),
      projects: activeProjects, upcomingMilestones };
  }

  async function calendar(user, from, to) {
    if (!isDate(from) || !isDate(to) || toMs(to) < toMs(from) || diffDays(from, to) > 62) throw badRequest('from and to must be dates at most 62 days apart');
    const ctx = await context(user), gone = new Set(ctx.ps.filter((p) => p.archived).map((p) => p.id));
    const inR = (d) => d && d >= from && d <= to;
    return { today: ctx.today, from, to,
      tasks: ctx.ts.filter((t) => !t.archived && !gone.has(t.projectId) && inR(t.dueDate)).map((t) => taskView(t, ctx)),
      milestones: ctx.ms.filter((m) => inR(m.dueDate) && !gone.has(m.projectId)).map((m) => ({ ...strip(m), projectName: ctx.pname.get(m.projectId) })),
      deadlines: ctx.ps.filter((p) => !p.archived && inR(p.deadline)).map((p) => ({ id: p.id, name: p.name, deadline: p.deadline, status: p.status })),
      events: eventsIn(await mineOf(events)(user), from, to, ctx.pname) };
  }


  // ---- Events and activities (the schedule) ----
  // An event has a date and, unless it is all day, a start time. Repeating events expand on read, so editing one edits the whole series.
  function eventsIn(all, from, to, pname) {
    const occ = [];
    for (const e of all) {
      if (e.endDate && e.endDate > e.date && !e.recurrence) { // a multi-day event is one entry per day, each with its own times if set
        const count = diffDays(e.date, e.endDate) + 1;
        for (let i = 0; i < count; i++) {
          const day = addDays(e.date, i); if (day < from || day > to) continue;
          const dt = e.dayTimes?.[day], own = dt ? { allDay: !!dt.allDay, startTime: dt.allDay ? null : dt.startTime ?? null, endTime: dt.allDay ? null : dt.endTime ?? null } : {};
          occ.push({ ...strip(e), ...own, occurrenceDate: day, dayIndex: i + 1, dayCount: count, ownTimes: !!dt, projectName: pname.get(e.projectId) ?? null, clash: false });
        }
        continue;
      }
      for (const d of expandDates(e, from, to)) occ.push({ ...strip(e), occurrenceDate: d, projectName: pname.get(e.projectId) ?? null, clash: false });
    }
    const byDay = Map.groupBy(occ.filter((o) => !o.allDay && o.startTime), (o) => o.occurrenceDate);
    for (const list of byDay.values()) for (const a of list) for (const b of list) {
      if (a === b) continue;
      const aS = minutes(a.startTime), aE = minutes(a.endTime) ?? aS + 60, bS = minutes(b.startTime), bE = minutes(b.endTime) ?? bS + 60;
      if (aS < bE && bS < aE) a.clash = true;
    }
    return occ.sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate) || (a.allDay ? 0 : 1) - (b.allDay ? 0 : 1) || (a.startTime || '').localeCompare(b.startTime || '') || a.title.localeCompare(b.title));
  }
  async function listEvents(user, from, to) {
    if (!isDate(from) || !isDate(to) || toMs(to) < toMs(from) || diffDays(from, to) > 92) throw badRequest('from and to must be dates at most 92 days apart');
    const [all, ps] = await Promise.all([mineOf(events)(user), allProjects(user)]);
    return { from, to, events: eventsIn(all, from, to, new Map(ps.map((p) => [p.id, p.name]))) };
  }
  async function checkEvent(user, doc) {
    if (doc.projectId) await ownProject(doc.projectId, user);
    if (doc.endDate && doc.endDate < doc.date) throw badRequest('The end date must not be before the start date');
    if (doc.allDay) { doc.startTime = null; doc.endTime = null; }
    else if (!doc.startTime) throw badRequest('Give a start time, or mark the event as all day');
    if (doc.endTime && !doc.startTime) throw badRequest('An end time needs a start time');
    if (doc.endTime && doc.startTime && (!doc.endDate || doc.endDate === doc.date) && doc.endTime <= doc.startTime) throw badRequest('The end time must be after the start time');
    if (doc.endDate && doc.endDate > doc.date && !doc.recurrence && doc.dayTimes) { for (const k of Object.keys(doc.dayTimes)) if (k < doc.date || k > doc.endDate) delete doc.dayTimes[k]; } else doc.dayTimes = {};
    if (doc.recurrence) {
      if (doc.endDate && doc.endDate !== doc.date) throw badRequest('A repeating event cannot span several days');
      if (doc.recurrence.until && doc.recurrence.until < doc.date) throw badRequest('The repeat end date must not be before the event date');
      doc.recurrence = { ...doc.recurrence, anchor: doc.date };
    }
  }
  async function createEvent(user, input) {
    if ((await events.count({ ownerId: user.id })) >= LIMITS.events) throw conflict(`You can have at most ${LIMITS.events} events`, 'limit');
    const doc = { ...eventDefaults(), ...input }; await checkEvent(user, doc);
    return strip(await events.insert({ id: newId('evt'), ownerId: user.id, schemaVersion: SCHEMA_VERSION, ...doc }));
  }
  async function updateEvent(user, id, patch) {
    const e = await ownEvent(id, user), merged = { ...e, ...patch };
    await checkEvent(user, merged);
    const { id: _i, ownerId: _o, createdAt: _c, updatedAt: _u, schemaVersion: _s, ...fields } = merged;
    return strip(await events.update(e.id, fields));
  }
  async function deleteEvent(user, id) { const e = await ownEvent(id, user); await events.delete(e.id); return { ok: true }; }
  async function getEvent(user, id) { return strip(await ownEvent(id, user)); }


  // ---- Nudges and streaks ----
  // Things worth a notification right now. Each item has a stable id, so a phone shows it once.
  async function notifications(user) {
    const st = await getSettings(user), parts = new Intl.DateTimeFormat('en-GB', { timeZone: validTimeZone(st.timezone) ? st.timezone : 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()), nowMin = minutes(parts);
    const ctx = await context(user), t0 = ctx.today, items = [];
    for (const e of eventsIn(await mineOf(events)(user), t0, t0, ctx.pname).filter((x) => !x.allDay && x.startTime)) {
      const until = minutes(e.startTime) - nowMin;
      if (until >= 0 && until <= 60) items.push({ id: `ev:${e.id}:${t0}:${e.startTime}`, title: until <= 1 ? `${e.title} is starting now` : `${e.title} in ${until} min`, body: [`${e.startTime}${e.endTime ? `–${e.endTime}` : ''}`, e.location].filter(Boolean).join(' · '), url: '/apps/nova/#/schedule' });
    }
    const due = liveTasks(ctx).filter((t) => t.status !== 'done' && t.dueDate && t.dueDate <= t0).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    if (nowMin >= 7 * 60 && due.length) {
      const late = due.filter((t) => t.dueDate < t0).length;
      items.push({ id: `digest:${t0}`, title: `${due.length} task${due.length === 1 ? '' : 's'} need${due.length === 1 ? 's' : ''} you today`, body: `${due.slice(0, 3).map((t) => t.title).join(', ')}${due.length > 3 ? ` and ${due.length - 3} more` : ''}${late ? ` (${late} overdue)` : ''}`, url: '/apps/nova/#/' });
    }
    return { items };
  }
  // Consecutive days (ending today, or yesterday if nothing is done yet today) on which at least one task was finished.
  async function streak(user) {
    const st = await getSettings(user), ctx = await context(user), t0 = ctx.today, tz = (iso) => todayIn(st.timezone, new Date(iso));
    const counts = new Map(); for (const t of ctx.ts) if (t.completedAt) { const d = tz(t.completedAt); counts.set(d, (counts.get(d) || 0) + 1); }
    let d = counts.has(t0) ? t0 : addDays(t0, -1), days = 0; while (counts.has(d) && days < 3650) { days++; d = addDays(d, -1); }
    return { today: t0, days, doneToday: counts.get(t0) || 0, remaining: liveTasks(ctx).filter((t) => t.status !== 'done' && t.dueDate && t.dueDate <= t0).length };
  }

  // ---- Checks shared by create and update ----
  async function checkRefs(user, doc, selfId, ctx) {
    if (doc.projectId) await ownProject(doc.projectId, user);
    if (doc.milestoneId) {
      const m = await ownMilestone(doc.milestoneId, user);
      if (m.projectId !== doc.projectId) throw badRequest('The milestone must belong to the task\'s project');
    }
    if (doc.startDate && doc.dueDate && doc.startDate > doc.dueDate) throw badRequest('The start date must not be after the due date');
    if (doc.recurrence && !doc.dueDate) throw badRequest('A repeating task needs a due date');
    if (doc.recurrence?.until && doc.dueDate && doc.recurrence.until < doc.dueDate) throw badRequest('The repeat end date must not be before the due date');
    if (doc.dependsOn?.length) {
      const all = ctx?.ts || await allTasks(user), byId = new Map(all.map((t) => [t.id, t]));
      for (const id of doc.dependsOn) {
        if (id === selfId) throw badRequest('A task cannot depend on itself');
        if (!byId.has(id)) throw badRequest('A dependency does not exist');
      }
      // No loops: walk the chain from each dependency; reaching this task again would make a cycle.
      if (selfId) for (const start of doc.dependsOn) {
        const seen = new Set(), stack = [start];
        while (stack.length) { const id = stack.pop(); if (id === selfId) throw badRequest('That dependency would create a loop'); if (seen.has(id)) continue; seen.add(id); stack.push(...(byId.get(id)?.dependsOn || [])); }
      }
    }
  }
  const withIds = (subs) => subs.map((x) => ({ id: x.id || newId('sub'), title: x.title, done: x.done }));
  const cleanDoc = (d) => { const { assignedToMe, ...rest } = d; return { ...rest, assigneeId: assignedToMe === false ? null : d.ownerId }; };

  // ---- Projects ----
  async function createProject(user, input) {
    if ((await projects.count({ ownerId: user.id })) >= LIMITS.projects) throw conflict(`You can have at most ${LIMITS.projects} projects`, 'limit');
    const doc = { ...projectDefaults(), ...input };
    if (doc.startDate && doc.deadline && doc.startDate > doc.deadline) throw badRequest('The start date must not be after the deadline');
    const p = await projects.insert({ id: newId('prj'), ownerId: user.id, schemaVersion: SCHEMA_VERSION, ...doc });
    return getProject(user, p.id);
  }
  async function updateProject(user, id, patch) {
    const p = await ownProject(id, user), merged = { ...p, ...patch };
    if (merged.startDate && merged.deadline && merged.startDate > merged.deadline) throw badRequest('The start date must not be after the deadline');
    await projects.update(p.id, patch);
    return getProject(user, p.id);
  }
  async function deleteProject(user, id, ip) {
    const p = await ownProject(id, user);
    let removedTasks = 0;
    await s.storage.transaction(async () => {
      removedTasks = await tasks.deleteWhere({ ownerId: user.id, projectId: p.id });
      await milestones.deleteWhere({ ownerId: user.id, projectId: p.id });
      for (const e of await events.find({ where: { ownerId: user.id, projectId: p.id }, limit: 20000 })) await events.update(e.id, { projectId: null });
      await projects.delete(p.id);
    });
    await s.audit.record({ actorId: user.id, action: 'nova.project.delete', targetType: 'nova_project', targetId: p.id, meta: { tasksRemoved: removedTasks }, ip });
    return { ok: true, tasksRemoved: removedTasks };
  }

  // ---- Milestones ----
  async function createMilestone(user, projectId, input) {
    const p = await ownProject(projectId, user);
    if ((await milestones.count({ ownerId: user.id, projectId: p.id })) >= LIMITS.milestonesPerProject) throw conflict(`A project can have at most ${LIMITS.milestonesPerProject} milestones`, 'limit');
    const doc = { description: '', dueDate: null, completed: false, ...input };
    return strip(await milestones.insert({ id: newId('mst'), ownerId: user.id, schemaVersion: SCHEMA_VERSION, projectId: p.id, completedAt: doc.completed ? nowIso() : null, ...doc }));
  }
  async function updateMilestone(user, id, patch) {
    const m = await ownMilestone(id, user), p = { ...patch };
    if ('completed' in p) p.completedAt = p.completed ? (m.completedAt || nowIso()) : null;
    return strip(await milestones.update(m.id, p));
  }
  async function deleteMilestone(user, id) {
    const m = await ownMilestone(id, user);
    await s.storage.transaction(async () => {
      for (const t of await tasks.find({ where: { ownerId: user.id, milestoneId: m.id }, limit: 20000 })) await tasks.update(t.id, { milestoneId: null });
      await milestones.delete(m.id);
    });
    return { ok: true };
  }

  // ---- Tasks ----
  async function createTask(user, input) {
    if ((await tasks.count({ ownerId: user.id })) >= LIMITS.tasks) throw conflict(`You can have at most ${LIMITS.tasks} tasks`, 'limit');
    const doc = cleanDoc({ ...taskDefaults(), ...input, ownerId: user.id });
    if (doc.milestoneId && !doc.projectId) { const m = await ownMilestone(doc.milestoneId, user); doc.projectId = m.projectId; }
    await checkRefs(user, doc, null);
    doc.subtasks = withIds(doc.subtasks);
    if (doc.recurrence) doc.recurrence = { ...doc.recurrence, anchor: doc.dueDate };
    const done = doc.status === 'done';
    if (done && doc.recurrence) throw badRequest('Create a repeating task as open, then complete it');
    const t = await tasks.insert({ id: newId('tsk'), schemaVersion: SCHEMA_VERSION, seriesId: null, spawnedNextId: null, completedAt: done ? nowIso() : null, ...doc });
    return getTask(user, t.id);
  }

  // Marks a task done and, for a repeating task, creates the next copy. Runs inside the caller's transaction.
  async function finish(user, t, todayStr) {
    const openDeps = (t.dependsOn || []).length ? (await Promise.all(t.dependsOn.map((id) => tasks.get(id)))).filter((d) => d && d.ownerId === user.id && d.status !== 'done') : [];
    if (openDeps.length) throw conflict(`Finish these first: ${openDeps.map((d) => d.title).join(', ')}`, 'dependency_open');
    const patch = { status: 'done', completedAt: nowIso() };
    let next = null;
    if (t.recurrence && t.dueDate && !t.spawnedNextId) {
      const due = nextOccurrence(t.recurrence, t.dueDate, todayStr);
      if (due) {
        const shift = t.startDate ? diffDays(t.dueDate, due) : 0;
        const { createdAt, updatedAt, ...base } = t;
        next = await tasks.insert({ ...base, id: newId('tsk'), status: 'todo', completedAt: null, spawnedNextId: null, seriesId: t.seriesId || t.id, dueDate: due,
          startDate: t.startDate ? addDays(t.startDate, shift) : null, subtasks: (t.subtasks || []).map((x) => ({ ...x, id: newId('sub'), done: false })), dependsOn: [], archived: false,
          recurrence: { ...t.recurrence, remaining: t.recurrence.remaining != null ? t.recurrence.remaining - 1 : null } });
        patch.spawnedNextId = next.id;
      }
    }
    await tasks.update(t.id, patch);
    return next;
  }

  async function updateTask(user, id, input) {
    const t = await ownTask(id, user), ctx = await context(user), todayStr = ctx.today;
    const patch = cleanDoc({ ...input, ownerId: user.id });
    if (!('assignedToMe' in input)) delete patch.assigneeId;
    delete patch.ownerId;
    if ('projectId' in patch && patch.projectId !== t.projectId && !('milestoneId' in patch)) patch.milestoneId = null; // moving projects drops the old milestone
    const merged = { ...t, ...patch };
    await checkRefs(user, merged, t.id, ctx); // checks ownership first, then that the milestone belongs to the task's project
    if ('subtasks' in patch) patch.subtasks = withIds(patch.subtasks);
    if (merged.recurrence && ('recurrence' in patch || 'dueDate' in patch)) patch.recurrence = { ...merged.recurrence, anchor: merged.dueDate };
    if (t.status === 'done' && merged.recurrence && 'dueDate' in input) throw badRequest('Reopen the task before changing the due date of a repeating task');
    let next = null;
    await s.storage.transaction(async () => {
      if (patch.status === 'done' && t.status !== 'done') {
        const { status, ...rest } = patch;
        if (Object.keys(rest).length) await tasks.update(t.id, rest);
        next = await finish(user, { ...t, ...rest }, todayStr);
      } else {
        if (patch.status && patch.status !== 'done' && t.status === 'done') patch.completedAt = null;
        if (Object.keys(patch).length) await tasks.update(t.id, patch);
      }
    });
    return { ...(await getTask(user, t.id)), next: next ? await getTask(user, next.id) : null };
  }
  async function deleteTask(user, id) {
    const t = await ownTask(id, user);
    await s.storage.transaction(async () => {
      for (const x of await tasks.find({ where: { ownerId: user.id }, limit: 20000 })) if ((x.dependsOn || []).includes(t.id)) await tasks.update(x.id, { dependsOn: x.dependsOn.filter((d) => d !== t.id) });
      await tasks.delete(t.id);
    });
    return { ok: true };
  }

  return { cols, getSettings, saveSettings, today, ownProject, ownTask, ownMilestone, listProjects, getProject, createProject, updateProject, deleteProject,
    createMilestone, updateMilestone, deleteMilestone, notifications, streak, listEvents, getEvent, createEvent, updateEvent, deleteEvent, listTasks, getTask, createTask, updateTask, deleteTask, overview, calendar, context, liveTasks, progressOf, strip };
}
