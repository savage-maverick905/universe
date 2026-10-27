// Video -> audio and trimming, entirely in the browser (nothing is uploaded until you press Upload).
// The browser decodes the sound track, you pick the part to keep, and it is saved as a WAV file the server already accepts.
import { h, dialog, closer, toast } from '../services/api.js';

export const isVideo = (f) => /^video\//.test(f.type) || /\.(mp4|m4v|mov|webm|mkv|3gp|avi)$/i.test(f.name);
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${String(Math.floor((s % 1) * 10))}`;

async function decode(file) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try { return await ctx.decodeAudioData(await file.arrayBuffer()); }
  finally { ctx.close?.(); }
}
function toWav(buf, from, to, mono) {
  const rate = buf.sampleRate, a = Math.floor(from * rate), b = Math.min(buf.length, Math.floor(to * rate)), n = b - a;
  const ch = mono ? 1 : Math.min(2, buf.numberOfChannels), data = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const w = (o, s) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); data.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVEfmt '); data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
  data.setUint32(24, rate, true); data.setUint32(28, rate * ch * 2, true); data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true); w(36, 'data'); data.setUint32(40, n * ch * 2, true);
  const src = [...Array(buf.numberOfChannels).keys()].map((i) => buf.getChannelData(i)); let o = 44;
  for (let i = a; i < b; i++) for (let c = 0; c < ch; c++) {
    const v = mono ? src.reduce((s, d) => s + d[i], 0) / src.length : src[Math.min(c, src.length - 1)][i];
    data.setInt16(o, Math.max(-1, Math.min(1, v)) * 0x7fff, true); o += 2;
  }
  return new Blob([data], { type: 'audio/wav' });
}
function peaks(buf, n) {
  const d = buf.getChannelData(0), step = Math.max(1, Math.floor(d.length / n)), out = [];
  for (let i = 0; i < n; i++) { let m = 0; for (let j = i * step; j < Math.min(d.length, (i + 1) * step); j += Math.max(1, step >> 5)) m = Math.max(m, Math.abs(d[j])); out.push(m); }
  return out;
}

// Opens the trim/convert sheet. Resolves with a new audio File, or null if cancelled. `required` = video (must convert).
export function convertSheet(file, { required = false } = {}) {
  return new Promise((resolve) => {
    let result = null, buf = null, start = 0, end = 0, src = null, aud = null;
    const status = h('p', { class: 'fine muted' }, 'Reading the sound…'), canvas = h('canvas', { width: 600, height: 80, style: 'width:100%;height:80px;border-radius:10px;background:var(--raise)' });
    const s1 = h('input', { type: 'range', min: 0, max: 1000, value: 0, 'aria-label': 'Start' }), s2 = h('input', { type: 'range', min: 0, max: 1000, value: 1000, 'aria-label': 'End' });
    const label = h('p', { class: 'fine' }), mono = h('input', { type: 'checkbox' }), play = h('button', { type: 'button', class: 'btn ghost', disabled: '' }, 'Preview');
    const ok = h('button', { type: 'button', class: 'btn', disabled: '' }, required ? 'Convert to audio' : 'Apply trim');
    const draw = (pk) => { const c = canvas.getContext('2d'), W = canvas.width, H = canvas.height; c.clearRect(0, 0, W, H); const bw = W / pk.length;
      pk.forEach((p, i) => { const t = (i / pk.length) * buf.duration, on = t >= start && t <= end; c.fillStyle = on ? '#7c8cff' : '#8884'; const bh = Math.max(2, p * H * .95); c.fillRect(i * bw, (H - bh) / 2, Math.max(1, bw - 1), bh); }); };
    let pk = [];
    const sync = () => { const a = +s1.value, b = +s2.value; if (a > b - 5) { if (document.activeElement === s1) s1.value = b - 5; else s2.value = a + 5; }
      start = (+s1.value / 1000) * buf.duration; end = (+s2.value / 1000) * buf.duration; label.textContent = `Keeping ${fmt(start)} → ${fmt(end)}  (${fmt(end - start)})`; draw(pk); };
    s1.oninput = s2.oninput = () => buf && sync();
    play.onclick = () => { if (aud) { aud.pause(); aud = null; play.textContent = 'Preview'; return; } aud = new Audio(src); aud.currentTime = start; aud.play(); play.textContent = 'Stop';
      aud.ontimeupdate = () => { if (aud && aud.currentTime >= end) { aud.pause(); aud = null; play.textContent = 'Preview'; } }; };
    ok.onclick = () => { ok.disabled = true; ok.textContent = 'Working…';
      setTimeout(() => { try {
        const blob = toWav(buf, start, end, mono.checked), name = file.name.replace(/\.[^.]+$/, '') + (required ? '' : ' (trimmed)') + '.wav';
        result = new File([blob], name, { type: 'audio/wav' }); d.close();
      } catch (e) { status.textContent = e.message; ok.disabled = false; } }, 30); };
    const d = dialog(required ? 'Convert video to audio' : 'Trim audio', h('p', { class: 'ttl' }, file.name), status, canvas, label,
      h('label', { class: 'fine' }, 'Start'), s1, h('label', { class: 'fine' }, 'End'), s2,
      h('label', { class: 'fine', style: 'display:flex;gap:.5rem;align-items:center' }, mono, 'Mono (half the file size)'),
      h('p', { class: 'fine muted' }, 'Saved as WAV (about 10 MB per minute, 5 MB if mono). Drag the sliders to keep only part.'),
      h('div', { class: 'actions row' }, play, closer('Cancel'), ok));
    d.addEventListener('close', () => { aud?.pause(); if (src) URL.revokeObjectURL(src); resolve(result); });
    decode(file).then((b) => { buf = b; src = URL.createObjectURL(file); end = b.duration; pk = peaks(b, 120); status.textContent = `Length ${fmt(b.duration)}`; play.disabled = ok.disabled = false; sync(); })
      .catch(() => { status.textContent = 'This browser could not read the sound from that file. Try Chrome, or a different format (MP4/MOV with AAC audio works best).'; });
  });
}
