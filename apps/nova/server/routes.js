// Nova's HTTP API. Every route: (1) checks a Universe permission first, (2) acts only on the signed-in user's records,
// (3) takes identity from the session, never from the request, (4) rejects unknown body fields.
import { v, allowKeys } from '../../../shared/validate.js';
import { badRequest } from '../../../shared/errors.js';
import { reply } from '../../../http/http.js';
import { addDays, isDate } from './dates.js';
import { PRIORITIES, PRIORITY_IDS, PROJECT_ICONS, PROJECT_STATUSES, PROJECT_STATUS_IDS, STATUS_IDS, TASK_STATUSES, milestoneIn, projectIn, settingsIn, taskIn } from './schema.js';
import { LIMITS } from './core.js';

export const P = '/api/apps/nova';
const SORTS = ['dueDate', 'priority', 'status', 'title', 'createdAt', 'updatedAt'];

export function routes({ router, s, core, ai }) {
  const can = (user, perm) => s.permissions.assert(user, `nova.${perm}`);
  const route = (method, path, perm, fn) => router.add(method, `${P}${path}`, async (ctx) => { await can(ctx.user, perm); return fn(ctx); });
  const opt = (q, k, allowed) => { const x = q.get(k); if (!x) return undefined; if (allowed && !allowed.includes(x)) throw badRequest(`${k} must be one of: ${allowed.join(', ')}`); return x; };
  const int = (q, k, min, max, dflt) => { const x = q.get(k); if (x == null || x === '') return dflt; const n = Number(x); if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${k} must be a whole number from ${min} to ${max}`); return n; };
  const bool = (q, k) => q.get(k) === 'true';

  route('GET', '/meta', 'task.read', async ({ user }) => {
    const [settings, today] = [await core.getSettings(user), await core.today(user)];
    return { statuses: TASK_STATUSES.map(([id, label]) => ({ id, label })), priorities: PRIORITIES.map(([id, label]) => ({ id, label })), projectStatuses: PROJECT_STATUSES.map(([id, label]) => ({ id, label })),
      icons: PROJECT_ICONS, limits: LIMITS, settings, today, canWriteProjects: await s.permissions.can(user, 'nova.project.write'), canWriteTasks: await s.permissions.can(user, 'nova.task.write'),
      canDeleteTasks: await s.permissions.can(user, 'nova.task.delete'), canDeleteProjects: await s.permissions.can(user, 'nova.project.delete'), ai: await s.permissions.can(user, 'nova.ai.use') && await s.permissions.can(user, 'ai.use') };
  });
  route('GET', '/settings', 'task.read', async ({ user }) => ({ settings: await core.getSettings(user) }));
  route('PUT', '/settings', 'task.write', async ({ user, body }) => ({ settings: await core.saveSettings(user, settingsIn(body)) }));
  route('GET', '/overview', 'task.read', ({ user }) => core.overview(user));
  route('GET', '/calendar', 'task.read', ({ user, query }) => {
    const from = query.get('from'), to = query.get('to') || (isDate(from) ? addDays(from, 41) : null);
    return core.calendar(user, from, to);
  });

  // ---- Projects ----
  route('GET', '/projects', 'project.read', async ({ user, query }) => ({ projects: await core.listProjects(user, { archived: bool(query, 'archived') }) }));
  route('POST', '/projects', 'project.write', async ({ user, body }) => reply(201, { project: await core.createProject(user, projectIn(body)) }));
  route('GET', '/projects/:id', 'project.read', async ({ user, params }) => ({ project: await core.getProject(user, params.id) }));
  route('PATCH', '/projects/:id', 'project.write', async ({ user, params, body }) => ({ project: await core.updateProject(user, params.id, projectIn(body, { partial: true })) }));
  // Deleting a project deletes its tasks and milestones, so the caller must say so explicitly (?confirm=true). Archiving is the gentle option.
  route('DELETE', '/projects/:id', 'project.delete', ({ user, params, query, ip }) => {
    if (!bool(query, 'confirm')) throw badRequest('Deleting a project also deletes its tasks and milestones. Send confirm=true to proceed, or archive the project instead.', 'confirm_required');
    return core.deleteProject(user, params.id, ip);
  });
  route('POST', '/projects/:id/milestones', 'project.write', async ({ user, params, body }) => reply(201, { milestone: await core.createMilestone(user, params.id, milestoneIn(body)) }));
  route('PATCH', '/milestones/:id', 'project.write', async ({ user, params, body }) => ({ milestone: await core.updateMilestone(user, params.id, milestoneIn(body, { partial: true })) }));
  route('DELETE', '/milestones/:id', 'project.write', ({ user, params }) => core.deleteMilestone(user, params.id));

  // ---- Tasks ----
  route('GET', '/tasks', 'task.read', ({ user, query }) => core.listTasks(user, {
    q: opt(query, 'q'), projectId: opt(query, 'project'), milestoneId: opt(query, 'milestone'), status: opt(query, 'status', STATUS_IDS), priority: opt(query, 'priority', PRIORITY_IDS), tag: opt(query, 'tag'),
    due: opt(query, 'due', ['overdue', 'today', 'week', 'none']), from: opt(query, 'from'), to: opt(query, 'to'), open: bool(query, 'open'), archived: bool(query, 'archived'),
    sort: opt(query, 'sort', SORTS), dir: opt(query, 'dir', ['asc', 'desc']), limit: int(query, 'limit', 1, 1000, 500), offset: int(query, 'offset', 0, 100000, 0) }));
  route('POST', '/tasks', 'task.write', async ({ user, body }) => reply(201, { task: await core.createTask(user, taskIn(body)) }));
  // Up to 30 tasks at once, used to save the tasks a person chose from an AI breakdown. All or nothing.
  route('POST', '/tasks/batch', 'task.write', async ({ user, body }) => {
    const b = allowKeys(v.object(body), ['projectId', 'tasks']);
    if (!Array.isArray(b.tasks) || !b.tasks.length || b.tasks.length > 30) throw badRequest('tasks must be a list of 1 to 30 tasks');
    const inputs = b.tasks.map((t) => taskIn({ ...v.object(t, 'task'), projectId: b.projectId }));
    const created = [];
    await s.storage.transaction(async () => { for (const i of inputs) created.push(await core.createTask(user, i)); });
    return reply(201, { tasks: created });
  });
  route('GET', '/tasks/:id', 'task.read', async ({ user, params }) => ({ task: await core.getTask(user, params.id) }));
  route('PATCH', '/tasks/:id', 'task.write', async ({ user, params, body }) => { const { next, ...task } = await core.updateTask(user, params.id, taskIn(body, { partial: true })); return { task, next }; });
  route('POST', '/tasks/:id/complete', 'task.write', async ({ user, params }) => { const { next, ...task } = await core.updateTask(user, params.id, { status: 'done' }); return { task, next }; });
  route('POST', '/tasks/:id/reopen', 'task.write', async ({ user, params }) => { const { next, ...task } = await core.updateTask(user, params.id, { status: 'todo' }); return { task }; });
  route('DELETE', '/tasks/:id', 'task.delete', ({ user, params }) => core.deleteTask(user, params.id));

  // ---- Dashboard widgets ----
  route('GET', '/widget/summary', 'stats.read', async ({ user }) => { const { counts } = await core.overview(user);
    return { stats: [{ label: 'Open tasks', value: counts.open }, { label: 'Overdue', value: counts.overdue }, { label: 'Due this week', value: counts.dueToday + counts.dueSoon }, { label: 'Projects', value: counts.projects }] }; });
  route('GET', '/widget/attention', 'task.read', async ({ user }) => { const o = await core.overview(user);
    return { items: [...o.overdue, ...o.dueToday, ...o.dueSoon].slice(0, 6).map((t) => ({ title: t.title, subtitle: `${t.overdue ? 'Overdue · ' : ''}${t.dueDate}${t.projectName ? ` · ${t.projectName}` : ''}` })) }; });

  // ---- AI (all optional; Nova works fully without them) ----
  const ai_ = (path, fn) => route('POST', path, 'ai.use', fn);
  ai_('/ai/draft-task', async ({ user, body }) => { const b = allowKeys(v.object(body), ['text']); return ai.draftTask(user, v.string(b.text, 'text', { min: 3, max: 1000 })); });
  ai_('/ai/breakdown', async ({ user, body }) => { await can(user, 'task.write'); const b = allowKeys(v.object(body), ['projectId', 'goal']);
    return ai.breakdown(user, v.anyId(b.projectId, 'projectId'), 'goal' in b ? v.string(b.goal, 'goal', { max: 500 }) : ''); });
  ai_('/ai/summary', async ({ user, body }) => { const b = allowKeys(v.object(body), ['projectId']); return ai.summary(user, b.projectId ? v.anyId(b.projectId, 'projectId') : null); });
  route('GET', '/proposals', 'ai.use', async ({ user, query }) => ({ proposals: await ai.pendingProposals(user, opt(query, 'conversationId')) }));
  route('POST', '/proposals/:id/confirm', 'ai.use', ({ user, params }) => ai.confirm(user, params.id));
  route('POST', '/proposals/:id/dismiss', 'ai.use', ({ user, params }) => ai.dismiss(user, params.id));
}
