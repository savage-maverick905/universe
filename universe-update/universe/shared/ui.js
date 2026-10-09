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
export async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { 'X-Requested-With': 'universe', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
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
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  document.body.append(d); d.showModal();
  return d;
}
// A Close button that closes whichever dialog holds it (so it can be built before the dialog exists).
export const closer = (label = 'Close') => h('button', { type: 'button', class: 'btn ghost', onclick: (e) => e.currentTarget.closest('dialog').close() }, label);

export const initial = (name) => (String(name || '?').trim()[0] || '?').toUpperCase();
