// Universe choices: no dropdowns anywhere. Every native <select> is replaced by a control that is always on screen:
//   - a few short options  -> pill chips you tap (one is on)
//   - many or long options -> a row that opens a searchable sheet (bottom sheet on phones, centred card on desktop)
//   - multi-select         -> toggle chips (with a filter box when the list is long)
// The native <select> stays in the DOM, hidden, as the source of truth, so existing code that reads `.value` /
// `.selectedOptions` or listens for `change` keeps working untouched. Opt out with data-native on a select.
import { icon } from '/shared/icons.js';

const clean = (s) => String(s ?? '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{200D}\u{FE0F}]+\s?/gu, '');
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...kids.flat().filter((x) => x != null)); return n;
};
const isNarrow = () => matchMedia('(max-width: 640px)').matches;
const labelOf = (sel) => sel.getAttribute('aria-label') || sel.closest('label')?.firstChild?.textContent?.trim() || '';
let openMenu = null;

const flat = (sel) => [...sel.children].flatMap((c) => c.tagName === 'OPTGROUP' ? [{ group: c.label }, ...[...c.children].map((o) => ({ o }))] : [{ o: c }]);
const emit = (sel) => { sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); };

function enhance(sel) {
  if (sel.dataset.native != null || sel._uni) return;
  sel._uni = true;
  sel.classList.add('uni-native'); sel.tabIndex = -1; sel.setAttribute('aria-hidden', 'true');
  const multi = sel.multiple;

  const host = el('div', { class: 'uni-ctl' });
  sel.before(host);
  host.addEventListener('click', (e) => { if (e.target.closest?.('button')) e.preventDefault(); }); // inside a <label>, a tap would otherwise be forwarded to the first button
  let filter = '';

  const paint = () => {
    const opts = flat(sel), real = opts.filter((x) => x.o), l = labelOf(sel);
    const chipsOk = multi || (real.length <= 8 && !opts.some((x) => x.group != null) && real.every((x) => clean(x.o.textContent).trim().length <= 24));
    host.textContent = '';
    host.classList.toggle('disabled', sel.disabled);
    if (chipsOk) {
      const set = el('div', { class: `uni-chipset${multi ? ' multi' : ''}`, role: multi ? 'group' : 'radiogroup', 'aria-label': l || null });
      let box = set;
      if (multi && real.length > 12) {
        const q = el('input', { type: 'search', class: 'uni-filter', placeholder: 'Filter', autocomplete: 'off', 'aria-label': 'Filter options', value: filter });
        q.addEventListener('input', () => { filter = q.value; paint(); host.querySelector('.uni-filter')?.focus(); });
        host.append(q); box = el('div', { class: 'uni-chipset multi scroll' }); host.append(box);
      } else host.append(set);
      const needle = filter.trim().toLowerCase();
      for (const x of real) {
        const o = x.o, t = clean(o.textContent).trim() || 'None';
        if (multi && needle && !t.toLowerCase().includes(needle)) continue;
        const on = o.selected && !(!multi && o.disabled);
        const b = el('button', { type: 'button', class: `uni-chip${on ? ' on' : ''}`, role: multi ? 'checkbox' : 'radio', 'aria-label': t, 'aria-checked': on ? 'true' : 'false', disabled: o.disabled || sel.disabled }, on && multi ? icon('check', 14) : null, t);
        b.addEventListener('click', () => {
          if (multi) { o.selected = !o.selected; emit(sel); paint(); return; }
          if (sel.value !== o.value) { sel.value = o.value; emit(sel); } else paint();
        });
        box.append(b);
      }
      if (box === set) host.firstChild === set || host.append(set);
      if (multi && !box.childElementCount) box.append(el('div', { class: 'uni-none' }, real.length ? 'Nothing matches' : 'Nothing to pick yet'));
      return;
    }
    const o = sel.options[sel.selectedIndex], t = o ? clean(o.textContent).trim() : '';
    const empty = !o || (o.value === '' && /^(choose|select|pick|none)\b/i.test(t));
    const row = el('button', { type: 'button', class: 'uni-row', 'aria-haspopup': 'dialog', disabled: sel.disabled || null, 'aria-label': l ? `${l}: ${t || 'none'}` : null },
      el('span', { class: `uni-text${empty ? ' placeholder' : ''}` }, t || l || 'Choose'), icon('chevright', 18));
    row.addEventListener('click', () => openSheet(sel, row, paint));
    host.append(row);
  };

  // Keep the controls right when code sets .value / .selectedIndex or rebuilds the options.
  for (const prop of ['value', 'selectedIndex']) {
    const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
    Object.defineProperty(sel, prop, { configurable: true, get() { return d.get.call(this); }, set(v) { d.set.call(this, v); paint(); } });
  }
  let queued = false;
  new MutationObserver(() => { if (queued) return; queued = true; queueMicrotask(() => { queued = false; paint(); }); }).observe(sel, { childList: true, subtree: true, attributes: true, characterData: true });
  sel.addEventListener('change', paint);
  sel.form?.addEventListener('reset', () => setTimeout(paint));
  sel.addEventListener('invalid', () => host.querySelector('button')?.focus());
  paint();
}

function openSheet(sel, trigger, onPick) {
  if (openMenu) openMenu.close();
  const where = trigger.closest('dialog') || document.body;
  const opts = flat(sel), count = opts.filter((x) => x.o).length, searchable = count > 9, title = labelOf(sel);
  const list = el('div', { class: 'uni-list', role: 'listbox', tabindex: '-1' });
  const search = searchable ? el('input', { type: 'search', class: 'uni-search', placeholder: 'Search', autocomplete: 'off', 'aria-label': 'Search options', enterkeyhint: 'done' }) : null;
  let items = [], active = -1;

  const draw = (q = '') => {
    list.textContent = ''; items = [];
    const needle = q.trim().toLowerCase(); let lastGroup = null;
    for (const x of opts) {
      if (x.group != null) { lastGroup = x.group; continue; }
      const o = x.o, t = clean(o.textContent);
      if (needle && !t.toLowerCase().includes(needle)) continue;
      if (lastGroup) { list.append(el('div', { class: 'uni-group' }, lastGroup)); lastGroup = null; }
      const on = o.value === sel.value && !o.disabled;
      const indent = (/^[\u2003]+/.exec(t) || [''])[0].length;
      const row = el('button', { type: 'button', role: 'option', class: `uni-opt${on ? ' on' : ''}`, 'aria-selected': on ? 'true' : 'false', disabled: o.disabled, style: indent ? `padding-left:${.9 + indent * .9}rem` : null },
        el('span', {}, t.trim() || 'None'), on ? icon('check', 18) : null);
      row.addEventListener('click', () => pick(o.value));
      items.push(row); list.append(row);
    }
    if (!items.length) list.append(el('div', { class: 'uni-none' }, 'Nothing matches'));
    setActive(Math.max(0, items.findIndex((r) => r.classList.contains('on'))), true);
  };
  const setActive = (i, scroll) => {
    items[active]?.classList.remove('hot'); active = Math.min(items.length - 1, Math.max(0, i));
    const r = items[active]; if (!r) return; r.classList.add('hot'); r.scrollIntoView({ block: scroll ? 'center' : 'nearest' });
  };
  const pick = (v) => { const changed = sel.value !== v; sel.value = v; if (changed) emit(sel); onPick(); close(true); };

  const sheet = el('div', { class: 'uni-sheet' }, el('div', { class: 'uni-grab', 'aria-hidden': 'true' }), title ? el('div', { class: 'uni-title' }, title) : null, search, list);
  const back = el('div', { class: 'uni-back' });
  const root = el('div', { class: `uni-root ${isNarrow() ? 'sheet-mode' : 'center-mode'}` }, back, sheet);
  where.append(root);

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); items[active]?.click(); }
    else if (e.key === 'Tab') close(false);
  };
  const close = (refocus) => {
    if (openMenu?.root !== root) return;
    openMenu = null; document.removeEventListener('keydown', onKey, true);
    root.classList.add('out'); setTimeout(() => root.remove(), 220);
    if (refocus) trigger.focus({ preventScroll: true });
  };
  back.addEventListener('click', () => close(true));
  document.addEventListener('keydown', onKey, true);
  openMenu = { root, close };
  search?.addEventListener('input', () => draw(search.value));
  draw();
  requestAnimationFrame(() => { root.classList.add('in'); (search && !isNarrow() ? search : list).focus({ preventScroll: true }); });
}

function scan(root = document) { root.querySelectorAll?.('select').forEach(enhance); if (root.tagName === 'SELECT') enhance(root); }
scan();
new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) scan(n); }).observe(document.documentElement, { childList: true, subtree: true });
