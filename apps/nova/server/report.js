// Nova's report section for the Reports screen and the assistant's reports.generate tool.
export function makeReport(core) {
  return async ({ user, range }) => {
    const ctx = await core.context(user), live = core.liveTasks(ctx), inRange = (iso) => iso && iso.slice(0, 10) >= range.from && iso.slice(0, 10) <= range.to;
    const o = await core.overview(user), created = ctx.ts.filter((t) => inRange(t.createdAt)), done = ctx.ts.filter((t) => inRange(t.completedAt));
    const row = (t) => [t.title, t.projectName || '', t.dueDate || '', t.priority];
    return { title: 'Nova overview', sections: [
      { heading: 'Right now', stats: [{ label: 'Open tasks', value: o.counts.open }, { label: 'Overdue', value: o.counts.overdue }, { label: 'Due in 7 days', value: o.counts.dueToday + o.counts.dueSoon }, { label: 'Blocked or waiting', value: o.counts.blocked }, { label: 'Active projects', value: o.counts.projects }] },
      { heading: `Activity (${range.label})`, stats: [{ label: 'Tasks created', value: created.length }, { label: 'Tasks completed', value: done.length }] },
      ...(o.overdue.length ? [{ heading: 'Overdue tasks', table: { columns: ['Task', 'Project', 'Due', 'Priority'], rows: o.overdue.map(row) } }] : []),
      ...(o.projects.length ? [{ heading: 'Projects', table: { columns: ['Project', 'Status', 'Progress', 'Open', 'Overdue', 'Deadline'], rows: o.projects.map((p) => [p.name, p.status, `${p.progress.percent}%`, p.progress.open, p.progress.overdue, p.deadline || '']) } }] : []),
      ...(live.length ? [] : [{ heading: 'Getting started', text: 'No tasks yet. Add a task in Nova to see progress here.' }]),
    ] };
  };
}
