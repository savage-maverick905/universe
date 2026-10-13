import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, closeAll } from './helpers.js';
import { nextOccurrence, addMonths, isDate, todayIn } from '../apps/nova/server/dates.js';
after(closeAll);

const B = '/api/apps/nova';
const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const text = (content) => ({ content, toolCalls: [], usage });
const toolCall = (name, args, id = 'c1') => ({ content: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }], usage: null });

async function setup(script = () => text('ok')) {
  const calls = [], provider = { id: 'fake', calls, async chat(req) { calls.push(structuredClone(req)); return script(req, calls.length); } };
  const t = await startTestApp({}, { providers: { fake: provider } });
  const admin = await t.login('admin@example.com', 'correct-horse-battery');
  const mk = async (email, roleId = 'resident') => {
    await t.request('POST', '/api/users', { cookie: admin.cookie, body: { email, displayName: email, password: 'a-decent-password', roleId } });
    return t.login(email, 'a-decent-password');
  };
  const before = await mk('early@example.com');
  assert.equal((await t.request('GET', `${B}/overview`, { cookie: before.cookie })).status, 404); // not installed yet
  assert.equal((await t.request('POST', '/api/apps/nova/install', { cookie: admin.cookie })).status, 200);
  const a = await mk('a@example.com'), b = await mk('b@example.com'), g = await mk('g@example.com', 'guest');
  const as = (u) => (method, path, body) => t.request(method, `${B}${path}`, { cookie: u.cookie, body });
  return { t, admin, provider, a, b, g, A: as(a), Bq: as(b), G: as(g), mk, as };
}

test('recurrence maths: daily, weekly, monthly clamping, yearly, limits', () => {
  assert.equal(nextOccurrence({ freq: 'daily', interval: 1 }, '2026-10-12', '2026-10-12'), '2026-10-13');
  assert.equal(nextOccurrence({ freq: 'daily', interval: 3, anchor: '2026-10-01' }, '2026-10-10', '2026-10-10'), '2026-10-13');
  assert.equal(nextOccurrence({ freq: 'daily', interval: 1 }, '2026-10-01', '2026-10-12'), '2026-10-12'); // late: no pile of overdue copies
  // 2026-10-12 is a Monday
  assert.equal(nextOccurrence({ freq: 'weekly', interval: 1, byDay: [1, 3], anchor: '2026-10-12' }, '2026-10-12', '2026-10-12'), '2026-10-14');
  assert.equal(nextOccurrence({ freq: 'weekly', interval: 1, byDay: [1, 3], anchor: '2026-10-12' }, '2026-10-14', '2026-10-14'), '2026-10-19');
  assert.equal(nextOccurrence({ freq: 'weekly', interval: 2, byDay: [], anchor: '2026-10-12' }, '2026-10-12', '2026-10-12'), '2026-10-26');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(nextOccurrence({ freq: 'monthly', interval: 1, anchor: '2026-01-31' }, '2026-02-28', '2026-02-28'), '2026-03-31'); // keeps the 31st
  assert.equal(nextOccurrence({ freq: 'yearly', interval: 1, anchor: '2028-02-29' }, '2028-02-29', '2028-02-29'), '2029-02-28');
  assert.equal(nextOccurrence({ freq: 'daily', interval: 1, until: '2026-10-12' }, '2026-10-12', '2026-10-12'), null);
  assert.equal(nextOccurrence({ freq: 'daily', interval: 1, remaining: 0 }, '2026-10-12', '2026-10-12'), null);
  assert.ok(isDate('2026-02-28') && !isDate('2026-02-30') && !isDate('2026-2-3') && !isDate(20261012));
  assert.match(todayIn('Africa/Lagos'), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(todayIn('Not/AZone'), todayIn('UTC'));
});

test('access: guests are refused, other people see nothing, unknown fields are rejected', async () => {
  const { A, Bq, G, t } = await setup();
  assert.equal((await G('GET', '/tasks')).status, 403);
  assert.equal((await G('POST', '/tasks', { title: 'x' })).status, 403);
  assert.equal((await t.request('GET', `${B}/tasks`)).status, 401);
  const p = (await A('POST', '/projects', { name: 'Launch' })).json.project;
  const task = (await A('POST', '/tasks', { title: 'Write copy', projectId: p.id })).json.task;
  const ms = (await A('POST', `/projects/${p.id}/milestones`, { title: 'Beta' })).json.milestone;
  // user B: every id of A's looks non-existent
  for (const [m, path, body] of [['GET', `/tasks/${task.id}`], ['PATCH', `/tasks/${task.id}`, { title: 'hacked' }], ['DELETE', `/tasks/${task.id}`], ['POST', `/tasks/${task.id}/complete`],
    ['GET', `/projects/${p.id}`], ['PATCH', `/projects/${p.id}`, { name: 'x' }], ['DELETE', `/projects/${p.id}?confirm=true`], ['PATCH', `/milestones/${ms.id}`, { title: 'x' }],
    ['DELETE', `/milestones/${ms.id}`], ['POST', `/projects/${p.id}/milestones`, { title: 'x' }]]) assert.equal((await Bq(m, path, body)).status, 404, `${m} ${path}`);
  assert.deepEqual((await Bq('GET', '/tasks')).json.tasks, []);
  assert.deepEqual((await Bq('GET', '/projects')).json.projects, []);
  // B cannot attach their task to A's project, milestone or task
  assert.equal((await Bq('POST', '/tasks', { title: 'sneaky', projectId: p.id })).status, 404);
  const bt = (await Bq('POST', '/tasks', { title: 'mine' })).json.task;
  assert.equal((await Bq('PATCH', `/tasks/${bt.id}`, { milestoneId: ms.id })).status, 404);
  assert.equal((await Bq('PATCH', `/tasks/${bt.id}`, { dependsOn: [task.id] })).status, 400);
  // identity cannot be smuggled in
  for (const bad of [{ title: 'x', ownerId: 'someone' }, { title: 'x', id: 'abc' }, { title: 'x', completedAt: '2020-01-01' }, { title: 'x', assigneeId: 'u' }]) assert.equal((await A('POST', '/tasks', bad)).status, 400);
  assert.equal((await A('POST', '/projects', { name: 'x', ownerId: 'u' })).status, 400);
  // the records themselves never expose the owner
  assert.ok(!('ownerId' in task));
  // A still has their data intact
  assert.equal((await A('GET', `/tasks/${task.id}`)).json.task.title, 'Write copy');
});

test('projects and tasks: create, edit, validate, filter, sort, archive, delete', async () => {
  const { A } = await setup();
  assert.equal((await A('POST', '/projects', {})).status, 400);
  assert.equal((await A('POST', '/projects', { name: '  ' })).status, 400);
  assert.equal((await A('POST', '/projects', { name: 'x', color: 'red' })).status, 400);
  assert.equal((await A('POST', '/projects', { name: 'x', startDate: '2026-10-10', deadline: '2026-10-01' })).status, 400);
  const p = (await A('POST', '/projects', { name: 'Website', description: 'New site', icon: 'folder', color: '#ed6627', priority: 'high', deadline: '2026-12-01', tags: ['Web', 'web', 'client'] })).json.project;
  assert.equal(p.color, '#ED6627'); assert.deepEqual(p.tags, ['web', 'client']); assert.equal(p.status, 'active'); assert.equal(p.progress.total, 0);
  const t1 = (await A('POST', '/tasks', { title: 'Design', projectId: p.id, priority: 'high', dueDate: '2026-10-20', tags: ['ui'] })).json.task;
  const t2 = (await A('POST', '/tasks', { title: 'Build', projectId: p.id, dueDate: '2026-10-05' })).json.task;
  const t3 = (await A('POST', '/tasks', { title: 'Call mum', priority: 'low' })).json.task;
  assert.equal(t1.status, 'todo'); assert.equal(t1.projectName, 'Website'); assert.ok(t1.assigneeId);
  for (const bad of [{ title: '' }, { title: 'x', status: 'nope' }, { title: 'x', priority: 'huge' }, { title: 'x', dueDate: '2026-02-30' }, { title: 'x', dueDate: 'tomorrow' }, { title: 'x', startDate: '2026-10-10', dueDate: '2026-10-01' },
    { title: 'x', tags: 'a' }, { title: 'x', subtasks: [{ title: '' }] }, { title: 'x', projectId: 'prj_missing' }, { title: 'x'.repeat(201) }, { title: 'x', dependsOn: ['tsk_nope'] }]) {
    const r = await A('POST', '/tasks', bad); assert.ok([400, 404].includes(r.status), JSON.stringify(bad));
  }
  assert.equal((await A('GET', '/tasks?sort=dueDate')).json.tasks.map((x) => x.title)[0], 'Build');
  assert.deepEqual((await A('GET', '/tasks?sort=priority')).json.tasks.map((x) => x.title), ['Design', 'Build', 'Call mum']);
  assert.deepEqual((await A('GET', `/tasks?project=${p.id}`)).json.tasks.map((x) => x.title).sort(), ['Build', 'Design']);
  assert.deepEqual((await A('GET', '/tasks?project=none')).json.tasks.map((x) => x.title), ['Call mum']);
  assert.deepEqual((await A('GET', '/tasks?q=desi')).json.tasks.map((x) => x.title), ['Design']);
  assert.deepEqual((await A('GET', '/tasks?tag=ui')).json.tasks.map((x) => x.title), ['Design']);
  assert.equal((await A('GET', '/tasks?status=bogus')).status, 400);
  assert.equal((await A('GET', '/tasks?limit=0')).status, 400);
  // edit, subtasks get ids and counts, notes
  const up = (await A('PATCH', `/tasks/${t1.id}`, { title: 'Design v2', notes: 'see figma', subtasks: [{ title: 'wireframe', done: true }, { title: 'colors' }], status: 'in_progress' })).json.task;
  assert.equal(up.title, 'Design v2'); assert.deepEqual(up.subtaskCounts, { total: 2, done: 1 }); assert.ok(up.subtasks.every((x) => x.id)); assert.equal(up.status, 'in_progress');
  assert.equal((await A('PATCH', `/tasks/${t1.id}`, { projectId: null })).json.task.projectName, null);
  // archive hides from the default list, shows with archived=true
  await A('PATCH', `/tasks/${t3.id}`, { archived: true });
  assert.ok(!(await A('GET', '/tasks')).json.tasks.some((x) => x.id === t3.id));
  assert.deepEqual((await A('GET', '/tasks?archived=true')).json.tasks.map((x) => x.id), [t3.id]);
  assert.equal((await A('DELETE', `/tasks/${t3.id}`)).status, 200);
  assert.equal((await A('GET', `/tasks/${t3.id}`)).status, 404);
  // deleting a project needs explicit confirmation and removes its tasks and milestones
  await A('PATCH', `/tasks/${t1.id}`, { projectId: p.id });
  const m = (await A('POST', `/projects/${p.id}/milestones`, { title: 'Launch day', dueDate: '2026-11-30' })).json.milestone;
  const d0 = await A('DELETE', `/projects/${p.id}`); assert.equal(d0.status, 400); assert.equal(d0.json.error.code, 'confirm_required');
  assert.equal((await A('GET', `/projects/${p.id}`)).status, 200);
  const d1 = await A('DELETE', `/projects/${p.id}?confirm=true`); assert.equal(d1.status, 200); assert.equal(d1.json.tasksRemoved, 2);
  assert.equal((await A('GET', `/tasks/${t2.id}`)).status, 404); assert.equal((await A('GET', `/projects/${p.id}`)).status, 404); assert.equal((await A('PATCH', `/milestones/${m.id}`, { title: 'x' })).status, 404);
});

test('status changes, completion time, progress and milestones', async () => {
  const { A } = await setup();
  const p = (await A('POST', '/projects', { name: 'Plan' })).json.project;
  const m = (await A('POST', `/projects/${p.id}/milestones`, { title: 'Phase 1', dueDate: '2026-11-01' })).json.milestone;
  const mk = async (title, extra = {}) => (await A('POST', '/tasks', { title, projectId: p.id, ...extra })).json.task;
  const t1 = await mk('One', { milestoneId: m.id }), t2 = await mk('Two', { milestoneId: m.id }), t3 = await mk('Three'), t4 = await mk('Four');
  assert.equal((await A('GET', `/projects/${p.id}`)).json.project.progress.percent, 0);
  const done = (await A('PATCH', `/tasks/${t1.id}`, { status: 'done' })).json.task;
  assert.equal(done.status, 'done'); assert.ok(done.completedAt);
  let pr = (await A('GET', `/projects/${p.id}`)).json.project;
  assert.deepEqual([pr.progress.done, pr.progress.total, pr.progress.percent], [1, 4, 25]);
  assert.equal(pr.milestones[0].progress.percent, 50);
  assert.equal((await A('POST', `/tasks/${t1.id}/reopen`)).json.task.completedAt, null);
  assert.equal((await A('POST', `/tasks/${t2.id}/complete`)).json.task.status, 'done');
  await A('POST', `/tasks/${t3.id}/complete`); await A('PATCH', `/tasks/${t4.id}`, { archived: true }); // archived tasks do not count
  pr = (await A('GET', `/projects/${p.id}`)).json.project;
  assert.deepEqual([pr.progress.done, pr.progress.total, pr.progress.percent], [2, 3, 67]);
  // milestone must belong to the task's project; milestone can be completed and removed
  const other = (await A('POST', '/projects', { name: 'Other' })).json.project;
  assert.equal((await A('PATCH', `/tasks/${t4.id}`, { projectId: other.id, milestoneId: m.id })).status, 400);
  assert.equal((await A('PATCH', `/tasks/${t4.id}`, { projectId: other.id })).json.task.milestoneId, null);
  assert.equal((await A('PATCH', `/milestones/${m.id}`, { completed: true })).json.milestone.completed, true);
  assert.equal((await A('DELETE', `/milestones/${m.id}`)).status, 200);
  assert.equal((await A('GET', `/tasks/${t2.id}`)).json.task.milestoneId, null);
  // a project with no tasks shows 0% without dividing by zero
  const empty = (await A('POST', '/projects', { name: 'Empty' })).json.project;
  assert.deepEqual([empty.progress.total, empty.progress.percent], [0, 0]);
});

test('dependencies: no self, no loops, cannot finish early, removed with the task', async () => {
  const { A } = await setup();
  const a = (await A('POST', '/tasks', { title: 'A' })).json.task, b = (await A('POST', '/tasks', { title: 'B', dependsOn: [a.id] })).json.task;
  assert.equal(b.waitingOn, 1);
  assert.equal((await A('PATCH', `/tasks/${a.id}`, { dependsOn: [a.id] })).status, 400);
  assert.equal((await A('PATCH', `/tasks/${a.id}`, { dependsOn: [b.id] })).status, 400); // loop
  const early = await A('POST', `/tasks/${b.id}/complete`); assert.equal(early.status, 409); assert.equal(early.json.error.code, 'dependency_open');
  await A('POST', `/tasks/${a.id}/complete`);
  assert.equal((await A('GET', `/tasks/${b.id}`)).json.task.waitingOn, 0);
  assert.equal((await A('POST', `/tasks/${b.id}/complete`)).status, 200);
  const c = (await A('POST', '/tasks', { title: 'C' })).json.task, d = (await A('POST', '/tasks', { title: 'D', dependsOn: [c.id] })).json.task;
  await A('DELETE', `/tasks/${c.id}`);
  assert.deepEqual((await A('GET', `/tasks/${d.id}`)).json.task.dependsOn, []);
});

test('recurring tasks: completing makes the next one, once, with limits', async () => {
  const { A } = await setup();
  assert.equal((await A('POST', '/tasks', { title: 'x', recurrence: { freq: 'daily' } })).status, 400); // needs a due date
  assert.equal((await A('POST', '/tasks', { title: 'x', dueDate: '2030-01-01', recurrence: { freq: 'hourly' } })).status, 400);
  assert.equal((await A('POST', '/tasks', { title: 'x', dueDate: '2030-01-01', recurrence: { freq: 'daily', interval: 0 } })).status, 400);
  assert.equal((await A('POST', '/tasks', { title: 'x', dueDate: '2030-01-01', recurrence: { freq: 'daily', until: '2030-02-01', count: 3 } })).status, 400);
  assert.equal((await A('POST', '/tasks', { title: 'x', dueDate: '2030-01-01', recurrence: { freq: 'daily', byDay: [1] } })).status, 400);
  const t = (await A('POST', '/tasks', { title: 'Water plants', dueDate: '2030-01-07', startDate: '2030-01-06', recurrence: { freq: 'weekly', byDay: [1, 4], count: 3 }, subtasks: [{ title: 'kitchen' }] })).json.task; // 2030-01-07 is a Monday
  const r = await A('POST', `/tasks/${t.id}/complete`); assert.equal(r.status, 200);
  assert.equal(r.json.task.status, 'done'); assert.equal(r.json.next.dueDate, '2030-01-10'); assert.equal(r.json.next.startDate, '2030-01-09');
  assert.equal(r.json.next.status, 'todo'); assert.equal(r.json.next.seriesId, t.id); assert.equal(r.json.next.recurrence.remaining, 1); assert.equal(r.json.next.subtasks[0].done, false);
  assert.notEqual(r.json.next.subtasks[0].id, t.subtasks[0].id);
  // completing it twice, or reopening and completing again, never creates a second copy
  assert.equal((await A('POST', `/tasks/${t.id}/complete`)).json.next, null);
  await A('POST', `/tasks/${t.id}/reopen`);
  assert.equal((await A('POST', `/tasks/${t.id}/complete`)).json.next, null);
  assert.equal((await A('GET', '/tasks?q=water')).json.total, 2);
  const r2 = (await A('POST', `/tasks/${r.json.next.id}/complete`)).json; assert.equal(r2.next.dueDate, '2030-01-14'); assert.equal(r2.next.recurrence.remaining, 0);
  assert.equal((await A('POST', `/tasks/${r2.next.id}/complete`)).json.next, null); // 3 occurrences in total, then it stops
  // routines do not distort project progress
  const p = (await A('POST', '/projects', { name: 'Home' })).json.project;
  await A('POST', '/tasks', { title: 'Weekly review', projectId: p.id, dueDate: '2030-03-01', recurrence: { freq: 'weekly' } });
  const once = (await A('POST', '/tasks', { title: 'Paint', projectId: p.id })).json.task; await A('POST', `/tasks/${once.id}/complete`);
  assert.equal((await A('GET', `/projects/${p.id}`)).json.project.progress.percent, 100);
  // changing the due date moves the series anchor; a done repeating task must be reopened first
  const m = (await A('POST', '/tasks', { title: 'Rent', dueDate: '2030-01-31', recurrence: { freq: 'monthly' } })).json.task;
  assert.equal((await A('POST', `/tasks/${m.id}/complete`)).json.next.dueDate, '2030-02-28');
  assert.equal((await A('PATCH', `/tasks/${m.id}`, { dueDate: '2030-01-30' })).status, 400);
});

test('overview, calendar, settings and time zones', async () => {
  const { A, Bq } = await setup();
  assert.equal((await A('GET', '/overview')).json.counts.open, 0);
  assert.equal((await A('PUT', '/settings', { timezone: 'Mars/Base' })).status, 400);
  assert.equal((await A('PUT', '/settings', { timezone: 'Pacific/Kiritimati', extra: 1 })).status, 400);
  const s = (await A('PUT', '/settings', { timezone: 'Pacific/Kiritimati' })).json.settings; assert.equal(s.timezone, 'Pacific/Kiritimati');
  const today = (await A('GET', '/overview')).json.today; assert.equal(today, todayIn('Pacific/Kiritimati'));
  assert.equal((await Bq('GET', '/settings')).json.settings.timezone, 'UTC'); // per person
  const d = (n) => { const x = new Date(`${today}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const p = (await A('POST', '/projects', { name: 'P', deadline: d(5) })).json.project;
  await A('POST', '/tasks', { title: 'late', dueDate: d(-2), projectId: p.id }); await A('POST', '/tasks', { title: 'now', dueDate: today }); await A('POST', '/tasks', { title: 'soon', dueDate: d(3) });
  await A('POST', '/tasks', { title: 'far', dueDate: d(30) }); await A('POST', '/tasks', { title: 'stuck', status: 'blocked' });
  const finished = (await A('POST', '/tasks', { title: 'finished', dueDate: d(-5) })).json.task; await A('POST', `/tasks/${finished.id}/complete`);
  const o = (await A('GET', '/overview')).json;
  assert.deepEqual(o.overdue.map((t) => t.title), ['late']); assert.equal(o.overdue[0].overdue, true);
  assert.deepEqual(o.dueToday.map((t) => t.title), ['now']); assert.deepEqual(o.dueSoon.map((t) => t.title), ['soon']); assert.deepEqual(o.blocked.map((t) => t.title), ['stuck']);
  assert.equal(o.counts.open, 5); assert.equal(o.counts.overdue, 1); assert.equal(o.counts.doneLast7Days, 1);
  assert.equal((await A('GET', '/tasks?due=overdue')).json.tasks.length, 1);
  const cal = (await A('GET', `/calendar?from=${d(-6)}&to=${d(7)}`)).json;
  assert.deepEqual(cal.tasks.map((t) => t.title).sort(), ['finished', 'late', 'now', 'soon']); assert.equal(cal.deadlines.length, 1);
  assert.equal((await A('GET', `/calendar?from=${d(0)}&to=${d(100)}`)).status, 400);
  assert.equal((await A('GET', '/calendar?from=nope')).status, 400);
  // archiving a project takes its tasks out of "needs attention"
  await A('PATCH', `/projects/${p.id}`, { archived: true });
  assert.equal((await A('GET', '/overview')).json.counts.overdue, 0);
  assert.equal((await A('GET', '/projects')).json.projects.length, 0); assert.equal((await A('GET', '/projects?archived=true')).json.projects.length, 1);
  assert.equal((await Bq('GET', '/overview')).json.counts.open, 0);
});

test('widgets, report, limits and batch create', async () => {
  const { A, a, t, mk } = await setup();
  const p = (await A('POST', '/projects', { name: 'Big' })).json.project;
  const batch = await A('POST', '/tasks/batch', { projectId: p.id, tasks: [{ title: 'a' }, { title: 'b', priority: 'high' }] }); assert.equal(batch.status, 201); assert.equal(batch.json.tasks.length, 2);
  const failing = await A('POST', '/tasks/batch', { projectId: p.id, tasks: [{ title: 'ok' }, { title: '' }] }); assert.equal(failing.status, 400);
  assert.equal((await A('GET', `/tasks?project=${p.id}`)).json.total, 2); // all or nothing
  assert.equal((await A('POST', '/tasks/batch', { projectId: p.id, tasks: [] })).status, 400);
  assert.equal((await A('POST', '/tasks/batch', { projectId: 'prj_missing', tasks: [{ title: 'x' }] })).status, 404);
  const w = await A('GET', '/widget/summary'); assert.deepEqual(w.json.stats.map((x) => x.label), ['Open tasks', 'Overdue', 'Due this week', 'Projects']); assert.equal(w.json.stats[0].value, 2);
  assert.ok((await t.request('GET', '/api/dashboard/widgets', { cookie: a.cookie })).json.widgets.some((x) => x.appId === 'nova' || String(x.id).includes('nova')));
  const rep = await t.request('POST', '/api/reports/run', { cookie: a.cookie, body: { app: 'nova', period: 'weekly' } });
  assert.equal(rep.status, 200, rep.text); assert.ok(rep.text.includes('Open tasks'));
  // a person with only read access cannot write
  const admin = await t.login('admin@example.com', 'correct-horse-battery');
  const ro = await t.request('POST', '/api/users', { cookie: admin.cookie, body: { email: 'ro@example.com', displayName: 'ro', password: 'a-decent-password', roleId: 'guest' } });
  assert.equal(ro.status, 201, ro.text);
  const patched = await t.request('PATCH', `/api/users/${ro.json.user.id}`, { cookie: admin.cookie, body: { grants: ['nova.task.read', 'nova.project.read'] } }); assert.equal(patched.status, 200, patched.text);
  const r = await t.login('ro@example.com', 'a-decent-password'), RO = (m, path, body) => t.request(m, `${B}${path}`, { cookie: r.cookie, body });
  assert.equal((await RO('GET', '/tasks')).status, 200); assert.equal((await RO('POST', '/tasks', { title: 'x' })).status, 403);
  assert.equal((await RO('POST', '/projects', { name: 'x' })).status, 403); assert.equal((await RO('GET', '/widget/summary')).status, 403);
  assert.equal((await RO('PUT', '/settings', { timezone: 'UTC' })).status, 403);
  // disabling the app hides everything
  await t.request('POST', '/api/apps/nova/disable', { cookie: admin.cookie });
  assert.equal((await A('GET', '/tasks')).status, 404);
  await t.request('POST', '/api/apps/nova/enable', { cookie: admin.cookie });
  assert.equal((await A('GET', '/tasks')).json.total, 2);
});

test('assistant: read tools answer from the caller\'s data only; changes are drafts until confirmed', async () => {
  let script = () => text('ok');
  const { A, Bq, a, b, t, provider, mk } = await setup((req, n) => script(req, n));
  const p = (await A('POST', '/projects', { name: 'Garden' })).json.project;
  const task = (await A('POST', '/tasks', { title: 'Buy seeds', projectId: p.id, dueDate: '2020-01-01' })).json.task;
  await Bq('POST', '/tasks', { title: 'B-private-task', dueDate: '2020-01-01' });
  const chat = (u, message, conversationId) => t.request('POST', '/api/ai/chat', { cookie: u.cookie, body: { message, ...(conversationId ? { conversationId } : {}) } });
  // read tool
  script = (req) => (req.messages.some((m) => m.role === 'tool') ? text('You have one overdue task.') : toolCall('nova.overview', {}));
  let r = await chat(a, 'what is overdue?'); assert.equal(r.status, 200, r.text);
  const toolMsg = provider.calls.at(-1).messages.find((m) => m.role === 'tool').content;
  assert.ok(toolMsg.includes('Buy seeds') && !toolMsg.includes('B-private-task'));
  assert.ok(provider.calls[0].messages[0].content.includes('NOVA')); // guidance reaches the model
  // someone without Nova permissions is not even offered the tools
  const admin0 = await t.login('admin@example.com', 'correct-horse-battery'); await mk('d@example.com');
  const dUser = (await t.request('GET', '/api/users', { cookie: admin0.cookie })).json.users.find((u) => u.email === 'd@example.com');
  assert.equal((await t.request('PATCH', `/api/users/${dUser.id}`, { cookie: admin0.cookie, body: { denies: ['nova.task.read', 'nova.project.read', 'nova.ai.use'] } })).status, 200);
  const b2 = await t.login('d@example.com', 'a-decent-password');
  provider.calls.length = 0; script = () => text('hi'); await chat(b2, 'hello');
  assert.ok(!(provider.calls[0].tools || []).some((x) => x.name.startsWith('nova.')));
  assert.ok(provider.calls[0].tools.some((x) => x.name === 'reports.generate')); // ...but still gets the tools it may use
  // propose: nothing is saved yet
  script = (req) => (req.messages.some((m) => m.role === 'tool') ? text('unused') : toolCall('nova.propose', { action: 'create_task', title: 'Water the beds', project: 'Garden', dueDate: '2030-05-01', priority: 'high' }));
  r = await chat(a, 'add a task to water the beds in Garden by May 1st'); assert.equal(r.status, 200, r.text);
  assert.match(r.json.reply.content, /nothing is saved yet/i); assert.match(r.json.reply.content, /Water the beds/);
  assert.equal((await A('GET', '/tasks?q=water')).json.total, 0);
  const convId = r.json.conversation.id;
  const pend = (await A('GET', `/proposals?conversationId=${convId}`)).json.proposals; assert.equal(pend.length, 1);
  assert.ok(!JSON.stringify(pend).includes('ownerId'));
  // other people cannot see, confirm or dismiss it
  assert.deepEqual((await Bq('GET', '/proposals')).json.proposals, []);
  assert.equal((await Bq('POST', `/proposals/${pend[0].id}/confirm`)).status, 404); assert.equal((await Bq('POST', `/proposals/${pend[0].id}/dismiss`)).status, 404);
  // confirm applies it exactly once
  const ok = await A('POST', `/proposals/${pend[0].id}/confirm`); assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.result.task.projectName, 'Garden'); assert.equal(ok.json.result.task.priority, 'high');
  assert.equal((await A('POST', `/proposals/${pend[0].id}/confirm`)).status, 409);
  assert.equal((await A('GET', '/tasks?q=water')).json.total, 1);
  assert.deepEqual((await A('GET', '/proposals')).json.proposals, []);
  // update + complete proposals, unknown ids and bad input are refused at propose time
  script = (req) => (req.messages.some((m) => m.role === 'tool') ? text('unused') : toolCall('nova.propose', { action: 'complete_task', taskId: task.id }));
  await chat(a, 'I bought the seeds'); const p2 = (await A('GET', '/proposals')).json.proposals[0]; assert.equal(p2.action, 'complete_task');
  assert.equal((await A('GET', `/tasks/${task.id}`)).json.task.status, 'todo');
  await A('POST', `/proposals/${p2.id}/dismiss`); assert.equal((await A('POST', `/proposals/${p2.id}/confirm`)).status, 409);
  script = (req) => (req.messages.some((m) => m.role === 'tool') ? text('could not') : toolCall('nova.propose', { action: 'update_task', taskId: task.id, dueDate: '2030-13-45' }));
  await chat(a, 'move it'); assert.deepEqual((await A('GET', '/proposals')).json.proposals, []);
  const tool = () => provider.calls.at(-1).messages.filter((m) => m.role === 'tool').at(-1).content;
  assert.match(tool(), /error/);
  const bTaskId = (await Bq('GET', '/tasks')).json.tasks[0].id;
  script = (req) => (req.messages.some((m) => m.role === 'tool') ? text('no') : toolCall('nova.propose', { action: 'update_task', taskId: bTaskId, title: 'hijack' }));
  await chat(a, 'rename'); assert.deepEqual((await A('GET', '/proposals')).json.proposals, []);
  assert.equal((await Bq('GET', `/tasks/${bTaskId}`)).json.task.title, 'B-private-task');
  // create a project by proposal
  script = (req) => (req.messages.some((m) => m.role === 'tool') ? text('x') : toolCall('nova.propose', { action: 'create_project', name: 'Trip', deadline: '2030-08-01' }));
  await chat(a, 'start a project called Trip'); const p3 = (await A('GET', '/proposals')).json.proposals[0];
  assert.equal((await A('POST', `/proposals/${p3.id}/confirm`)).status, 200); assert.ok((await A('GET', '/projects')).json.projects.some((x) => x.name === 'Trip'));
  // a proposal made while a person had write access cannot be confirmed after it is taken away
  script = (req) => (req.messages.some((m) => m.role === 'tool') ? text('x') : toolCall('nova.propose', { action: 'create_task', title: 'Late change' }));
  await chat(a, 'add late change'); const p4 = (await A('GET', '/proposals')).json.proposals[0];
  const admin = await t.login('admin@example.com', 'correct-horse-battery'); const me = (await t.request('GET', '/api/users', { cookie: admin.cookie })).json.users.find((u) => u.email === 'a@example.com');
  assert.equal((await t.request('PATCH', `/api/users/${me.id}`, { cookie: admin.cookie, body: { denies: ['nova.task.write'] } })).status, 200);
  const a2 = await t.login('a@example.com', 'a-decent-password');
  assert.equal((await t.request('POST', `${B}/proposals/${p4.id}/confirm`, { cookie: a2.cookie })).status, 403);
  assert.ok(b);
});

test('in-app AI: drafting, breakdown and summary are proposals, validated, and fail gracefully', async () => {
  let reply = '{}';
  const { A, Bq, g, G, provider } = await setup(() => text(reply));
  const p = (await A('POST', '/projects', { name: 'Garden', deadline: '2030-06-01' })).json.project;
  await A('POST', '/tasks', { title: 'Buy seeds', projectId: p.id });
  reply = `Sure! {"title":"Call the plumber","description":"about the leak","priority":"urgent","dueDate":"2030-02-03","projectId":"${p.id}","tags":["Home","home","urgent"],"ownerId":"evil"}`;
  let r = await A('POST', '/ai/draft-task', { text: 'call the plumber about the leak on 3 Feb' }); assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.draft, { title: 'Call the plumber', description: 'about the leak', priority: 'urgent', dueDate: '2030-02-03', projectId: p.id, tags: ['home', 'urgent'] });
  assert.equal((await A('GET', '/tasks?q=plumber')).json.total, 0); // a draft saves nothing
  assert.ok(provider.calls.at(-1).messages[0].content.includes('Garden'));
  assert.equal(provider.calls.at(-1).messages[1].content, 'call the plumber about the leak on 3 Feb'); // user text stays in the user message
  reply = '{"title":"X","projectId":"someone-elses","priority":"extreme","dueDate":"31/12/2030"}';
  r = await A('POST', '/ai/draft-task', { text: 'something' }); assert.deepEqual(r.json.draft, { title: 'X', description: '', priority: 'medium', dueDate: null, projectId: null, tags: [] });
  reply = 'I cannot do that'; r = await A('POST', '/ai/draft-task', { text: 'something' }); assert.equal(r.status, 502); assert.equal(r.json.error.code, 'ai_bad_output');
  assert.equal((await A('POST', '/ai/draft-task', { text: '' })).status, 400); assert.equal((await A('POST', '/ai/draft-task', { text: 'hello', extra: 1 })).status, 400);
  // breakdown: skips duplicates and dates past the deadline
  reply = '{"tasks":[{"title":"buy seeds"},{"title":"Dig beds","priority":"high","dueDate":"2030-05-01"},{"title":"Water","dueDate":"2031-01-01"},{"title":""}]}';
  r = await A('POST', '/ai/breakdown', { projectId: p.id, goal: 'tomatoes' }); assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.suggestions.map((x) => [x.title, x.dueDate]), [['Dig beds', '2030-05-01'], ['Water', null]]);
  assert.equal((await Bq('POST', '/ai/breakdown', { projectId: p.id })).status, 404);
  // summary
  reply = 'You are on track.'; r = await A('POST', '/ai/summary', {}); assert.equal(r.json.summary, 'You are on track.');
  assert.ok(provider.calls.at(-1).messages[1].content.includes('counts'));
  r = await A('POST', '/ai/summary', { projectId: p.id }); assert.equal(r.status, 200);
  assert.equal((await Bq('POST', '/ai/summary', { projectId: p.id })).status, 404);
  // provider failure is a clean error and core features still work
  provider.chat = async () => { const { ProviderError } = await import('../ai/providers/groq.js'); throw new ProviderError('unavailable', 'down'); };
  r = await A('POST', '/ai/draft-task', { text: 'anything' }); assert.equal(r.status, 502); assert.ok(!r.text.includes('down'));
  assert.equal((await A('POST', '/tasks', { title: 'still works' })).status, 201);
  // no AI permission, no AI
  assert.equal((await G('POST', '/ai/draft-task', { text: 'hello there' })).status, 403);
  assert.ok(g);
});
