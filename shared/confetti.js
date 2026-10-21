// A burst of confetti on a full-screen canvas. Draws for about three seconds, then removes itself.
const COLORS = ['#ED6627', '#00ADEF', '#3DD68C', '#F5B93C', '#A78BFA', '#FF8589', '#2DD4BF'];
export function confetti({ count = 150, x = 0.5, y = 0.35 } = {}) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const c = document.createElement('canvas'), dpr = Math.min(2, devicePixelRatio || 1), w = innerWidth, h = innerHeight;
  c.width = w * dpr; c.height = h * dpr; c.setAttribute('aria-hidden', 'true');
  c.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999';
  document.body.append(c); const g = c.getContext('2d'); g.scale(dpr, dpr);
  const ps = Array.from({ length: count }, () => { const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2, v = 6 + Math.random() * 9;
    return { x: w * x, y: h * y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: Math.random() * 6.3, vr: (Math.random() - 0.5) * 0.35, s: 5 + Math.random() * 6, c: COLORS[(Math.random() * COLORS.length) | 0], round: Math.random() < 0.3 }; });
  const t0 = performance.now();
  (function frame(now) {
    const t = now - t0; g.clearRect(0, 0, w, h);
    for (const p of ps) { p.vy += 0.28; p.vx *= 0.992; p.x += p.vx; p.y += p.vy; p.r += p.vr; g.save(); g.globalAlpha = Math.max(0, Math.min(1, (3000 - t) / 700)); g.translate(p.x, p.y); g.rotate(p.r); g.fillStyle = p.c;
      if (p.round) { g.beginPath(); g.arc(0, 0, p.s / 2, 0, 6.3); g.fill(); } else g.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); g.restore(); }
    if (t < 3000) requestAnimationFrame(frame); else c.remove();
  })(t0);
}
