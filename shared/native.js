// Native-app feel, shared by every Universe app (imported from pwa.js).
// Page transitions, swipe-to-dismiss sheets, pull-to-refresh, Android back closes sheets,
// haptics, tap-active-tab-to-top, scroll restore, offline pill, launch splash.
const root = document.documentElement;
const touch = matchMedia('(hover: none) and (pointer: coarse)').matches;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) root.classList.add('standalone');
if (touch) root.classList.add('touch');

// ---- Launch splash: removed as soon as the app paints something ----
{
  const sp = document.getElementById('splash');
  if (sp) {
    const host = document.getElementById('app') || document.getElementById('root');
    let done = false;
    const hide = () => { if (done) return; done = true; sp.classList.add('out'); setTimeout(() => sp.remove(), 320); };
    if (host) { if (host.children.length) requestAnimationFrame(hide); else new MutationObserver((_, o) => { if (host.children.length) { o.disconnect(); requestAnimationFrame(hide); } }).observe(host, { childList: true }); }
    setTimeout(hide, 3500);
  }
}

// ---- Haptics (Android; iOS ignores vibrate) ----
const buzz = (ms = 8) => { try { navigator.vibrate?.(ms); } catch { /* unsupported */ } };
if (touch) addEventListener('pointerdown', (e) => { if (e.target.closest?.('button:not(:disabled), .side nav a, .btn, .chip, .uni-chip, .seg button, [role=button], .fab')) buzz(6); }, { passive: true });

// ---- Route transitions + scroll restore ----
const stack = [location.hash]; let idx = 0, dir = 'fwd', navAt = 0; const ys = new Map();
addEventListener('scroll', () => { ys.set(location.hash, scrollY); }, { passive: true });
addEventListener('hashchange', () => {
  const h = location.hash;
  if (stack[idx - 1] === h) { idx--; dir = 'back'; } else if (stack[idx + 1] === h) { idx++; dir = 'fwd'; } else { stack.length = idx + 1; stack.push(h); idx++; dir = 'fwd'; }
  navAt = performance.now();
  if (dir === 'back' && ys.has(h)) { const y = ys.get(h); [60, 160, 340].forEach((t) => setTimeout(() => scrollTo(0, y), t)); }
});
const host = document.getElementById('app') || document.getElementById('root');
if (host && !reduce) {
  let animated = null;
  new MutationObserver(() => {
    if (performance.now() - navAt > 900) return;
    const main = host.querySelector('main'); if (!main || main === animated || !main.animate) return;
    animated = main; navAt = 0;
    const x = dir === 'back' ? -22 : 22;
    main.animate([{ opacity: 0, transform: `translateX(${x}px)` }, { opacity: 1, transform: 'none' }], { duration: 240, easing: 'cubic-bezier(.2,.85,.25,1)' });
  }).observe(host, { childList: true, subtree: true });
}

// ---- Tapping the active tab scrolls to top (like iOS/Android) ----
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('.side nav a[aria-current=page]');
  if (a) { if (scrollY > 0) scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' }); buzz(5); }
});

// ---- Sheets: Android back button closes them, swipe down dismisses ----
{
  const open = [];
  const track = (d) => {
    if (open.includes(d)) return; open.push(d);
    history.pushState({ uniSheet: open.length }, '');
    d.addEventListener('close', () => {
      const i = open.indexOf(d); if (i < 0) return; open.splice(i, 1);
      if (history.state?.uniSheet) { skip++; history.back(); }
    }, { once: true });
  };
  let skip = 0;
  addEventListener('popstate', () => {
    if (skip) { skip--; return; }
    const top = open[open.length - 1]; if (top?.open) top.close();
  });
  new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) if (n.tagName === 'DIALOG') queueMicrotask(() => n.open && track(n)); }).observe(document.body, { childList: true });

  let d = null, y0 = 0, dy = 0, t0 = 0;
  document.addEventListener('touchstart', (e) => {
    d = e.target.closest?.('dialog'); if (!d || innerWidth > 640 || e.touches.length !== 1) { d = null; return; }
    if (e.target.closest('input, textarea, select, [contenteditable], .uni-list')) { d = null; return; }
    const r = d.getBoundingClientRect(), y = e.touches[0].clientY;
    if (d.scrollTop > 0 && y - r.top > 56) { d = null; return; }
    y0 = y; dy = 0; t0 = performance.now(); d.style.transition = 'none';
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!d) return; dy = e.touches[0].clientY - y0;
    if (dy < 0) { dy = 0; } d.style.transform = `translateY(${dy}px)`; d.style.setProperty('--dim', String(Math.max(0, 1 - dy / 400)));
  }, { passive: true });
  const end = () => {
    if (!d) return; const el = d, v = dy / Math.max(1, performance.now() - t0); d = null;
    el.style.transition = 'transform .22s cubic-bezier(.2,.85,.25,1)';
    if (dy > 110 || (dy > 40 && v > 0.6)) { el.style.transform = 'translateY(100%)'; buzz(6); setTimeout(() => { el.style.transform = el.style.transition = ''; el.close(); }, 180); }
    else { el.style.transform = 'none'; setTimeout(() => { el.style.transform = el.style.transition = ''; }, 230); }
  };
  document.addEventListener('touchend', end, { passive: true }); document.addEventListener('touchcancel', end, { passive: true });
}

// ---- Pull to refresh (re-runs the current screen) ----
if (touch) {
  const ind = document.createElement('div'); ind.className = 'ptr'; ind.innerHTML = '<i></i>'; document.body.append(ind);
  let y0 = 0, pull = 0, active = false, busy = false;
  const ok = (t) => !t.closest?.('dialog, input, textarea, select, .uni-list, [data-no-ptr]') && document.body.dataset.page !== 'assistant';
  document.addEventListener('touchstart', (e) => { active = false; if (busy || scrollY > 0 || e.touches.length !== 1 || !ok(e.target) || document.querySelector('dialog[open]')) return; y0 = e.touches[0].clientY; active = true; pull = 0; }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!active) return; const d = e.touches[0].clientY - y0;
    if (d <= 0 || scrollY > 0) { if (pull) { pull = 0; ind.style.transform = ''; ind.style.opacity = 0; } return; }
    pull = Math.min(110, d * 0.5); ind.style.transition = 'none'; ind.style.opacity = Math.min(1, pull / 50);
    ind.style.transform = `translate(-50%, ${pull - 10}px) rotate(${pull * 4}deg)`; ind.classList.toggle('ready', pull > 62);
  }, { passive: true });
  const release = () => {
    if (!active) return; active = false; ind.style.transition = '';
    if (pull > 62) {
      busy = true; ind.classList.add('spin'); ind.style.transform = 'translate(-50%, 52px)'; buzz(10);
      dispatchEvent(new HashChangeEvent('hashchange')); dispatchEvent(new CustomEvent('native:refresh'));
      setTimeout(() => { ind.classList.remove('spin', 'ready'); ind.style.opacity = 0; ind.style.transform = ''; busy = false; }, 900);
    } else { ind.style.opacity = 0; ind.style.transform = ''; }
    pull = 0;
  };
  document.addEventListener('touchend', release, { passive: true }); document.addEventListener('touchcancel', release, { passive: true });
}

// ---- Offline pill ----
{
  const pill = document.createElement('div'); pill.className = 'net-pill'; pill.textContent = 'No connection'; pill.setAttribute('role', 'status'); document.body.append(pill);
  const sync = () => pill.classList.toggle('on', !navigator.onLine);
  addEventListener('online', () => { sync(); }); addEventListener('offline', sync); sync();
}

// ---- Keep the focused field visible above the keyboard ----
addEventListener('focusin', (e) => { const t = e.target; if (touch && t.matches?.('input, textarea, select')) setTimeout(() => t.scrollIntoView?.({ block: 'center', behavior: 'smooth' }), 320); });

// ---- Block native web behaviours that break the illusion ----
document.addEventListener('contextmenu', (e) => { if (touch && !e.target.closest?.('input, textarea, [contenteditable], .selectable')) e.preventDefault(); });
document.addEventListener('dragstart', (e) => { if (e.target.tagName === 'IMG' || e.target.tagName === 'A') e.preventDefault(); });
