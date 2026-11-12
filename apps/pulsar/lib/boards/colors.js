// Reusable colour picker for every Boards control: presets, native picker, HEX, transparency, recents, saved palettes.
import { h } from '/shared/ui.js';
import { parse, join } from './color.js';
export { parse, join };
export const PRESETS = ['#f2f2f2', '#a6a6a6', '#4d4d4d', '#0a0a0a', '#ff6b1a', '#ffb88a', '#e5484d', '#ff8589', '#f5d90a', '#ffe58f', '#2f9e60', '#8ddc9e', '#00adef', '#8fd3ff', '#2f4ec6', '#8e4ec6', '#d6a8ff', '#ec4899', '#a16207', '#14b8a6'];
export const STICKY = ['#fff3a3', '#ffd0a8', '#ffb3b8', '#d6c2ff', '#b5dcff', '#b8f0c8', '#f2f2f2', '#c9c9c9'];
const KEY = 'pulsar:boards:colors';
const load = () => { try { const j = JSON.parse(localStorage.getItem(KEY) || '{}'); return { recent: j.recent || [], palettes: j.palettes || [] }; } catch { return { recent: [], palettes: [] }; } };
const save = (s) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* full or blocked */ } };
export const remember = (c) => { if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c || '')) return; const s = load(); s.recent = [c.toLowerCase(), ...s.recent.filter((x) => x !== c.toLowerCase())].slice(0, 12); save(s); };
// colorButton({ value, label, alpha, none, onInput(color), onChange(color) }) -> button. onInput fires while dragging, onChange when committed.
export function colorButton({ value, label = 'Colour', alpha = false, none = false, onInput = () => {}, onChange = () => {} }) {
  let cur = value; const sw = h('span', { class: 'bd-sw' }); const paint = () => { sw.style.background = cur === 'transparent' || cur === 'none' || !cur ? 'repeating-conic-gradient(#888 0 25%,#ccc 0 50%) 50%/8px 8px' : cur; };
  const btn = h('button', { type: 'button', class: 'bd-colbtn', 'aria-label': label, 'aria-haspopup': 'dialog', title: label }, sw, h('span', { class: 'bd-collab' }, label)); paint();
  const set = (c, commit) => { cur = c; paint(); onInput(c); if (commit) { remember(c); onChange(c); } };
  btn.addEventListener('click', (e) => { e.stopPropagation(); document.querySelector('.bd-pop')?.remove();
    const p = parse(cur), st = load(); let hex = p.hex, a = p.a;
    const hexIn = h('input', { class: 'bd-hex', value: cur && cur !== 'transparent' ? hex.toUpperCase() : '', maxlength: 7, 'aria-label': 'HEX colour', placeholder: '#RRGGBB', spellcheck: 'false' });
    const native = h('input', { type: 'color', value: hex, 'aria-label': 'Pick a colour', class: 'bd-native' });
    const alp = h('input', { type: 'range', min: 0, max: 100, value: Math.round(a * 100), 'aria-label': 'Opacity' });
    const apply = (commit) => { set(join(hex, a), commit); }; const sync = () => { native.value = hex; hexIn.value = hex.toUpperCase(); };
    const sws = (list, cls = '') => h('div', { class: `bd-sws ${cls}` }, list.map((c) => h('button', { type: 'button', class: 'bd-swb', style: `background:${c}`, 'aria-label': c, title: c, onclick: () => { const q = parse(c); hex = q.hex; a = alpha ? (q.a < 1 ? q.a : a) : 1; sync(); alp.value = Math.round(a * 100); apply(true); st.recent = load().recent; render(); } })));
    const pal = () => h('div', { class: 'bd-pals' }, st.palettes.map((pl, i) => h('div', {}, h('small', {}, pl.name, ' ', h('button', { type: 'button', class: 'bd-lnk', 'aria-label': `Add current colour to ${pl.name}`, onclick: () => { pl.colors = [...new Set([...pl.colors, hex])].slice(0, 24); save(st); render(); } }, '+ add current'), ' ', h('button', { type: 'button', class: 'bd-lnk', 'aria-label': `Delete palette ${pl.name}`, onclick: () => { st.palettes.splice(i, 1); save(st); render(); } }, 'delete')), sws(pl.colors))));
    const body = h('div');
    function render() {
      body.replaceChildren(sws(PRESETS), none ? h('button', { type: 'button', class: 'bd-lnk', onclick: () => { set('transparent', true); pop.remove(); } }, 'No colour') : null,
        h('div', { class: 'bd-row' }, native, hexIn), alpha ? h('label', { class: 'bd-alpha' }, h('small', {}, 'Opacity'), alp) : null,
        st.recent.length ? [h('small', {}, 'Recent'), sws(st.recent)] : null, h('small', {}, 'Saved palettes'), pal(),
        h('button', { type: 'button', class: 'bd-lnk', onclick: () => { const name = prompt('Palette name'); if (name) { st.palettes.push({ name: name.slice(0, 30), colors: [hex] }); save(st); render(); } } }, '+ New palette'));
    }
    native.addEventListener('input', () => { hex = native.value; hexIn.value = hex.toUpperCase(); apply(false); }); native.addEventListener('change', () => apply(true));
    hexIn.addEventListener('input', () => { let t = hexIn.value.trim(); if (!t.startsWith('#')) t = `#${t}`; if (/^#[0-9a-f]{6}$/i.test(t)) { hex = t.toLowerCase(); native.value = hex; apply(false); } }); hexIn.addEventListener('change', () => { if (/^#[0-9a-f]{6}$/i.test(hexIn.value.trim())) apply(true); });
    alp.addEventListener('input', () => { a = alp.value / 100; apply(false); }); alp.addEventListener('change', () => apply(true));
    const pop = h('div', { class: 'bd-pop', role: 'dialog', 'aria-label': label, onkeydown: (ev) => { if (ev.key === 'Escape') { pop.remove(); btn.focus(); } } }, body); render(); document.body.append(pop);
    const r = btn.getBoundingClientRect(), pr = pop.getBoundingClientRect(); pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pr.width - 8))}px`; pop.style.top = `${r.bottom + pr.height + 8 > innerHeight ? Math.max(8, r.top - pr.height - 6) : r.bottom + 6}px`;
    const off = (ev) => { if (!pop.contains(ev.target) && !btn.contains(ev.target)) { pop.remove(); document.removeEventListener('pointerdown', off, true); } }; setTimeout(() => document.addEventListener('pointerdown', off, true), 0); hexIn.focus?.();
  });
  btn.setValue = (c) => { cur = c; paint(); }; return btn;
}
