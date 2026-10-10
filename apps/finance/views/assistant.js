// The assistant never saves anything by itself: it prepares a draft, you review it, and only the Confirm button writes.
import { h, api, toast } from '../lib/api.js';
import { S, field, select, accountOptions, categoryOptions } from '../lib/forms.js';
import { dialog, closer } from '/shared/ui.js';
import { icon } from '/shared/icons.js';

export async function render({ frame, goto }) {
  let chatId = null, draft = null, busy = false;
  const log = h('div', { class: 'chatlog', 'aria-live': 'polite' }), tray = h('div', {}), input = h('textarea', { rows: 1, maxlength: 1500, placeholder: 'e.g. I spent ₦3,500 on data from OPay', 'aria-label': 'Message' }), send = h('button', { class: 'btn', 'aria-label': 'Send' }, icon('send'));
  const bubble = (who, text) => { log.append(h('div', { class: `bubble ${who}` }, text)); log.scrollTop = log.scrollHeight; };
  bubble('bot', 'Tell me what happened in your own words. I prepare a draft for you to review; nothing is saved until you confirm.');

  function card() {
    tray.replaceChildren(); if (!draft) return;
    const lines = draft.lines.map(([k, v]) => h('div', { class: 'line' }, h('span', {}, k), h('b', {}, v)));
    const gaps = [...draft.errors, ...draft.ambiguous.map((a) => `${a.question} ${a.options.join(' / ')}`), ...draft.missing.map((m) => m.question)];
    const confirm = h('button', { class: 'btn', disabled: draft.ready ? null : '' }, icon('check'), 'Confirm & save'), cancel = h('button', { class: 'btn ghost' }, 'Cancel');
    confirm.addEventListener('click', async () => { confirm.disabled = true; confirm.textContent = 'Saving…';
      try { const r = await api('POST', `/assistant/drafts/${chatId}/confirm`, { version: draft.version, confirm: true }); draft = null; tray.replaceChildren(); bubble('bot', `Saved. ${r.summary.join(' · ')}`); toast('Saved'); }
      catch (e) { confirm.disabled = false; confirm.textContent = 'Confirm & save'; bubble('bot', `Not saved: ${e.message}`); } });
    cancel.addEventListener('click', async () => { await api('POST', `/assistant/drafts/${chatId}/cancel`, {}); draft = null; card(); bubble('bot', 'Cancelled. Nothing was saved.'); });
    tray.append(h('div', { class: 'card draft' }, h('div', { class: 'line' }, h('h3', {}, 'Review draft'), h('span', { class: 'badge warn' }, 'Not saved')), lines,
      draft.assumed.length ? h('p', { class: 'fine' }, `Assumed: ${draft.assumed.join(', ')}. Change it if that is wrong.`) : null, draft.notes.map((n) => h('p', { class: 'fine' }, n)), draft.warnings.map((n) => h('p', { class: 'fine' }, n)),
      draft.accounting ? h('p', { class: 'rule' }, draft.accounting) : null, gaps.length ? h('p', { class: 'err' }, `Still needed: ${gaps.join(' ')}`) : null,
      h('div', { class: 'row' }, confirm, h('button', { class: 'btn ghost', onclick: edit }, icon('pencil'), 'Edit'), cancel)));
  }
  function edit() {
    const f = draft.fields, type = select([['expense', 'Expense'], ['income', 'Income'], ['transfer', 'Transfer'], ['refund', 'Refund'], ['adjustment', 'Adjustment'], ['lend', 'I lent'], ['borrow', 'I borrowed'], ['repay_received', 'Repayment received'], ['repay_made', 'Repayment made']].map(([value, label]) => ({ value, label })), f.type);
    const amt = h('input', { type: 'text', inputmode: 'decimal', value: draft.amountText || f.amount || '' }), a = select(accountOptions({ blank: 'Choose…' }), draft.resolved.accountId || ''), to = select(accountOptions({ blank: 'Choose…' }), draft.resolved.toAccountId || '');
    const kind = f.type === 'income' ? 'income' : 'expense', cat = select(categoryOptions(kind), draft.resolved.categoryId || ''), date = h('input', { type: 'date', value: f.date && /^\d/.test(f.date) ? f.date : S.today }), desc = h('input', { type: 'text', maxlength: 200, value: f.description || '' }), who = h('input', { type: 'text', maxlength: 100, value: f.counterparty || '' });
    const err = h('p', { class: 'err', role: 'alert' }), save = h('button', { class: 'btn', type: 'submit' }, 'Update draft');
    const d = dialog('Edit draft', h('form', { onsubmit: async (e) => { e.preventDefault(); save.disabled = true; err.textContent = '';
      try { const fields = { type: type.value, amount: amt.value, accountId: a.value, toAccountId: to.value, categoryId: cat.value, date: date.value, description: desc.value, counterparty: who.value }; const r = await api('PATCH', `/assistant/drafts/${chatId}`, { fields, expectedVersion: draft.version }); draft = r.draft; d.close(); card(); } catch (x) { err.textContent = x.message; save.disabled = false; } } },
      field('Type', type), field('Amount', amt), field('Account', a), field('To account (transfers)', to), field('Category', cat), field('Person / payee', who), field('Date', date), field('Description', desc), err, h('div', { class: 'actions row' }, closer('Back'), save)));
  }
  async function submit() {
    const text = input.value.trim(); if (!text || busy) return; busy = true; send.disabled = true; input.value = ''; bubble('me', text);
    const wait = h('div', { class: 'bubble bot typing' }, '…'); log.append(wait);
    try { const r = await api('POST', '/assistant/chat', { message: text, chatId }); chatId = r.chatId; draft = r.draft; wait.remove(); bubble('bot', r.reply);
      if (r.facts) tray.replaceChildren(h('div', { class: 'card' }, h('h3', {}, 'Figures from your records'), r.facts.facts.map((x) => h('div', { class: 'line' }, h('span', {}, x.label), h('b', {}, x.value))), r.facts.caveats.map((c) => h('p', { class: 'fine' }, c)), h('p', { class: 'fine' }, 'Calculated by Orbit from recorded transactions, not by the AI.')));
      else card(); }
    catch (e) { wait.remove(); if (e.status !== 423) bubble('bot', e.message); }
    busy = false; send.disabled = false; input.focus();
  }
  send.addEventListener('click', submit); input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
  frame('assistant', h('div', { class: 'page-head' }, h('h1', {}, 'Assistant'), h('button', { class: 'btn ghost small', onclick: () => goto('#/assistant') }, 'New chat')), log, tray, h('div', { class: 'composer' }, input, send),
    h('p', { class: 'fine' }, 'Orbit sends the AI your account and category names, never balances or past transactions. Figures you ask for are calculated by Orbit and sent only as totals.'));
}
