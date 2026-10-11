// Orbit inside Universe: the Universe-wide Nebula, the home-screen stats and the reports.
// Everything here needs the Finance PIN, through a separate "hub" unlock (see pin.js). Reads need that unlock.
// WRITES never happen from a model call: Nebula only prepares a draft, and saving needs the PIN typed again, every time.
import { v, allowKeys } from '../../../../shared/validate.js';
import { HttpError, badRequest, conflict, notFound } from '../../../../shared/errors.js';
import { DRAFT_TYPES, mergeFields, resolveDraft, questionsFor } from '../assistant.js';
import { makeAssistantCore } from '../assistantCore.js';
import { makeDebtOps } from '../debtops.js';
import { RANGE_NAMES, namedRange, todayIn } from '../dates.js';
import { formatMoney } from '../money.js';
import { accountBalances, summarize, categoryBreakdown } from '../ledger.js';
import { byId, pathOf } from '../categories.js';
import { debtState } from '../debts.js';

const LOCKED = "I need your Finance PIN before I can look at your money. Enter it below and I'll carry on.";
const NO_PIN = 'You have not created a Finance PIN yet. Open Orbit, create one, then ask me again.';
const chatIdFor = (conversationId) => `chat_hub_${conversationId}`;

export function hubRoutes({ router, s, store, txn, pins, guard, ipLimit, tooMany, P }) {
  const { col, own } = store, debtOps = makeDebtOps(store, txn), core = makeAssistantCore({ store, txn, debtOps });
  const hub = (perm, h, opts = {}) => guard(perm, h, { ...opts, scope: 'hub' });
  const isLocked = (e) => e instanceof HttpError && e.status === 423;

  // Throws a friendly 423 (code locked / no_pin) unless this request carries a valid hub unlock.
  async function requireHub(user, request) {
    const { req, res, session } = request || {};
    try { if (!req) throw new HttpError(423, LOCKED, 'locked'); await pins.authorize(req, res, user, session, 'hub'); }
    catch (e) { if (isLocked(e)) throw new HttpError(423, e.code === 'no_pin' ? NO_PIN : LOCKED, e.code === 'no_pin' ? 'no_pin' : 'locked'); throw e; }
    await store.ensureSetup(user);
  }

  // ---------- unlock / lock / status ----------
  router.add('GET', `${P}/hub/status`, guard('finance.access', async ({ user, req, res, session }) => {
    const st = await pins.status(user.id); let unlocked = false;
    if (st.hasPin) { try { await pins.authorize(req, res, user, session, 'hub'); unlocked = true; } catch (e) { if (!isLocked(e)) throw e; } }
    return { hasPin: st.hasPin, unlocked };
  }, { open: true, setup: false }));
  router.add('POST', `${P}/hub/unlock`, guard('finance.access', async ({ user, body, ip, res, session }) => {
    const b = allowKeys(v.object(body), ['pin']);
    const g = ipLimit.hit(`${ip}:${user.id}`); if (!g.allowed) throw tooMany(g.retryAfterSec);
    await pins.verify(user.id, typeof b.pin === 'string' ? b.pin : '');
    pins.issue(res, user, session, await pins.get(user.id), 'hub');
    return { ok: true, unlocked: true };
  }, { open: true, setup: false }));
  router.add('POST', `${P}/hub/lock`, guard('finance.access', async ({ res }) => { res.setHeader('Set-Cookie', pins.clearCookie('hub')); return { ok: true, unlocked: false }; }, { open: true, setup: false }));

  // ---------- the draft Nebula prepared (kept per conversation, never saved until confirmed with the PIN) ----------
  const draftChat = async (user, conversationId) => {
    await s.ai.orchestrator.ownConvo(user, conversationId); // must be one of YOUR conversations
    return col.chats.get(chatIdFor(conversationId));
  };
  const openDraft = async (user, conversationId) => {
    const c = await draftChat(user, conversationId);
    if (!c || c.ownerId !== user.id || c.draft?.status !== 'open') throw conflict('There is no draft waiting for review.', 'no_draft');
    return c;
  };
  router.add('GET', `${P}/hub/draft/:id`, hub('finance.ai', async ({ user, params }) => {
    const c = await draftChat(user, params.id);
    return { draft: c && c.ownerId === user.id && c.draft?.status === 'open' ? core.viewOf(c.draft, await core.loadCtx(user)) : null };
  }));
  router.add('POST', `${P}/hub/draft/:id/cancel`, hub('finance.ai', async ({ user, params }) => {
    const c = await openDraft(user, params.id); await col.chats.update(c.id, { draft: { ...c.draft, status: 'cancelled' } }); return { ok: true };
  }));
  // Confirming asks for the PIN every single time (this IS the confirmation). It also unlocks Universe for the next questions.
  router.add('POST', `${P}/hub/draft/:id/confirm`, guard('finance.ai', async ({ user, params, body, ip, res, session }) => {
    const b = allowKeys(v.object(body), ['pin', 'version']);
    const g = ipLimit.hit(`${ip}:${user.id}`); if (!g.allowed) throw tooMany(g.retryAfterSec);
    await pins.verify(user.id, typeof b.pin === 'string' ? b.pin : '');
    pins.issue(res, user, session, await pins.get(user.id), 'hub');
    const c = await openDraft(user, params.id), ctx = await core.loadCtx(user);
    if (b.version !== c.draft.version) throw conflict('The draft changed after you reviewed it. Review it again.', 'stale');
    const { result, summary } = await core.confirmDraft(user, c, ctx);
    await col.chats.update(c.id, { draft: { ...c.draft, status: 'confirmed', result } });
    await s.audit.record({ actorId: user.id, action: 'finance.ai_confirm', meta: { via: 'universe', kind: result.kind }, ip });
    return { saved: true, result, summary };
  }, { open: true }));

  // ---------- AI tools (declared in manifest.json) ----------
  const tools = s.aiTools;
  tools?.registerApp('finance', 'finance.query', {
    parameters: { required: ['metric'], properties: { metric: { type: 'string', enum: ['spent', 'earned', 'net', 'balance', 'budget', 'debts'] }, range: { type: 'string', enum: RANGE_NAMES },
      from: { type: 'string', maxLength: 10 }, to: { type: 'string', maxLength: 10 }, category: { type: 'string', maxLength: 120 }, account: { type: 'string', maxLength: 80 } } },
    handler: async (a, { user, request }) => {
      await requireHub(user, request);
      const q = core.runQuery(a, await core.loadCtx(user));
      return q.ok ? { facts: q.facts.map(({ label, value }) => ({ label, value })), caveats: q.caveats, range: q.range } : { error: q.error };
    } });
  tools?.registerApp('finance', 'finance.recent', {
    parameters: { properties: { limit: { type: 'integer', minimum: 1, maximum: 15 }, account: { type: 'string', maxLength: 80 } } },
    handler: async (a, { user, request }) => {
      await requireHub(user, request);
      const ctx = await core.loadCtx(user), C = byId(ctx.cats), A = new Map(ctx.accounts.map((x) => [x.id, x]));
      const want = a.account ? ctx.accounts.filter((x) => x.name.toLowerCase().includes(a.account.toLowerCase())).map((x) => x.id) : null;
      if (want && !want.length) return { error: `No account matching "${a.account}"` };
      const rows = ctx.txns.filter((t) => t.status !== 'voided' && (!want || want.includes(t.accountId)))
        .sort((x, y) => (x.localDate === y.localDate ? (x.createdAt < y.createdAt ? 1 : -1) : x.localDate < y.localDate ? 1 : -1)).slice(0, a.limit || 8);
      return { transactions: rows.map((t) => ({ date: t.localDate, type: t.type, amount: formatMoney(t.amountMinor, t.currency, ctx.settings.customCurrencies), account: A.get(t.accountId)?.name, category: t.categoryId ? pathOf(C, t.categoryId) : null, description: t.description || null, person: t.counterparty || null })) };
    } });
  tools?.registerApp('finance', 'finance.propose', {
    parameters: { required: ['type'], properties: {
      type: { type: 'string', enum: DRAFT_TYPES, description: 'lend = user gave money they expect back; borrow = user received money they must repay; repay_received = someone paid the user back; repay_made = user paid someone back' },
      amount: { type: 'string', maxLength: 30 }, account: { type: 'string', maxLength: 80, description: 'Account named by the user, as they said it' }, to_account: { type: 'string', maxLength: 80 },
      category: { type: 'string', maxLength: 120, description: 'Best matching category name, if clear' }, date: { type: 'string', maxLength: 20, description: 'YYYY-MM-DD, "today" or "yesterday"' },
      time: { type: 'string', maxLength: 5 }, description: { type: 'string', maxLength: 200 }, counterparty: { type: 'string', maxLength: 100, description: 'Person or business paid/received from. Only a name the user gave.' },
      notes: { type: 'string', maxLength: 500 }, tags: { type: 'string', maxLength: 200 }, direction: { type: 'string', enum: ['increase', 'decrease'], description: 'Only for balance adjustments' }, fee: { type: 'string', maxLength: 30 }, start_new: { type: 'string', enum: ['true', 'false'] } } },
    handler: async (a, { user, request, conversationId }) => {
      await requireHub(user, request);
      const ctx = await core.loadCtx(user), id = chatIdFor(conversationId);
      let chat = await col.chats.get(id);
      if (!chat) chat = await col.chats.insert({ id, schemaVersion: 1, ownerId: user.id, title: 'Universe Nebula', messages: [], draft: null, version: 1 });
      const { start_new, to_account, ...rest } = a, patch = { ...rest, ...(to_account !== undefined ? { toAccount: to_account } : {}) };
      const cur = chat.draft, fresh = !cur || cur.status !== 'open' || start_new === 'true';
      const draft = { version: fresh ? (cur?.version || 0) + 1 : cur.version + 1, status: 'open', fields: mergeFields(fresh ? {} : cur.fields, patch) };
      await col.chats.update(chat.id, { draft });
      const r = resolveDraft(draft.fields, ctx);
      // The app, not the model, words the reply, so it can never claim something was saved.
      return { draftPrepared: true, ready: r.ready, final: r.ready ? 'Here is what I understood. Check the card below, then confirm it with your Finance PIN. Nothing is saved until you do.' : (questionsFor(r).join(' ') || 'I need a bit more detail to prepare that.') };
    } });

  // ---------- Universe report ----------
  s.reports?.registerApp('finance', 'finance-overview', { handler: async ({ user, range, request }) => {
    try { await requireHub(user, request); }
    catch (e) { if (isLocked(e)) return { title: 'Orbit', sections: [{ heading: 'Locked', text: e.code === 'no_pin' ? NO_PIN : 'Orbit is locked. Unlock it with your Finance PIN to include your money figures in this report.', gate: 'finance' }] }; throw e; }
    const ctx = await core.loadCtx(user), cur = ctx.settings.currency, fmt = (m, c = cur) => formatMoney(m, c, ctx.settings.customCurrencies);
    const live = ctx.txns.filter((t) => t.status !== 'voided'), bal = accountBalances(ctx.accounts, ctx.txns), C = byId(ctx.cats);
    const sm = summarize(ctx.txns, { range })[cur] || { income: 0, netExpense: 0, net: 0 };
    const bd = categoryBreakdown(ctx.txns, ctx.cats, { kind: 'expense', range, currency: cur });
    const total = ctx.accounts.filter((a) => !a.archived && a.currency === cur).reduce((x, a) => x + (bal.get(a.id) || 0), 0);
    const open = ctx.debts.filter((d) => !d.archived).map((d) => ({ d, st: debtState(d, ctx.txns, ctx.today) })).filter((x) => x.st.status === 'open' && x.d.currency === cur);
    const owed = open.filter((x) => x.d.direction === 'lent').reduce((n, x) => n + x.st.outstandingMinor, 0), owe = open.filter((x) => x.d.direction !== 'lent').reduce((n, x) => n + x.st.outstandingMinor, 0);
    const flat = []; const walk = (n) => { flat.push(n); n.children.forEach(walk); }; bd.roots.forEach(walk);
    const top = bd.roots.slice().sort((x, y) => y.totalMinor - x.totalMinor).slice(0, 8);
    return { title: 'Orbit overview', sections: [
      { heading: 'Money in and out', stats: [{ label: 'Income', value: fmt(sm.income) }, { label: 'Spending (net of refunds)', value: fmt(sm.netExpense) }, { label: 'Net', value: fmt(sm.net) }, { label: 'Total balance now', value: fmt(total) }], text: live.length ? undefined : 'No transactions are recorded yet.' },
      { heading: 'Spending by category', table: { columns: ['Category', 'Amount', 'Share'], rows: top.map((n) => [pathOf(C, n.id), fmt(n.totalMinor), bd.totalMinor ? `${Math.round((n.totalMinor / bd.totalMinor) * 100)}%` : '0%']) } },
      { heading: 'Accounts', table: { columns: ['Account', 'Balance'], rows: ctx.accounts.filter((a) => !a.archived).map((a) => [a.name, fmt(bal.get(a.id) || 0, a.currency)]) } },
      { heading: 'Debts', stats: [{ label: 'Owed to you', value: fmt(owed) }, { label: 'You owe', value: fmt(owe) }] } ] };
  } });

  // ---------- Universe home-screen widget ----------
  router.add('GET', `${P}/widget/summary`, guard('finance.access', async ({ user, req, res, session }) => {
    let ok = false;
    for (const scope of ['orbit', 'hub']) { try { await pins.authorize(req, res, user, session, scope); ok = true; break; } catch (e) { if (!isLocked(e)) throw e; } }
    if (!ok) return { stats: [{ label: 'Orbit', value: 'Locked' }], gate: 'finance' };
    await store.ensureSetup(user);
    const ctx = await core.loadCtx(user), cur = ctx.settings.currency, fmt = (m) => formatMoney(m, cur, ctx.settings.customCurrencies), bal = accountBalances(ctx.accounts, ctx.txns);
    const total = ctx.accounts.filter((a) => !a.archived && a.currency === cur).reduce((x, a) => x + (bal.get(a.id) || 0), 0);
    const m = summarize(ctx.txns, { range: namedRange('this_month', todayIn(ctx.settings.timezone)) })[cur] || { income: 0, netExpense: 0, net: 0 };
    return { stats: [{ label: 'Balance', value: fmt(total) }, { label: 'Income this month', value: fmt(m.income) }, { label: 'Spent this month', value: fmt(m.netExpense) }, { label: 'Net this month', value: fmt(m.net) }] };
  }, { open: true, setup: false }));
}
