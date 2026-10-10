// Nebula inside Orbit. Nebula never saves anything by itself: it prepares a draft, you review it, and only Confirm writes.
import { h, api, toast } from '../lib/api.js';
import { S, field, select, accountOptions, categoryOptions } from '../lib/forms.js';
import { dialog, closer, api as rootApi } from '/shared/ui.js';
import { icon } from '/shared/icons.js';

// The open chat id survives a lock/unlock (and tab reload) so a draft you were reviewing is still there afterwards.
const KEY = 'orbit.chat';
const mem = { get() { try { return sessionStorage.getItem(KEY); } catch { return null; } }, set(v) { try { v ? sessionStorage.setItem(KEY, v) : sessionStorage.removeItem(KEY); } catch { /* storage may be blocked */ } } };
let nameCache = null;
async function assistantName() { if (nameCache) return nameCache; try { nameCache = (await rootApi('GET', '/api/ai/profile')).profile.name || 'Nebula'; } catch { nameCache = 'Nebula'; } return nameCache; }

const EXAMPLES = ['I spent ₦3,500 on data from OPay', 'Salary of ₦250,000 came into my bank today', 'How much did I spend this month?', 'Tunde paid me back ₦2,000'];
const orb = (big) => h('div', { class: big ? 'norb lg' : 'norb', 'aria-hidden': 'true' }, icon('sparkle'));

export async function render({ frame, goto }) {
  const name = await assistantName();
  let chatId = mem.get(), draft = null, busy = false, saving = false, draftEl = null, emptyEl = null;
  const thread = h('div', { class: 'nthread', 'aria-live': 'polite' });
  const input = h('textarea', { rows: 1, maxlength: 1500, placeholder: `Message ${name}…`, 'aria-label': 'Message', enterkeyhint: 'send' });
  const send = h('button', { class: 'nsend', type: 'button', 'aria-label': 'Send', disabled: '' }, icon('send'));
  const scroll = () => requestAnimationFrame(() => thread.lastElementChild?.scrollIntoView({ block: 'end', behavior: 'smooth' }));
  const clearEmpty = () => { emptyEl?.remove(); emptyEl = null; };
  const row = (cls, ...kids) => { clearEmpty(); const r = h('div', { class: `nrow ${cls}` }, ...kids); thread.append(r); scroll(); return r; };
  const say = (who, text, bad = false) => row(who, who === 'bot' ? orb() : null, h('div', { class: bad ? 'nbub bad' : 'nbub' }, text));
  const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 140)}px`; };
  const refreshSend = () => { send.disabled = busy || !input.value.trim(); };

  function showEmpty() {
    emptyEl = h('div', { class: 'nempty' }, orb(true), h('h2', {}, `Hi, I'm ${name}`),
      h('p', {}, 'Tell me what happened with your money in your own words. I prepare a draft for you to review. Nothing is saved until you confirm.'),
      h('div', { class: 'nchips' }, EXAMPLES.map((t) => h('button', { type: 'button', onclick: () => { input.value = t; refreshSend(); submit(); } }, t))));
    thread.append(emptyEl);
  }

  // ---- the draft you review ----
  function showDraft() {
    draftEl?.remove(); draftEl = null; if (!draft) return;
    const lines = draft.lines.map(([k, v]) => h('div', { class: 'line' }, h('span', {}, k), h('b', {}, v)));
    const gaps = [...draft.errors, ...draft.ambiguous.map((a) => `${a.question} ${a.options.join(' / ')}`), ...draft.missing.map((m) => m.question)];
    const err = h('p', { class: 'err', role: 'alert' });
    const confirm = h('button', { class: 'btn primary', type: 'button', disabled: draft.ready ? null : '' }, icon('check'), 'Confirm & save');
    const cancel = h('button', { class: 'btn ghost', type: 'button' }, 'Cancel');
    confirm.addEventListener('click', () => confirmDraft(confirm, err));
    cancel.addEventListener('click', async () => { try { await api('POST', `/assistant/drafts/${chatId}/cancel`, {}); draft = null; showDraft(); say('bot', 'Cancelled. Nothing was saved.'); } catch (e) { if (e.status !== 423) { err.textContent = e.message; toast(e.message); } } });
    draftEl = h('div', { class: 'nrow card' }, h('div', { class: 'ncard draft' },
      h('div', { class: 'ncard-head' }, h('h3', {}, 'Review draft'), h('span', { class: 'badge warn' }, 'Not saved')), lines,
      draft.assumed.length ? h('p', { class: 'fine' }, `Assumed: ${draft.assumed.join(', ')}. Change it if that is wrong.`) : null,
      draft.notes.map((n) => h('p', { class: 'fine' }, n)), draft.warnings.map((n) => h('p', { class: 'fine' }, n)),
      draft.accounting ? h('p', { class: 'rule' }, draft.accounting) : null,
      gaps.length ? h('p', { class: 'err' }, `Still needed: ${gaps.join(' ')}`) : null, err,
      h('div', { class: 'acts' }, h('span', { class: 'primary' }, confirm), h('button', { class: 'btn ghost', type: 'button', onclick: edit }, icon('pencil'), 'Edit'), cancel)));
    thread.append(draftEl); scroll();
  }

  // Re-reads the chat from the server (used when the draft changed underneath us).
  async function resync() {
    try { const r = await api('GET', `/assistant/chats/${chatId}`); draft = r.draft; showDraft(); } catch (e) { if (e.status !== 423) { draft = null; showDraft(); } }
  }

  async function confirmDraft(btn, err) {
    if (saving) return; saving = true; err.textContent = ''; btn.disabled = true; btn.lastChild.textContent = 'Saving…';
    const reset = () => { btn.disabled = false; btn.lastChild.textContent = 'Confirm & save'; };
    try {
      const r = await api('POST', `/assistant/drafts/${chatId}/confirm`, { version: draft.version, confirm: true });
      // Do not just trust "saved": look the record up again so a silent failure can never look like success.
      if (r.result?.kind === 'transaction') { try { await api('GET', `/transactions/${r.result.id}`); } catch (e) { if (e.status === 404) throw new Error('The server said it saved, but I cannot find the transaction. Please check Activity before trying again.'); } }
      draft = null; draftEl?.remove(); draftEl = null;
      draftEl = h('div', { class: 'nrow card' }, h('div', { class: 'ncard ok' }, h('div', { class: 'ncard-head' }, h('h3', {}, 'Saved'), h('span', { class: 'nok' }, icon('check'))),
        r.summary.map((s) => h('p', { class: 'fine', style: 'text-align:left;margin:.15rem 0' }, s)),
        h('div', { class: 'acts' }, h('a', { class: 'btn ghost primary', href: '#/activity' }, 'View in Activity'))));
      thread.append(draftEl); draftEl = null; scroll(); toast('Saved');
    } catch (e) {
      reset();
      if (e.status === 423) return; // Orbit locked: the draft is kept and comes back after you unlock
      err.textContent = `Not saved: ${e.message}`; toast(`Not saved: ${e.message}`);
      if (e.code === 'stale' || e.code === 'no_draft') await resync();
    } finally { saving = false; }
  }

  function edit() {
    const f = draft.fields, type = select([['expense', 'Expense'], ['income', 'Income'], ['transfer', 'Transfer'], ['refund', 'Refund'], ['adjustment', 'Adjustment'], ['lend', 'I lent'], ['borrow', 'I borrowed'], ['repay_received', 'Repayment received'], ['repay_made', 'Repayment made']].map(([value, label]) => ({ value, label })), f.type);
    const amt = h('input', { type: 'text', inputmode: 'decimal', value: draft.amountText || f.amount || '' }), a = select(accountOptions({ blank: 'Choose…' }), draft.resolved.accountId || ''), to = select(accountOptions({ blank: 'Choose…' }), draft.resolved.toAccountId || '');
    const kind = f.type === 'income' ? 'income' : 'expense', cat = select(categoryOptions(kind), draft.resolved.categoryId || ''), date = h('input', { type: 'date', value: f.date && /^\d/.test(f.date) ? f.date : S.today }), desc = h('input', { type: 'text', maxlength: 200, value: f.description || '' }), who = h('input', { type: 'text', maxlength: 100, value: f.counterparty || '' });
    const err = h('p', { class: 'err', role: 'alert' }), save = h('button', { class: 'btn', type: 'submit' }, 'Update draft');
    const d = dialog('Edit draft', h('form', { onsubmit: async (e) => { e.preventDefault(); save.disabled = true; err.textContent = '';
      try { const fields = { type: type.value, amount: amt.value, accountId: a.value, toAccountId: to.value, categoryId: cat.value, date: date.value, description: desc.value, counterparty: who.value }; const r = await api('PATCH', `/assistant/drafts/${chatId}`, { fields, expectedVersion: draft.version }); draft = r.draft; d.close(); showDraft(); } catch (x) { err.textContent = x.message; save.disabled = false; } } },
      field('Type', type), field('Amount', amt), field('Account', a), field('To account (transfers)', to), field('Category', cat), field('Person / payee', who), field('Date', date), field('Description', desc), err, h('div', { class: 'actions row' }, closer('Back'), save)));
  }

  // ---- talking ----
  async function submit() {
    const text = input.value.trim(); if (!text || busy) return;
    busy = true; input.value = ''; grow(); refreshSend(); say('me', text);
    const typing = row('bot', orb(), h('div', { class: 'nbub' }, h('span', { class: 'ndots', 'aria-label': `${name} is typing` }, h('i'), h('i'), h('i'))));
    try {
      const r = await api('POST', '/assistant/chat', { message: text, chatId });
      chatId = r.chatId; mem.set(chatId); draft = r.draft; typing.remove(); say('bot', r.reply);
      if (r.facts) row('card', h('div', { class: 'ncard' }, h('h3', {}, 'Figures from your records'), r.facts.facts.map((x) => h('div', { class: 'line' }, h('span', {}, x.label), h('b', {}, x.value))), r.facts.caveats.map((c) => h('p', { class: 'fine' }, c)), h('p', { class: 'fine' }, 'Calculated by Orbit from recorded transactions, not by the AI.')));
      showDraft();
    } catch (e) { typing.remove(); if (e.status !== 423) say('bot', e.message, true); }
    busy = false; refreshSend(); input.focus();
  }
  const newChat = () => { mem.set(null); goto('#/assistant'); };
  const fine = matchMedia('(pointer: fine)').matches;
  send.addEventListener('click', submit);
  input.addEventListener('input', () => { grow(); refreshSend(); });
  input.addEventListener('keydown', (e) => { if (fine && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }); // on phones Enter adds a new line

  if (chatId) {
    try { const r = await api('GET', `/assistant/chats/${chatId}`); for (const m of r.chat.messages) say(m.role === 'user' ? 'me' : 'bot', m.content); draft = r.draft; showDraft(); }
    catch (e) { if (e.status === 423) return; mem.set(null); chatId = null; }
  }
  if (!thread.children.length) showEmpty();

  frame('assistant',
    h('div', { class: 'nhead' }, orb(), h('div', { class: 'ntitle' }, h('b', {}, name), h('small', {}, 'Your Orbit assistant')),
      h('button', { class: 'btn ghost small', type: 'button', 'aria-label': 'New chat', onclick: newChat }, icon('plus'), h('span', { class: 'lbl' }, 'New chat'))),
    thread,
    h('div', { class: 'ncomposer' }, h('div', { class: 'npill' }, input, send),
      h('p', { class: 'nfine' }, `${name} sees your account and category names, never balances or past transactions. Figures are calculated by Orbit.`)));
  if (thread.querySelector('.nrow')) scroll();
}
