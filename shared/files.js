// Saving and sharing files made in the page (PDF statements, CSV exports, backups, share pictures), in one place.
// In a browser this is the normal download link / Web Share sheet. In the Android app a WebView can do neither
// (blob: downloads do nothing, navigator.share with files is missing), so the bytes go to the native shell in chunks
// and it saves them to Downloads or opens the Android share sheet. See android/.../Files.java.
import { toast } from './ui.js';

const N = () => (typeof window !== 'undefined' ? window.UniverseNative : null);
export const nativeFiles = () => !!N()?.fileBegin;
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
  if (nativeFiles()) { await toNative(blob, name, 'save'); toast(`Saved ${name} to your Downloads folder`); return 'saved'; }
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 8000);
  return 'downloaded';
}

// Opens the system share sheet with the file. Falls back to saving it where sharing files is not possible.
export async function shareFile(data, name, { type, title = '', text = '' } = {}) {
  const blob = asBlob(data, type);
  if (nativeFiles()) { await toNative(blob, name, 'share', { title, text }); return 'shared'; }
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title, text }); return 'shared'; } catch (e) { if (e.name === 'AbortError') return 'cancelled'; } }
  return saveFile(blob, name);
}
export const canShareFiles = () => nativeFiles() || !!navigator.canShare?.({ files: [new File([''], 'x.png', { type: 'image/png' })] });

// Safety net for the Android app: any code that still makes a blob/data link with a download name and clicks it
// (even a link that was never added to the page) goes through saveFile instead of silently doing nothing.
if (typeof HTMLAnchorElement !== 'undefined' && nativeFiles() && !HTMLAnchorElement.prototype.__uniSave) {
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    const href = this.getAttribute('href') || '', name = this.getAttribute('download');
    if (name !== null && /^(blob|data):/.test(href)) {
      fetch(href).then((r) => r.blob()).then((b) => saveFile(b, name || 'download')).catch((e) => toast(e.message || 'Could not save the file'));
      return;
    }
    return click.call(this);
  };
  HTMLAnchorElement.prototype.__uniSave = true;
}
