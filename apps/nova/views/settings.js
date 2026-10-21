import { api, h, toast } from '../services/api.js';
import { notifyCard } from '/shared/notify.js';
import { accountPanels } from '/shared/account.js';
import { S, field, select, fmtDate, todayStr } from '../lib.js';

export function settingsView({ frame, onSignOut, redraw }) {
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [S.meta.settings.timezone];
  const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const all = [...new Set(['UTC', browser, S.meta.settings.timezone, ...zones])];
  const tz = select(all.map((z) => [z, z]), S.meta.settings.timezone, () => {}, 'Time zone');
  const err = h('p', { class: 'err', role: 'alert' });
  const panel = h('section', { class: 'panel' }, h('h2', {}, 'Time zone'), h('p', { class: 'sub' }, `Due dates are plain calendar dates. Your time zone only decides what counts as "today" (right now: ${fmtDate(todayStr(), true)}), which is how overdue tasks and repeats are worked out.`),
    field('Time zone', tz), err, h('div', { class: 'row' }, h('button', { class: 'btn small', disabled: S.meta.canWriteTasks ? null : '', onclick: async () => { err.textContent = ''; try { const r = await api('PUT', '/settings', { timezone: tz.value }); S.meta.settings = r.settings; toast('Time zone saved'); redraw(); } catch (x) { err.textContent = x.message; } } }, 'Save time zone')));
  const [profile, password, install, session, clear] = accountPanels({ session: S.me, appName: 'Nova', appId: 'nova', note: 'This removes your Nova projects, tasks and milestones.', onSignOut });
  frame('settings', h('div', { class: 'settings' }, h('h1', { class: 'page-title' }, 'Settings'), panel, notifyCard(), profile, password, install, session, clear));
}
