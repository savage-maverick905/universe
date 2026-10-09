// Renders the three widget shapes an app can provide. Used by the dashboard home and by app overview pages.
//   stat  -> { stats: [{label, value}] }   list -> { items: [{title, subtitle?}] }   chart -> { series: [{label, value}] }
import { h } from './ui.js';
export function renderWidget(type, data) {
  if (type === 'stat') return h('div', { class: 'stats' }, (data.stats || []).map((s) => h('div', { class: 'stat' }, h('b', {}, String(s.value)), h('span', {}, s.label))));
  if (type === 'list') return h('ul', { class: 'items' }, (data.items || []).map((i) => h('li', {}, i.title, i.subtitle ? h('div', { class: 'sub' }, i.subtitle) : null)));
  const max = Math.max(1, ...(data.series || []).map((s) => s.value));
  return h('div', {}, (data.series || []).map((s) => h('div', { class: 'bar' }, h('span', {}, s.label),
    h('span', { class: 'track' }, h('i', { style: `width:${Math.round((s.value / max) * 100)}%` })), h('span', {}, String(s.value)))));
}
