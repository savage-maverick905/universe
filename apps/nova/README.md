# Nova

Nova is Universe's project, task and execution manager: it turns ideas into plans and plans into finished work. Universe stays the command center and assistant, Orbit handles money, Inventory handles possessions. Nova only does projects and tasks.

Folder: `apps/nova/` (no core files were changed to register it: `manifest.json` is the registration). Install it as an admin from the Apps page, then open `/apps/nova/`.

## Features (status)
| Feature | Status |
|---|---|
| Projects: name, description, icon, colour, status (planning/active/on hold/completed), priority, start date, deadline, tags, archive, delete (explicit confirmation) | Implemented |
| Tasks: title, description, project, milestone, status (Backlog/To Do/In Progress/Blocked/Done), priority, start/due date, tags, notes, subtasks, assignee ("me"), archive, delete | Implemented |
| Milestones with their own progress (from linked tasks) | Implemented |
| Dependencies (no self-reference, no loops, a task cannot be finished before what it depends on) | Implemented |
| Recurring tasks (daily/weekly with weekdays/monthly/yearly, every N, end date or count) | Implemented |
| Schedule: events and activities (event/activity/meeting/appointment/reminder) with date, start/end time or all day, multi-day, place, project, repeat (daily/weekly/monthly/yearly, every N, end date or count), clash warnings | Implemented |
| Views: overview ("what needs attention"), task list (search, filter, sort), Kanban board, month calendar, project pages | Implemented |
| Dashboard widgets (summary, needs attention) and a report ("Nova overview") | Implemented |
| Assistant tools (read) and propose-then-confirm changes | Implemented |
| In-app AI: task drafting, project breakdown, progress summary (all optional) | Implemented |
| Project members / shared projects / assigning to other people | Not built: Universe has no sharing layer yet, so every record is private to its owner |
| Calendar integrations (Google etc.) | Not built. The calendar view shows Nova's own due dates only |
| Custom statuses | Not built (fixed five) |
| Import / export in the app | Not built. `npm run export` / `npm run import` already include `nova_*` collections |

## Rules worth knowing
- **Dates** are calendar dates (`YYYY-MM-DD`), not moments in time. Your time zone (Settings, set automatically from your device on first visit) only decides what "today" is, which drives overdue and repeats.
- **Progress** = finished tasks / all tasks in the project, ignoring archived tasks and routines (repeating tasks never finish).
- **Recurring**: completing a repeating task marks it done and creates the next copy (once, even if you reopen and complete again). If you finish late, the next copy is the first occurrence that is not in the past. Monthly repeats keep the original day (Jan 31 gives Feb 28/29, then Mar 31).
- **Limits**: 300 projects, 10,000 tasks, 50 milestones per project per person.

## Data (all documents carry `ownerId` and `schemaVersion: 1`)
| Collection | Holds |
|---|---|
| `nova_projects` | `name, description, icon, color, status, priority, startDate, deadline, tags[], archived` |
| `nova_tasks` | `title, description, projectId, milestoneId, status, priority, startDate, dueDate, assigneeId, tags[], notes, subtasks[{id,title,done}], dependsOn[], recurrence{freq,interval,byDay,until,remaining,anchor}, seriesId, spawnedNextId, archived, completedAt` |
| `nova_milestones` | `projectId, title, description, dueDate, completed, completedAt` |
| `nova_events` | `title, description, location, kind, date, endDate, allDay, startTime, endTime, projectId, recurrence{freq,interval,until,remaining,anchor}` (repeats are expanded on read, not copied) |
| `nova_settings` | one per user: `timezone` |
| `nova_proposals` | drafts the assistant prepared: `action, taskId, input, lines, status (pending/applying/applied/dismissed/expired), expiresAt` (1 hour) |

Plain JSON through the storage interface, so SQLite and the GitHub driver both work. No migration step is needed: collections are created on first use.

## Permissions (residents and admins get all of them at install; guests none)
`nova.project.read|write|delete`, `nova.task.read|write|delete`, `nova.stats.read` (widgets and report), `nova.ai.use` (AI features; the user also needs the core `ai.use`).

## API (all under `/api/apps/nova`, session required, every record scoped to the signed-in user, other people's ids answer 404)
`GET /meta`, `GET|PUT /settings`, `GET /overview`, `GET /calendar?from&to`;
`GET|POST /projects`, `GET|PATCH /projects/:id`, `DELETE /projects/:id?confirm=true`, `POST /projects/:id/milestones`, `PATCH|DELETE /milestones/:id`;
`GET /events?from&to` (max 92 days), `POST /events`, `GET|PATCH|DELETE /events/:id` (same permissions as tasks);
`GET|POST /tasks` (filters `q project milestone status priority tag due from to open archived sort dir limit offset`), `POST /tasks/batch`, `GET|PATCH|DELETE /tasks/:id`, `POST /tasks/:id/complete|reopen`;
`GET /widget/summary|attention`;
AI: `POST /ai/draft-task|breakdown|summary`, `GET /proposals`, `POST /proposals/:id/confirm|dismiss`.
Request bodies reject unknown fields. Writes need the `X-Requested-With: universe` header like everywhere else.

## Assistant
Read tools: `nova.listEvents`, `nova.overview`, `nova.listTasks`, `nova.listProjects`, `nova.getProject`. Change tool: `nova.propose` (create task, update task, mark done, create project, add event). It never saves: it stores a draft and the assistant shows a **Review change in Nova** card; only the person's Confirm click applies it, through the same validated code as the forms, after re-checking permissions. Drafts expire after an hour. `nova.propose` is declared `read` access because it changes no tasks or projects; it only stores the draft.

In-app AI reuses Universe's provider, default model and personal API key settings (nothing is configured in Nova). Generated text is parsed, cut down to known fields and re-validated; it only fills a form or a checklist you review. If the provider fails you get a clear message and everything else keeps working.

## Environment
No new variables. AI needs what the assistant already needs (`GROQ_API_KEY` or a personal key).
