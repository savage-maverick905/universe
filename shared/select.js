// Universe select: replaces every native <select> with a themed picker (bottom sheet on phones, popover on desktop).
// The native <select> stays in the DOM as the source of truth, so existing code that reads `.value` or listens for
// `change` keeps working untouched. Opt out with data-native on a select. Multi-selects are left alone.
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
let openMenu = null;

function enhance(sel) {
  if (sel.multiple || sel.dataset.native != null || sel._uni) return;
  sel._uni = true;
  sel.classList.add('uni-native'); sel.tabIndex = -1; sel.setAttribute('aria-hidden', 'true');

  const text = el('span', { class: 'uni-text' });
  const trigger = el('button', { type: 'button', class: 'uni-select', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' }, text, icon('chevdown', 18));
  sel.before(trigger);

  const label = () => {
    const o = sel.options[sel.selectedIndex];
    const t = o ? clean(o.textContent).trim() : '';
    text.textContent = t || sel.getAttribute('aria-label') || 'Select';
    text.classList.toggle('placeholder', !o || (o.value === '' && /^(choose|select|pick)\b/i.test(t)));
    trigger.disabled = sel.disabled;
    const l = sel.getAttribute('aria-label') || sel.closest('label')?.firstChild?.textContent?.trim();
    if (l) trigger.setAttribute('aria-label', `${l}: ${t}`);
    trigger.classList.toggle('invalid', sel.matches(':invalid') && sel.required);
  };

  // Keep the label right when code sets .value / .selectedIndex or rebuilds the options.
  for (const prop of ['value', 'selectedIndex']) {
    const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
    Object.defineProperty(sel, prop, { configurable: true, get() { return d.get.call(this); }, set(v) { d.set.call(this, v); label(); } });
  }
  new MutationObserver(label).observe(sel, { childList: true, subtree: true, attributes: true, characterData: true });
  sel.addEventListener('change', label);
  sel.form?.addEventListener('reset', () => setTimeout(label));
  // Page-level validation shows its bubble next to the hidden field; send focus to the visible trigger instead.
  sel.addEventListener('invalid', () => trigger.focus());
  label();

  trigger.addEventListener('click', () => open(sel, trigger, label));
  trigger.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); open(sel, trigger, label); }
  });
}

function open(sel, trigger, onPick) {
  if (openMenu) openMenu.close();
  const host = trigger.closest('dialog') || document.body;
  const opts = [...sel.children].flatMap((c) => c.tagName === 'OPTGROUP' ? [{ group: c.label }, ...[...c.children].map((o) => ({ o }))] : [{ o: c }]);
  const count = opts.filter((x) => x.o).length;
  const searchable = count > 9;
  const title = sel.getAttribute('aria-label') || sel.closest('label')?.firstChild?.textContent?.trim() || '';
  const list = el('div', { class: 'uni-list', role: 'listbox', tabindex: '-1' });
  const search = searchable ? el('input', { type: 'search', class: 'uni-search', placeholder: 'Search', autocomplete: 'off', 'aria-label': 'Search options', enterkeyhint: 'done' }) : null;
  let items = [], active = -1;

  const draw = (q = '') => {
    list.textContent = ''; items = [];
    const needle = q.trim().toLowerCase();
    let lastGroup = null;
    for (const x of opts) {
      if (x.group != null) { lastGroup = x.group; continue; }
      const o = x.o, t = clean(o.textContent);
      if (needle && !t.toLowerCase().includes(needle)) continue;
      if (lastGroup) { list.append(el('div', { class: 'uni-group' }, lastGroup)); lastGroup = null; }
      const on = o.value === sel.value && !o.disabled;
      const indent = (/^[\u2003]+/.exec(t) || [''])[0].length;
      const row = el('button', { type: 'button', role: 'option', class: `uni-opt${on ? ' on' : ''}`, 'aria-selected': on ? 'true' : 'false', disabled: o.disabled, style: indent ? `padding-left:${.9 + indent * .9}rem` : null },
        el('span', {}, t.trim() || '—'), on ? icon('check', 18) : null);
      row.addEventListener('click', () => pick(o.value));
      items.push(row); list.append(row);
    }
    if (!items.length) list.append(el('div', { class: 'uni-none' }, 'Nothing matches'));
    setActive(Math.max(0, items.findIndex((r) => r.classList.contains('on'))), true);
  };
  const setActive = (i, scroll) => {
    items[active]?.classList.remove('hot'); active = Math.min(items.length - 1, Math.max(0, i));
    const r = items[active]; if (!r) return; r.classList.add('hot'); if (scroll) r.scrollIntoView({ block: 'center' }); else r.scrollIntoView({ block: 'nearest' });
  };
  const pick = (v) => {
    const changed = sel.value !== v; sel.value = v;
    if (changed) { sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); }
    onPick(); close(true);
  };

  const sheet = el('div', { class: 'uni-sheet' },
    el('div', { class: 'uni-grab', 'aria-hidden': 'true' }),
    title ? el('div', { class: 'uni-title' }, title) : null, search, list);
  const back = el('div', { class: 'uni-back' });
  const root = el('div', { class: 'uni-root' }, back, sheet);
  const narrow = isNarrow();
  root.classList.add(narrow ? 'sheet-mode' : 'pop-mode');
  host.append(root);

  const place = () => {
    if (narrow) return;
    const r = trigger.getBoundingClientRect(), vh = innerHeight, below = vh - r.bottom - 12, above = r.top - 12;
    const flip = below < 240 && above > below, room = Math.max(160, flip ? above : below);
    sheet.style.width = `${Math.max(r.width, 220)}px`; sheet.style.maxHeight = `${Math.min(room, 360)}px`;
    sheet.style.left = `${Math.min(r.left, innerWidth - Math.max(r.width, 220) - 8)}px`;
    if (flip) { sheet.style.top = 'auto'; sheet.style.bottom = `${vh - r.top + 6}px`; } else { sheet.style.bottom = 'auto'; sheet.style.top = `${r.bottom + 6}px`; }
  };

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); items[active]?.click(); }
    else if (e.key === 'Tab') close(false);
    else if (!search && e.key.length === 1) { // type-ahead
      const i = items.findIndex((r, n) => n > active && r.textContent.trim().toLowerCase().startsWith(e.key.toLowerCase())); if (i >= 0) setActive(i);
    }
  };
  const close = (refocus) => {
    if (openMenu?.root !== root) return;
    openMenu = null; document.removeEventListener('keydown', onKey, true); removeEventListener('resize', place);
    trigger.setAttribute('aria-expanded', 'false');
    root.classList.add('out'); setTimeout(() => root.remove(), 140);
    if (refocus) trigger.focus({ preventScroll: true });
  };
  back.addEventListener('click', () => close(true));
  document.addEventListener('keydown', onKey, true); addEventListener('resize', place);
  openMenu = { root, close }; trigger.setAttribute('aria-expanded', 'true');
  search?.addEventListener('input', () => draw(search.value));
  draw(); place();
  requestAnimationFrame(() => { root.classList.add('in'); (search && !narrow ? search : list).focus({ preventScroll: true }); active >= 0 && items[active]?.scrollIntoView({ block: 'center' }); });
}

function scan(root = document) { root.querySelectorAll?.('select').forEach(enhance); if (root.tagName === 'SELECT') enhance(root); }
scan();
new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) scan(n); }).observe(document.documentElement, { childList: true, subtree: true });
