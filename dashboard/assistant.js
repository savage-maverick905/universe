// Assistant screen: chat, conversation list, settings. DOM built with textContent only.
import { icon } from '/shared/icons.js';
export async function assistantView({ h, api, toast, shell, me }) {
  if (!me.permissions.includes('ai.use')) return shell('assistant', h('div', { class: 'card' }, h('p', {}, 'The assistant is not enabled for your account. Ask an admin.')));
  let profile = (await api('GET', '/api/ai/profile')).profile;
  let convos = (await api('GET', '/api/ai/conversations')).conversations;
  let currentId = null;
  const log = h('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite' });
  const status = h('p', { class: 'err', role: 'alert' });
  const input = h('textarea', { rows: 1, enterkeyhint: 'send', placeholder: `Message ${profile.name}`, 'aria-label': 'Message' });
  const send = h('button', { class: 'btn', 'aria-label': 'Send message' }, icon('send'), h('span', { class: 'lbl' }, 'Send'));
  const select = h('select', { 'aria-label': 'Conversation', onchange: (e) => openConvo(e.target.value || null) });

  const bubble = (m) => {
    if (m.role === 'tool') return null;
    if (m.role === 'assistant' && m.toolCalls?.length) return h('div', { class: 'note' }, `${profile.name} looked something up: ${m.toolCalls.map((c) => c.name).join(', ')}`);
    return h('div', { class: `msg ${m.role}` }, m.content);
  };
  const ask = (text) => { input.value = text; submit(); };
  const emptyState = () => h('div', { class: 'chat-empty' }, h('div', { class: 'orb' }, icon('sparkle')), h('h2', {}, `Say hello to ${profile.name}`), h('p', {}, 'Ask about your apps, or just think out loud.'),
    h('div', { class: 'chips' }, ['What can you help me with?', 'Summarise my inventory'].map((t) => h('button', { type: 'button', class: 'chip', onclick: () => ask(t) }, t))));
  const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 128)}px`; };
  const draw = (messages) => { log.replaceChildren(...(messages.length ? messages.map(bubble) : [emptyState()])); log.scrollTop = log.scrollHeight; };
  const drawList = () => select.replaceChildren(h('option', { value: '' }, 'New chat'), ...convos.map((c) => h('option', { value: c.id, selected: c.id === currentId ? '' : null }, c.title)));
  async function openConvo(id) {
    currentId = id; status.textContent = '';
    draw(id ? (await api('GET', `/api/ai/conversations/${id}`)).messages : []);
    drawList();
  }
  async function refreshList() { convos = (await api('GET', '/api/ai/conversations')).conversations; drawList(); }
  async function submit() {
    const message = input.value.trim(); if (!message || send.disabled) return;
    send.disabled = true; status.textContent = '';
    input.value = ''; grow(); // clear the box straight away; the message now lives in the chat
    log.querySelector('.chat-empty')?.remove();
    log.append(h('div', { class: 'msg user' }, message), h('div', { class: 'msg assistant typing', id: 'thinking', 'aria-label': `${profile.name} is thinking` }, h('i'), h('i'), h('i'))); log.scrollTop = log.scrollHeight;
    try { const r = await api('POST', '/api/ai/chat', { message, conversationId: currentId }); await openConvo(r.conversation.id); await refreshList(); }
    catch (x) { status.textContent = x.message; document.getElementById('thinking')?.remove(); if (!input.value) { input.value = message; grow(); } } // put the text back so nothing is lost
    send.disabled = false;
  }
  send.addEventListener('click', submit);
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });

  const rename = async () => { if (!currentId) return; const t = prompt('Rename conversation', convos.find((c) => c.id === currentId)?.title); if (t) { await api('PATCH', `/api/ai/conversations/${currentId}`, { title: t }); await refreshList(); } };
  const remove = async () => { if (currentId && confirm('Delete this conversation? This cannot be undone.')) { await api('DELETE', `/api/ai/conversations/${currentId}`); currentId = null; await refreshList(); await openConvo(null); } };

  async function settings() {
    const info = await api('GET', '/api/ai/providers');
    const admin = me.permissions.includes('ai.configure_defaults') ? await api('GET', '/api/ai/admin/config') : null;
    const f = (label, el) => h('label', {}, label, el);
    const name = h('input', { value: profile.name, maxlength: 40 }), inst = h('textarea', { rows: 3, maxlength: 2000 }, profile.instructions), prefs = h('textarea', { rows: 2, maxlength: 1000 }, profile.preferences);
    const style = h('select', {}, ['concise', 'balanced', 'detailed'].map((s) => h('option', { value: s, selected: s === profile.style ? '' : null }, s[0].toUpperCase() + s.slice(1))));
    const mode = h('select', {}, [['shared', 'Use the ecosystem key'], ['own', 'Use my own API key']].map(([v, t]) => h('option', { value: v, selected: v === profile.keyMode ? '' : null }, t)));
    const prov = h('select', {}, info.providers.map((p) => h('option', { value: p, selected: p === (profile.provider || info.providers[0]) ? '' : null }, p)));
    const model = h('input', { placeholder: 'Leave empty for the default model', value: profile.model || '' });
    const key = h('input', { type: 'password', autocomplete: 'off', placeholder: profile.hasKey ? `Saved key ending in ${profile.keyLast4}` : 'Paste your API key' });
    const limit = info.shared.dailyLimit > 0 ? ` The shared key may have usage limits: ${info.shared.dailyLimit} messages per day (you have used ${info.shared.usedToday}).` : '';
    const err = h('p', { class: 'err', role: 'alert' });
    const save = async () => { try { const r = await api('PUT', '/api/ai/profile', { name: name.value, instructions: inst.value, preferences: prefs.value, style: style.value, keyMode: mode.value, provider: prov.value, model: model.value || null }); profile = r.profile; input.placeholder = `Message ${profile.name}`; d.close(); toast('Assistant settings saved'); } catch (x) { err.textContent = x.message; } };
    const saveKey = async () => { try { if (!key.value) return; profile = (await api('PUT', '/api/ai/key', { apiKey: key.value, provider: prov.value })).profile; key.value = ''; key.placeholder = `Saved key ending in ${profile.keyLast4}`; toast('Key saved. It is stored encrypted and never shown again.'); } catch (x) { err.textContent = x.message; } };
    const delKey = async () => { try { profile = (await api('DELETE', '/api/ai/key')).profile; mode.value = 'shared'; key.placeholder = 'Paste your API key'; toast('Key removed'); } catch (x) { err.textContent = x.message; } };
    let adminBox = null;
    if (admin) {
      const c = admin.config, ap = h('select', {}, admin.providers.map((p) => h('option', { value: p, selected: p === c.defaultProvider ? '' : null }, p))), am = h('input', { value: c.defaultModel, placeholder: 'Model name from your provider' });
      const en = h('input', { type: 'checkbox', checked: c.sharedKeyEnabled ? '' : null }), lim = h('input', { type: 'number', min: 0, value: c.sharedDailyLimit });
      adminBox = h('details', {}, h('summary', {}, 'Ecosystem defaults (admin)'), h('p', { class: 'sub' }, `Shared key configured for ${c.defaultProvider}: ${admin.sharedKeyConfigured[c.defaultProvider] ? 'yes' : 'no'}. The key itself is set on the server and is never shown.`),
        f('Default provider', ap), f('Default model', am), h('label', {}, en, ' Allow the shared key'), f('Shared messages per user per day (0 = unlimited)', lim),
        h('button', { type: 'button', class: 'btn small', onclick: async () => { try { await api('PUT', '/api/ai/admin/config', { defaultProvider: ap.value, defaultModel: am.value, sharedKeyEnabled: en.checked, sharedDailyLimit: Number(lim.value) }); toast('Defaults saved'); } catch (x) { err.textContent = x.message; } } }, 'Save defaults'));
    }
    const d = h('dialog', {}, h('div', { class: 'sheet' }, h('h2', {}, 'Assistant settings'), f('Name your assistant', name), f('Personality and instructions', inst), f('Response style', style), f('Things it should know about you', prefs),
      h('details', { open: '' }, h('summary', {}, 'AI access'), f('Key to use', mode), h('p', { class: 'sub' }, `The ecosystem key is provided by the server owner.${limit}`),
        f('Provider for my key', prov), f('Model for my key (optional)', model),
        info.canStoreOwnKeys ? [f('My API key', key), h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn ghost small', onclick: saveKey }, 'Save key'), profile.hasKey ? h('button', { type: 'button', class: 'btn ghost small', onclick: delKey }, 'Remove key') : null)] : h('p', { class: 'sub' }, 'This server is not set up to store personal API keys.')),
      adminBox, err, h('div', { class: 'row actions' }, h('button', { class: 'btn', onclick: save }, 'Save settings'), h('button', { class: 'btn ghost', onclick: () => d.close() }, 'Close'))));
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    d.addEventListener('close', () => d.remove()); document.body.append(d); d.showModal();
  }

  shell('assistant', h('section', { class: 'chat' },
    h('div', { class: 'row' }, select, h('button', { class: 'btn ghost small', 'aria-label': 'Rename conversation', onclick: rename }, icon('pencil'), h('span', { class: 'lbl' }, 'Rename')), h('button', { class: 'btn ghost small danger', 'aria-label': 'Delete conversation', onclick: remove }, icon('trash'), h('span', { class: 'lbl' }, 'Delete')), h('button', { class: 'btn ghost small', 'aria-label': 'Assistant settings', onclick: settings }, icon('sliders'), h('span', { class: 'lbl' }, 'Settings'))),
    log, status, h('div', { class: 'composer' }, input, send)));
  drawList(); draw([]);
}
