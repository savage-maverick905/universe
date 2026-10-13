// Validation and shaping for Nova's documents. Every function throws HttpError(400) on bad input.
import { v, allowKeys } from '../../../shared/validate.js';
import { badRequest } from '../../../shared/errors.js';
import { isDate, FREQS, validTimeZone } from './dates.js';

export const SCHEMA_VERSION = 1;
export const TASK_STATUSES = [['backlog', 'Backlog'], ['todo', 'To Do'], ['in_progress', 'In Progress'], ['blocked', 'Blocked'], ['done', 'Done']];
export const STATUS_IDS = TASK_STATUSES.map(([id]) => id);
export const PROJECT_STATUSES = [['planning', 'Planning'], ['active', 'Active'], ['on_hold', 'On hold'], ['completed', 'Completed']];
export const PROJECT_STATUS_IDS = PROJECT_STATUSES.map(([id]) => id);
export const PRIORITIES = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['urgent', 'Urgent']];
export const PRIORITY_IDS = PRIORITIES.map(([id]) => id);
export const PROJECT_ICONS = ['target', 'folder', 'box', 'chart', 'sparkle', 'wallet', 'home', 'users', 'file', 'phone', 'check', 'flag'];

const date = (x, name) => { if (!isDate(x)) throw badRequest(`${name} must be a date like 2026-10-31`); return x; };
const nullable = (x, fn) => (x === null || x === '' ? null : fn(x));
const tags = (x) => [...new Set(v.stringArray(x, 'tags', { max: 20, itemMax: 30 }).map((t) => t.toLowerCase()))];

export function recurrenceIn(x) {
  if (x === null) return null;
  const r = allowKeys(v.object(x, 'recurrence'), ['freq', 'interval', 'byDay', 'until', 'count'], 'recurrence');
  const out = { freq: v.enum(r.freq, 'recurrence.freq', FREQS), interval: 1, byDay: [], until: null, remaining: null };
  if (r.interval !== undefined) { if (!Number.isInteger(r.interval) || r.interval < 1 || r.interval > 99) throw badRequest('recurrence.interval must be a whole number from 1 to 99'); out.interval = r.interval; }
  if (r.byDay !== undefined) {
    if (!Array.isArray(r.byDay) || r.byDay.length > 7 || r.byDay.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw badRequest('recurrence.byDay must be weekday numbers 0 (Sunday) to 6');
    if (out.freq !== 'weekly' && r.byDay.length) throw badRequest('recurrence.byDay only applies to weekly repeats');
    out.byDay = [...new Set(r.byDay)].sort();
  }
  if (r.until !== undefined && r.until !== null) out.until = date(r.until, 'recurrence.until');
  if (r.count !== undefined && r.count !== null) {
    if (!Number.isInteger(r.count) || r.count < 2 || r.count > 365) throw badRequest('recurrence.count must be a whole number from 2 to 365');
    out.remaining = r.count - 1; // repeats still to be created after this one
  }
  if (out.until && out.remaining != null) throw badRequest('Use either an end date or a number of repeats, not both');
  return out;
}

const subtasksIn = (x) => {
  if (!Array.isArray(x) || x.length > 50) throw badRequest('subtasks must be a list of at most 50 items');
  return x.map((s, i) => {
    const o = allowKeys(v.object(s, `subtasks[${i}]`), ['id', 'title', 'done'], `subtasks[${i}]`);
    if (o.done !== undefined && typeof o.done !== 'boolean') throw badRequest('subtask done must be true or false');
    return { id: o.id === undefined ? null : v.anyId(o.id, 'subtask id'), title: v.string(o.title, 'subtask title', { min: 1, max: 200 }), done: !!o.done };
  });
};

const PROJECT_KEYS = ['name', 'description', 'icon', 'color', 'status', 'priority', 'startDate', 'deadline', 'tags', 'archived'];
export function projectIn(body, { partial = false } = {}) {
  const b = allowKeys(v.object(body), PROJECT_KEYS), o = {};
  if (!partial && !('name' in b)) throw badRequest('name is required');
  if ('name' in b) o.name = v.string(b.name, 'name', { min: 1, max: 120 });
  if ('description' in b) o.description = v.string(b.description, 'description', { max: 4000 });
  if ('icon' in b) o.icon = nullable(b.icon, (x) => v.enum(x, 'icon', PROJECT_ICONS));
  if ('color' in b) o.color = nullable(b.color, (x) => { if (typeof x !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(x)) throw badRequest('color must look like #ED6627'); return x.toUpperCase(); });
  if ('status' in b) o.status = v.enum(b.status, 'status', PROJECT_STATUS_IDS);
  if ('priority' in b) o.priority = v.enum(b.priority, 'priority', PRIORITY_IDS);
  if ('startDate' in b) o.startDate = nullable(b.startDate, (x) => date(x, 'startDate'));
  if ('deadline' in b) o.deadline = nullable(b.deadline, (x) => date(x, 'deadline'));
  if ('tags' in b) o.tags = tags(b.tags);
  if ('archived' in b) { if (typeof b.archived !== 'boolean') throw badRequest('archived must be true or false'); o.archived = b.archived; }
  return o;
}
export const projectDefaults = () => ({ description: '', icon: null, color: null, status: 'active', priority: 'medium', startDate: null, deadline: null, tags: [], archived: false });

const TASK_KEYS = ['title', 'description', 'projectId', 'milestoneId', 'status', 'priority', 'startDate', 'dueDate', 'assignedToMe', 'tags', 'notes', 'subtasks', 'dependsOn', 'recurrence', 'archived'];
export function taskIn(body, { partial = false } = {}) {
  const b = allowKeys(v.object(body), TASK_KEYS), o = {};
  if (!partial && !('title' in b)) throw badRequest('title is required');
  if ('title' in b) o.title = v.string(b.title, 'title', { min: 1, max: 200 });
  if ('description' in b) o.description = v.string(b.description, 'description', { max: 4000 });
  if ('projectId' in b) o.projectId = nullable(b.projectId, (x) => v.anyId(x, 'projectId'));
  if ('milestoneId' in b) o.milestoneId = nullable(b.milestoneId, (x) => v.anyId(x, 'milestoneId'));
  if ('status' in b) o.status = v.enum(b.status, 'status', STATUS_IDS);
  if ('priority' in b) o.priority = v.enum(b.priority, 'priority', PRIORITY_IDS);
  if ('startDate' in b) o.startDate = nullable(b.startDate, (x) => date(x, 'startDate'));
  if ('dueDate' in b) o.dueDate = nullable(b.dueDate, (x) => date(x, 'dueDate'));
  if ('assignedToMe' in b) { if (typeof b.assignedToMe !== 'boolean') throw badRequest('assignedToMe must be true or false'); o.assignedToMe = b.assignedToMe; }
  if ('tags' in b) o.tags = tags(b.tags);
  if ('notes' in b) o.notes = v.string(b.notes, 'notes', { max: 8000 });
  if ('subtasks' in b) o.subtasks = subtasksIn(b.subtasks);
  if ('dependsOn' in b) o.dependsOn = [...new Set(v.stringArray(b.dependsOn, 'dependsOn', { max: 20, itemMax: 100 }).map((x) => v.anyId(x, 'dependsOn id')))];
  if ('recurrence' in b) o.recurrence = recurrenceIn(b.recurrence);
  if ('archived' in b) { if (typeof b.archived !== 'boolean') throw badRequest('archived must be true or false'); o.archived = b.archived; }
  return o;
}
export const taskDefaults = () => ({ description: '', projectId: null, milestoneId: null, status: 'todo', priority: 'medium', startDate: null, dueDate: null, assignedToMe: true, tags: [], notes: '', subtasks: [], dependsOn: [], recurrence: null, archived: false });

export function milestoneIn(body, { partial = false } = {}) {
  const b = allowKeys(v.object(body), ['title', 'description', 'dueDate', 'completed']), o = {};
  if (!partial && !('title' in b)) throw badRequest('title is required');
  if ('title' in b) o.title = v.string(b.title, 'title', { min: 1, max: 120 });
  if ('description' in b) o.description = v.string(b.description, 'description', { max: 2000 });
  if ('dueDate' in b) o.dueDate = nullable(b.dueDate, (x) => date(x, 'dueDate'));
  if ('completed' in b) { if (typeof b.completed !== 'boolean') throw badRequest('completed must be true or false'); o.completed = b.completed; }
  return o;
}

export function settingsIn(body) {
  const b = allowKeys(v.object(body), ['timezone']), o = {};
  if ('timezone' in b) { if (!validTimeZone(b.timezone)) throw badRequest('timezone must be a valid time zone name such as Africa/Lagos'); o.timezone = b.timezone; }
  return o;
}

// What the model is allowed to ask for. Everything is flat strings so the platform's argument checker can validate it.
export const strOpt = (x, name, max) => (x === undefined || x === '' ? undefined : v.string(x, name, { max }));
