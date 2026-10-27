// The browser's own replaceChildren/append/prepend turn an ARRAY argument into the text "[object HTMLDivElement]".
// Screens often pass lists of elements (list.map(...)), so flatten arrays and skip null/false for every app that loads this file.
if (typeof Element !== 'undefined' && !Element.prototype.__flatKids) {
  for (const m of ['replaceChildren', 'append', 'prepend']) {
    const native = Element.prototype[m];
    Element.prototype[m] = function (...kids) { return native.apply(this, kids.flat(Infinity).filter((k) => k != null && k !== false)); };
  }
  Element.prototype.__flatKids = true;
}

// Small DOM helpers shared by the dashboard and the apps. Text goes in as text nodes, never innerHTML,
// so data from the server cannot inject markup.
export function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}

// JSON fetch. Errors carry the server's message and the HTTP status.
export async function api(method, path, body, signal) {
  const res = await fetch(path, { signal, method, headers: { 'X-Requested-With': 'universe', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(json?.error?.message || res.statusText || 'Request failed'), { status: res.status, code: json?.error?.code });
  return json;
}

export function toast(msg) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

// Centred dialog on desktop, bottom sheet on phones. Tap outside to close.
export function dialog(title, ...content) {
  const d = h('dialog', {}, h('div', { class: 'sheet' }, h('h2', {}, title), ...content));
  d.addEventListener('close', () => d.remove());
  const plain = d.close.bind(d); d.close = (v) => { if (d.classList.contains('closing') || !d.open) return plain(v); d.classList.add('closing'); setTimeout(() => plain(v), 170); }; // slide out, then really close
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  document.body.append(d); d.showModal();
  return d;
}
// A Close button that closes whichever dialog holds it (so it can be built before the dialog exists).
export const closer = (label = 'Close') => h('button', { type: 'button', class: 'btn ghost', onclick: (e) => e.currentTarget.closest('dialog').close() }, label);

export const initial = (name) => (String(name || '?').trim()[0] || '?').toUpperCase();

// Page-change motion.
// Jupiter keeps its own (legacy) fade-and-rise. Every other app gets a smoother system: the header and tab bar are kept in place between
// screens (only what changed is swapped), the old page dims the instant you tap, a thin bar shows while data loads, and the new page
// slides in from the side you navigated toward (deeper = from the right, back = from the left, same level = a soft rise).
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const root = document.getElementById('app') || document.getElementById('root');
  const legacy = location.pathname.startsWith('/apps/jupiter');
  if (document.documentElement?.dataset) document.documentElement.dataset.motion = legacy ? 'legacy' : 'smooth';
  if (legacy || !root || typeof matchMedia !== 'function' || typeof root.querySelector !== 'function') {
    let t; addEventListener('hashchange', () => { document.body.classList.remove('route-in'); void document.body.offsetWidth; document.body.classList.add('route-in'); clearTimeout(t); t = setTimeout(() => document.body.classList.remove('route-in'), 600); });
  } else {
    const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
    const bar = h('div', { class: 'pg-bar', 'aria-hidden': 'true' });
    document.body.append(bar);
    const depth = (u) => ((u || '').split('#')[1] || '/').split('/').filter(Boolean).length;
    let nav = null, waitTimer;
    const endWait = () => { clearTimeout(waitTimer); bar.classList.remove('on'); root.querySelectorAll('.pg-wait').forEach((m) => m.classList.remove('pg-wait')); };

    addEventListener('hashchange', (e) => {
      const a = depth(e.oldURL), b = depth(e.newURL);
      nav = { dir: b > a ? 'fwd' : b < a ? 'back' : 'tab' };
      if (calm()) return;
      root.querySelector('main.main')?.classList.add('pg-wait'); bar.classList.add('on');
      clearTimeout(waitTimer); waitTimer = setTimeout(() => { endWait(); nav = null; }, 1800); // the tap opened a dialog or the data is slow: stop dimming
    });

    const enter = (main, dir) => {
      if (calm() || !main.animate) return;
      const ease = 'cubic-bezier(.22, .8, .24, 1)';
      if (dir === 'fwd' || dir === 'back') main.animate([{ opacity: 0, transform: `translateX(${dir === 'fwd' ? 26 : -26}px)` }, { opacity: 1, transform: 'none' }], { duration: 300, easing: ease });
      else main.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
      const box = main.querySelector(':scope > .wrap') || main;
      [...box.children].slice(0, 8).forEach((k, i) => k.animate([{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }], { duration: 360, delay: 28 * i, easing: ease, fill: 'backwards' }));
    };

    const key = (n) => `${n.tagName}.${n.className}`;
    const sig = (n) => n.outerHTML.replace(/\s(aria-current|hidden)(="[^"]*")?/g, '');
    const sync = (from, to) => { // copy the bits that change without a rebuild (current tab, hidden Install button)
      const a = [from, ...from.querySelectorAll('*')], b = [to, ...to.querySelectorAll('*')];
      a.forEach((x, i) => { const y = b[i]; if (!y) return; for (const at of ['aria-current', 'hidden']) { if (x.hasAttribute(at)) y.setAttribute(at, x.getAttribute(at)); else y.removeAttribute(at); } });
    };

    root.replaceChildren = function (...kids) {
      kids = kids.flat(Infinity).filter((k) => k != null && k !== false);
      const go = nav, oldMain = root.querySelector(':scope > main.main'), newMain = kids.find((k) => k.matches?.('main.main'));
      nav = null; endWait();
      if (!oldMain || !newMain) { Element.prototype.replaceChildren.apply(root, kids); if (newMain && !calm()) enter(newMain, go?.dir || 'tab'); return; }
      const old = new Map([...root.children].map((o) => [key(o), o])), used = new Set();
      for (const k of kids) {
        const o = old.get(key(k)); used.add(key(k));
        if (!o) root.append(k);
        else if (k === newMain) o.replaceWith(k);
        else if (sig(o) === sig(k)) sync(k, o);
        else o.replaceWith(k);
      }
      for (const [kk, o] of old) if (!used.has(kk)) o.remove();
      if (go) enter(newMain, go.dir);
    };
  }
}
