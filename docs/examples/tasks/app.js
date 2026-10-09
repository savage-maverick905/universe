// Frontend of the example. Same rules as everywhere: same-origin fetch, X-Requested-With header, textContent only.
const B = '/api/apps/tasks';
const api = async (method, path, body) => {
  const r = await fetch(B + path, { method, headers: { 'X-Requested-With': 'universe', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) location.href = '/';
  return r.json();
};
const list = document.getElementById('list');
async function draw() {
  const { items } = await api('GET', '/items');
  list.replaceChildren(...items.map((t) => {
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: t.done, onchange: async () => { await api('PATCH', `/items/${t.id}`, { done: box.checked }); draw(); } });
    const del = Object.assign(document.createElement('button'), { className: 'btn ghost small', textContent: 'Delete', onclick: async () => { await api('DELETE', `/items/${t.id}`); draw(); } });
    const li = document.createElement('li'); li.append(box, ' ', t.title, ' ', del); return li;
  }));
}
document.getElementById('f').addEventListener('submit', async (e) => { e.preventDefault(); const i = document.getElementById('t'); await api('POST', '/items', { title: i.value }); i.value = ''; draw(); });
draw();
