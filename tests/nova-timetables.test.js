import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, closeAll } from './helpers.js';
import { resolve, findClashes } from '../apps/nova/server/timetables.js';
after(closeAll);
const B = '/api/apps/nova';

test('timetable maths: duration items flow after each other, fixed items anchor, clashes cross timetables', () => {
  const school = { id: 's', name: 'School', color: '#fff', startTime: '08:00', active: true, items: [
    { id: 'a', title: 'Maths', days: [1], durationMin: 60 }, { id: 'b', title: 'Break', days: [1], durationMin: 30 }, { id: 'c', title: 'Physics', days: [1], startTime: '12:00', endTime: '13:00' }] };
  const r = resolve(school).filter((x) => x.day === 1);
  assert.deepEqual(r.map((x) => [x.title, x.startTime, x.endTime]), [['Maths', '08:00', '09:00'], ['Break', '09:00', '09:30'], ['Physics', '12:00', '13:00']]);
  const gym = { id: 'g', name: 'Gym', color: '#000', startTime: '08:30', active: true, items: [{ id: 'x', title: 'Run', days: [1, 2], durationMin: 45 }] };
  const { clashes } = findClashes([school, gym]);
  assert.equal(clashes.length, 2); // Run 08:30-09:15 overlaps Maths and Break
  assert.ok(clashes.every((c) => c.cross && c.day === 1));
  assert.equal(clashes[0].from, '08:30'); assert.equal(clashes[0].to, '09:00'); assert.equal(clashes[0].minutes, 30);
  assert.equal(findClashes([school, { ...gym, active: false }]).clashes.length, 0); // paused timetables never clash
  const touching = { id: 't', name: 'T', color: '#000', startTime: '09:30', active: true, items: [{ id: 'y', title: 'Read', days: [1], durationMin: 30 }] };
  assert.equal(findClashes([school, touching]).clashes.length, 0); // back to back is not a clash
});

test('timetables API: build, clash warning, status per date, task links, privacy', async () => {
  const t = await startTestApp({});
  const admin = await t.login('admin@example.com', 'correct-horse-battery');
  const mk = async (email) => { await t.request('POST', '/api/users', { cookie: admin.cookie, body: { email, displayName: email, password: 'a-decent-password', roleId: 'resident' } }); return t.login(email, 'a-decent-password'); };
  await t.request('POST', '/api/apps/nova/install', { cookie: admin.cookie });
  const a = await mk('a@example.com'), b = await mk('b@example.com');
  const A = (m, p, body) => t.request(m, `${B}${p}`, { cookie: a.cookie, body }), Bq = (m, p, body) => t.request(m, `${B}${p}`, { cookie: b.cookie, body });

  const school = (await A('POST', '/timetables', { name: 'School', startTime: '08:00' })).json.timetable;
  const gym = (await A('POST', '/timetables', { name: 'Gym', startTime: '08:30' })).json.timetable;
  const maths = (await A('POST', `/timetables/${school.id}/items`, { title: 'Maths', days: [1, 2], durationMin: 60 })).json;
  assert.equal(maths.clashes.length, 0);
  const run = (await A('POST', `/timetables/${gym.id}/items`, { title: 'Run', days: [1], durationMin: 45 })).json;
  assert.equal(run.clashes.length, 1); assert.equal(run.clashes[0].cross, true); // warned straight away
  assert.equal((await A('POST', `/timetables/${gym.id}/items`, { title: 'Bad' })).status, 400); // needs a duration or a range
  assert.equal((await A('POST', `/timetables/${gym.id}/items`, { title: 'Bad', startTime: '10:00', endTime: '09:00' })).status, 400);

  // 2026-11-02 is a Monday
  const day = (await A('GET', '/timetable-day?date=2026-11-02')).json;
  assert.deepEqual(day.items.map((i) => [i.title, i.startTime, i.endTime, i.clash]), [['Maths', '08:00', '09:00', true], ['Run', '08:30', '09:15', true]]);
  assert.equal((await A('GET', '/timetable-day?date=2026-11-03')).json.items.length, 1); // Tuesday: only Maths

  // status is per date
  const st = await A('PUT', `/timetables/${school.id}/items/${maths.item.id}/status`, { date: '2026-11-02', status: 'done' });
  assert.equal(st.status, 200);
  assert.equal((await A('GET', '/timetable-day?date=2026-11-02')).json.items[0].status, 'done');
  assert.equal((await A('GET', '/timetable-day?date=2026-11-09')).json.items[0].status, null); // next Monday is untouched
  assert.equal((await A('PUT', `/timetables/${school.id}/items/${maths.item.id}/status`, { date: '2026-11-02', status: 'nonsense' })).status, 400);
  await A('PUT', `/timetables/${school.id}/items/${maths.item.id}/status`, { date: '2026-11-02', status: null });
  assert.equal((await A('GET', '/timetable-day?date=2026-11-02')).json.items[0].status, null);

  // link tasks
  const task = (await A('POST', '/tasks', { title: 'Do homework' })).json.task;
  const linked = await A('PUT', `/timetables/${school.id}/items/${maths.item.id}/tasks`, { taskIds: [task.id] });
  assert.equal(linked.json.linked.length, 1);
  assert.equal((await A('GET', '/timetable-day?date=2026-11-02')).json.items[0].linked[0].title, 'Do homework');
  assert.equal((await A('PATCH', `/tasks/${task.id}`, { timetableId: school.id, timetableItemId: 'tti_nope' })).status, 400);
  assert.equal((await A('PATCH', `/tasks/${task.id}`, { timetableId: null, timetableItemId: null })).status, 200); // unlink from the task side
  assert.equal((await A('GET', '/timetable-day?date=2026-11-02')).json.items[0].linked.length, 0);

  // privacy: another person's timetable is a 404, and they cannot link to it
  assert.equal((await Bq('GET', `/timetables`)).json.timetables.length, 0);
  assert.equal((await Bq('PATCH', `/timetables/${school.id}`, { name: 'Mine now' })).status, 404);
  const btask = (await Bq('POST', '/tasks', { title: 'B task' })).json.task;
  assert.equal((await Bq('PATCH', `/tasks/${btask.id}`, { timetableId: school.id, timetableItemId: maths.item.id })).status, 400);
  assert.equal((await Bq('PUT', `/timetables/${school.id}/items/${maths.item.id}/tasks`, { taskIds: [btask.id] })).status, 404);

  // deleting an item or timetable never leaves a dangling link, and removing clashes
  await A('PUT', `/timetables/${school.id}/items/${maths.item.id}/tasks`, { taskIds: [task.id] });
  assert.equal((await A('DELETE', `/timetables/${school.id}/items/${maths.item.id}`)).status, 200);
  assert.equal((await A('GET', `/tasks/${task.id}`)).json.task.timetableItemId ?? null, null);
  assert.equal((await A('GET', '/timetable-clashes')).json.clashes.length, 0);
  assert.equal((await A('DELETE', `/timetables/${gym.id}`)).status, 200);
  await t.close();
});
