export const B = '/api/apps/inventory';
export function h(tag, props = {}, ...kids) { // textContent only, never innerHTML
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v; else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
export async function api(method, path, body) {
  const res = await fetch(B + path, { method, headers: { 'X-Requested-With': 'universe', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  if (res.status === 401) location.href = '/';
  if (!res.ok) throw new Error(json?.error?.message || res.statusText);
  return json;
}
export function toast(msg) { const t = h('div', { class: 'toast', role: 'status' }, msg); document.body.append(t); setTimeout(() => t.remove(), 2600); }
