// Saving and sharing files made in the page (PDF statements, CSV exports, backups, share pictures), in one place.
// In a browser this is the normal download link / Web Share sheet. In the Android app a WebView can do neither
// (blob: downloads do nothing, navigator.share with files is missing), so the bytes go to the native shell in chunks
// and it saves them to Downloads or opens the Android share sheet. See android/.../Files.java.
import { toast } from './ui.js';

const N = () => (typeof window !== 'undefined' ? window.UniverseNative : null);
export const nativeFiles = () => !!N()?.fileBegin;
// Inside the Android app but the installed APK predates the file bridge: say so instead of doing nothing.
const inApp = () => /UniverseApp\//.test(navigator.userAgent) || !!N();
const OLD_APP = 'Saving and sharing need the newest Android app. Build the APK again on GitHub and install it over this one.';
const b64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(new Error('Could not read the file')); r.readAsDataURL(blob); });
const CHUNK = 3 * 96 * 1024; // a multiple of 3 bytes, so every piece is valid base64 on its own

async function toNative(blob, name, action, { title = '', text = '' } = {}) {
  const n = N(), token = n.fileBegin(name, blob.type || '');
  if (!token) throw new Error('Could not start saving the file');
  try {
    for (let o = 0; o < blob.size; o += CHUNK) if (!n.fileChunk(token, await b64(blob.slice(o, o + CHUNK)))) throw new Error('Saving the file was interrupted');
  } catch (e) { try { n.fileAbort(token); } catch { /* already gone */ } throw e; }
  const r = n.fileEnd(token, action, title, text);
  if (r !== 'ok') throw new Error(r || 'Could not save the file');
}

const asBlob = (data, type) => (data instanceof Blob ? data : new Blob([data], { type: type || 'application/octet-stream' }));

// Saves a file. Android app: into Downloads. Browser: the usual download.
export async function saveFile(data, name, type) {
  const blob = asBlob(data, type);
  if (inApp() && !nativeFiles()) throw new Error(OLD_APP);
  if (nativeFiles()) { await toNative(blob, name, 'save'); toast(`Saved ${name} to your Downloads folder`); return 'saved'; }
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 8000);
  return 'downloaded';
}

// Opens the system share sheet with the file. Falls back to saving it where sharing files is not possible.
export async function shareFile(data, name, { type, title = '', text = '' } = {}) {
  const blob = asBlob(data, type);
  if (inApp() && !nativeFiles()) throw new Error(OLD_APP);
  if (nativeFiles()) { await toNative(blob, name, 'share', { title, text }); return 'shared'; }
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title, text }); return 'shared'; } catch (e) { if (e.name === 'AbortError') return 'cancelled'; } }
  return saveFile(blob, name);
}
export const canShareFiles = () => inApp() || !!navigator.canShare?.({ files: [new File([''], 'x.png', { type: 'image/png' })] });

// Safety net for the Android app: any code that still makes a blob/data link with a download name and clicks it
// (even a link that was never added to the page) goes through saveFile instead of silently doing nothing.
// The file is NOT read back with fetch(): the site's security policy (connect-src) does not allow blob: requests.
// Instead the last few blobs made with URL.createObjectURL are remembered, so the click can find the bytes directly.
const recent = new Map();
const fromDataUrl = (u) => { const m = /^data:([^;,]*)((?:;[^;,]*)*?),(.*)$/s.exec(u); if (!m) return null; const raw = /;base64/.test(m[2]) ? atob(m[3]) : decodeURIComponent(m[3]); return new Blob([Uint8Array.from(raw, (c) => c.charCodeAt(0))], { type: m[1] || 'application/octet-stream' }); };
if (typeof HTMLAnchorElement !== 'undefined' && inApp() && !HTMLAnchorElement.prototype.__uniSave) {
  const make = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (o) => { const u = make(o); if (o instanceof Blob) { recent.set(u, o); while (recent.size > 6) recent.delete(recent.keys().next().value); } return u; };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    const href = this.getAttribute('href') || '', name = this.getAttribute('download');
    if (name !== null && /^(blob|data):/.test(href)) {
      const blob = href.startsWith('blob:') ? recent.get(href) : fromDataUrl(href);
      if (!blob) { toast('Could not save the file. Try again.'); return; }
      saveFile(blob, name || 'download').catch((e) => toast(e.message || 'Could not save the file'));
      return;
    }
    return click.call(this);
  };
  HTMLAnchorElement.prototype.__uniSave = true;
}
