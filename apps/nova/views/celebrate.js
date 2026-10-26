// When the last task due today is finished, the day is "cleared". Once per day, that deserves a moment.
import { icon } from '/shared/icons.js';
import { api, h } from '../services/api.js';
import { dialog, closer } from '/shared/ui.js';
import { confetti } from '/shared/confetti.js';

const LINES = ['Nothing left for today. Go enjoy it.', 'Cleared. Future you says thanks.', 'That is the whole list. Take a breath.', 'Today is done and dusted.', 'Look at you, finishing things.'];
const MARKS = { 3: 'Three in a row. A habit is forming.', 7: 'A full week. That is real momentum.', 14: 'Two weeks straight. Unstoppable.', 30: 'Thirty days. That is who you are now.', 100: 'One hundred days. Legendary.' };
const flag = (k, v) => { try { if (v) localStorage.setItem(k, v); return localStorage.getItem(k); } catch { return null; } };

export async function checkCelebrate() {
  let s; try { s = await api('GET', '/streak'); } catch { return; }
  const key = `nova.cleared.${s.today}`;
  if (s.remaining !== 0 || s.doneToday < 1 || flag(key)) return;
  flag(key, '1'); confetti({ count: 170 });
  const line = LINES[(Math.random() * LINES.length) | 0], mark = MARKS[s.days];
  const card = h('div', { class: 'party' }, h('div', { class: 'party-emoji', 'aria-hidden': 'true' }, icon(s.days >= 3 ? 'flame' : 'sparkle', 44)), h('h2', {}, 'Day cleared'), h('p', {}, line),
    h('div', { class: 'party-stats' }, h('div', {}, h('b', {}, String(s.doneToday)), h('small', {}, s.doneToday === 1 ? 'task done today' : 'tasks done today')), h('div', {}, h('b', {}, String(s.days)), h('small', {}, s.days === 1 ? 'day streak' : 'day streak'))),
    mark ? h('p', { class: 'party-mark' }, mark) : null, h('div', { class: 'row actions' }, h('button', { class: 'btn', type: 'button', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); confetti({ count: 70, x: (r.left + r.width / 2) / innerWidth, y: r.top / innerHeight }); } }, 'More confetti'), closer('Nice')));
  dialog('', card);
}
