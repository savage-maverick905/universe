// Budgets, debts, goals, bills and net worth.
import { h, api, toast, newKey } from '../lib/api.js';
import { S, field, select, accountOptions, categoryOptions, confirmSheet, emptyState, acctName, loadBase } from '../lib/forms.js';
import { money, decimal } from '../lib/fmt.js';
import { progress } from '../lib/charts.js';
import { dialog, closer } from '/shared/ui.js';
import { icon } from '/shared/icons.js';

const TABS = [['budgets', 'Budgets'], ['debts', 'Debts'], ['goals', 'Goals'], ['bills', 'Bills'], ['networth', 'Net worth']];
function form(title, fields, onSubmit, { submit = 'Save', extra = [] } = {}) {
  const err = h('p', { class: 'err', role: 'alert' }), go = h('button', { class: 'btn', type: 'submit' }, submit);
  const d = dialog(title, h('form', { onsubmit: async (e) => { e.preventDefault(); go.disabled = true; err.textContent = ''; try { await onSubmit(); d.close(); } catch (x) { err.textContent = x.message; go.disabled = false; } } }, ...fields, err, h('div', { class: 'actions row' }, closer('Cancel'), ...extra, go)));
  return d;
}
const inp = (props) => h('input', { type: 'text', ...props });
export async function render({ frame, goto, rest }) {
  const tab = rest?.[0] || 'budgets', body = h('div', {});
  const tabs = h('div', { class: 'tabs', role: 'tablist' }, TABS.map(([id, label]) => h('a', { href: `#/plan/${id}`, role: 'tab', 'aria-selected': String(id === tab), class: id === tab ? 'on' : '' }, label)));
  frame('plan', h('div', { class: 'page-head' }, h('h1', {}, 'Plan')), tabs, body);
  const again = () => goto(`#/plan/${tab}`);
  ({ budgets, debts, goals, bills, networth })[tab]?.(body, again);
}

async function budgets(body, again) {
  const { budgets: list, summary } = await api('GET', '/budgets');
  const add = () => form('New budget', (() => { const cat = select(categoryOptions('expense', { blank: 'All spending' }), ''), per = select([{ value: 'monthly', label: 'Monthly' }, { value: 'weekly', label: 'Weekly' }, { value: 'custom', label: 'Custom dates' }], 'monthly'), amt = inp({ inputmode: 'decimal', required: '', placeholder: '0.00' }), from = h('input', { type: 'date' }), to = h('input', { type: 'date' }), roll = h('input', { type: 'checkbox' }), warn = inp({ inputmode: 'numeric', value: '80' });
    add.f = { cat, per, amt, from, to, roll, warn }; return [field('Category', cat), field('Period', per), field('Amount', amt), h('div', { class: 'two' }, field('Starts (custom)', from), field('Ends (custom)', to)), h('label', { class: 'check' }, roll, 'Roll unspent money into the next period'), field('Warn me at (% used)', warn)]; })(),
    async () => { const f = add.f; await api('POST', '/budgets', { categoryId: f.cat.value || null, period: f.per.value, amount: f.amt.value, rollover: f.roll.checked, warnAtPercent: Number(f.warn.value), ...(f.per.value === 'custom' ? { startDate: f.from.value, endDate: f.to.value } : {}) }); toast('Budget added'); again(); });
  body.replaceChildren(h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: add }, icon('plus'), 'Add budget')),
    Object.entries(summary).map(([c, s]) => h('div', { class: 'card' }, h('h3', {}, `Overall (${c})`), h('div', { class: 'line' }, h('span', {}, 'Budgeted'), h('b', {}, money(s.budgetMinor, c))), h('div', { class: 'line' }, h('span', {}, 'Spent'), h('b', {}, money(s.spentMinor, c))), h('div', { class: 'line' }, h('span', {}, 'Left'), h('b', { class: s.remainingMinor < 0 ? 'neg' : 'pos' }, money(s.remainingMinor, c))), h('p', { class: 'fine' }, 'Counts top-level budgets only, so a subcategory budget is never counted twice.'))),
    list.length ? list.map((b) => { const s = b.status; return h('div', { class: 'card' }, h('div', { class: 'line' }, h('h3', {}, b.categoryPath), h('span', { class: `badge ${s.state === 'over' ? 'bad' : s.state === 'warning' ? 'warn' : ''}` }, b.period)),
      h('div', { class: 'line' }, h('span', {}, `${money(s.spentMinor, b.currency)} of ${money(s.availableMinor, b.currency)}`), h('b', { class: s.state }, `${s.percent}%`)), progress(s.percent, s.state),
      h('p', { class: 'fine' }, [`${money(Math.abs(s.remainingMinor), b.currency)} ${s.remainingMinor < 0 ? 'over' : 'left'}`, s.daysLeft ? `${s.daysLeft} days left` : '', s.rolloverMinor ? `incl. ${money(s.rolloverMinor, b.currency)} rolled over` : '', b.status.nestedUnder ? 'within a larger budget' : '', `last period ${money(s.previous.spentMinor, b.currency)}`].filter(Boolean).join(' · ')),
      h('button', { class: 'btn ghost small danger', onclick: () => confirmSheet({ title: 'Delete budget?', message: 'Your transactions are not affected.', danger: true, confirmLabel: 'Delete', onConfirm: async () => { await api('DELETE', `/budgets/${b.id}`); again(); } }) }, icon('trash'), 'Delete')); }) : emptyState('No budgets', 'Set a limit for a category or for all spending.'));
}

async function debts(body, again) {
  const { debts: list, totals } = await api('GET', '/debts?all=true');
  const add = (direction) => { const who = inp({ required: '', maxlength: 100, placeholder: 'Name or organisation' }), amt = inp({ inputmode: 'decimal', required: '' }), acc = select(accountOptions({ blank: 'No cash movement (older debt)' }), S.accounts[0]?.id || ''), due = h('input', { type: 'date' }), note = inp({ maxlength: 500 }), key = newKey();
    form(direction === 'lent' ? 'I lent money' : 'I borrowed money', [h('p', { class: 'rule' }, direction === 'lent' ? 'The money leaves your account and is recorded as owed to you. It is not an expense, and when it is repaid that is not income.' : 'The money arrives in your account and is recorded as owed by you. It is not income, and repaying it is not an expense.'), field(direction === 'lent' ? 'Lent to' : 'Borrowed from', who), field('Amount', amt), field('Account', acc), field('Due date (optional)', due), field('Notes', note)],
      async () => { await api('POST', '/debts', { direction, counterparty: who.value, amount: amt.value, accountId: acc.value || undefined, noCashMovement: !acc.value, dueDate: due.value || undefined, notes: note.value, idempotencyKey: key }); toast('Recorded'); again(); }); };
  const repay = (d) => { const amt = inp({ inputmode: 'decimal', required: '', value: decimal(d.outstandingMinor, d.currency) }), acc = select(accountOptions({ currency: d.currency }), ''), key = newKey();
    form(d.direction === 'lent' ? `${d.counterparty} paid me` : `I paid ${d.counterparty}`, [h('p', { class: 'rule' }, 'Reduces the debt. Not counted as income or expense.'), field('Amount', amt), field('Account', acc)], async () => { await api('POST', `/debts/${d.id}/repayments`, { amount: amt.value, accountId: acc.value, idempotencyKey: key }); toast('Repayment recorded'); again(); }); };
  const open = async (d) => { const r = await api('GET', `/debts/${d.id}`); dialog(d.counterparty, h('p', {}, `${d.direction === 'lent' ? 'They owe you' : 'You owe them'} ${money(r.debt.outstandingMinor, d.currency)} of ${money(d.principalMinor, d.currency)}`), h('ul', { class: 'items' }, r.history.map((x) => h('li', {}, `${x.at} · ${x.kind.replace('_', ' ')} · ${money(x.amountMinor, d.currency)}`, x.note ? h('div', { class: 'sub' }, x.note) : null))), h('div', { class: 'actions row' }, closer('Close'), r.debt.status === 'open' ? h('button', { class: 'btn ghost', onclick: () => confirmSheet({ title: 'Write off?', message: 'Removes the remaining amount from the debt. No money moves, so it is not counted as income or expense.', danger: true, confirmLabel: 'Write off', onConfirm: async () => { await api('POST', `/debts/${d.id}/write-off`, { confirm: true }); again(); } }) }, 'Write off') : null)); };
  body.replaceChildren(h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => add('lent') }, 'I lent'), h('button', { class: 'btn small ghost', onclick: () => add('borrowed') }, 'I borrowed')),
    Object.entries(totals).map(([c, t]) => h('div', { class: 'card' }, h('div', { class: 'line' }, h('span', {}, 'Owed to you'), h('b', { class: 'pos' }, money(t.owedToYouMinor, c))), h('div', { class: 'line' }, h('span', {}, 'You owe'), h('b', { class: 'neg' }, money(t.youOweMinor, c))))),
    list.length ? list.map((d) => h('div', { class: 'card' }, h('div', { class: 'line' }, h('h3', {}, d.counterparty), h('span', { class: `badge ${d.overdue ? 'bad' : d.status === 'open' ? 'warn' : 'off'}` }, d.overdue ? 'overdue' : d.status.replace('_', ' '))), h('p', { class: 'sub' }, `${d.direction === 'lent' ? 'Owes you' : 'You owe'} ${money(d.outstandingMinor, d.currency)} of ${money(d.principalMinor, d.currency)}${d.dueDate ? ` · due ${d.dueDate}` : ''}`), progress(((d.principalMinor - d.outstandingMinor) / d.principalMinor) * 100),
      h('div', { class: 'row' }, d.status === 'open' ? h('button', { class: 'btn small', onclick: () => repay(d) }, 'Record repayment') : null, h('button', { class: 'btn small ghost', onclick: () => open(d) }, 'History')))) : emptyState('No debts', 'Record money you lent or borrowed so repayments are tracked properly.'));
}

async function goals(body, again) {
  const { goals: list } = await api('GET', '/goals');
  const add = () => { const n = inp({ required: '', maxlength: 60 }), t = inp({ inputmode: 'decimal', required: '' }), dl = h('input', { type: 'date' }), a = select(accountOptions({ blank: 'No linked account' }), ''), k = select([{ value: 'goal', label: 'Savings goal' }, { value: 'sinking_fund', label: 'Sinking fund' }], 'goal');
    form('New goal', [field('Name', n), field('Type', k), field('Target amount', t), field('Deadline (optional)', dl), field('Savings account', a)], async () => { await api('POST', '/goals', { name: n.value, kind: k.value, target: t.value, deadline: dl.value || undefined, accountId: a.value || undefined }); again(); }); };
  const contribute = (g) => { const amt = inp({ inputmode: 'decimal', required: '' }), from = select(accountOptions(), ''), to = select(accountOptions({ blank: g.accountId ? 'Linked account' : 'Choose…' }), ''), key = newKey();
    form(`Add to ${g.name}`, [h('p', { class: 'rule' }, 'This is a real transfer between your accounts, tagged to the goal. It is not an expense.'), field('Amount', amt), field('From', from), field('Into', to)], async () => { await api('POST', `/goals/${g.id}/contributions`, { fromAccountId: from.value, toAccountId: to.value || undefined, amount: amt.value, idempotencyKey: key }); again(); }); };
  body.replaceChildren(h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: add }, icon('plus'), 'New goal')), list.length ? list.map((g) => { const p = g.progress; return h('div', { class: 'card' }, h('div', { class: 'line' }, h('h3', {}, g.name), h('b', {}, `${p.percent}%`)), progress(p.percent, p.overdue ? 'over' : 'ok'),
    h('p', { class: 'sub' }, `${money(p.savedMinor, g.currency)} of ${money(g.targetMinor, g.currency)}${g.deadline ? ` by ${g.deadline}` : ''}${p.suggestedMonthlyMinor ? ` · save ${money(p.suggestedMonthlyMinor, g.currency)} a month` : ''}`),
    h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => contribute(g) }, 'Add money'), h('button', { class: 'btn small ghost danger', onclick: () => confirmSheet({ title: 'Archive goal?', message: 'The transactions stay.', onConfirm: async () => { await api('DELETE', `/goals/${g.id}`); again(); } }) }, 'Archive'))); }) : emptyState('No goals', 'Save towards something and track progress from real transfers.'));
}

async function bills(body, again) {
  const { rules, due } = await api('GET', '/recurring');
  const add = () => { const n = inp({ required: '', maxlength: 60 }), amt = inp({ inputmode: 'decimal', required: '' }), acc = select(accountOptions(), ''), cat = select(categoryOptions('expense'), ''), fr = select(['monthly', 'weekly', 'biweekly', 'quarterly', 'yearly', 'daily', 'once'].map((v) => ({ value: v, label: v })), 'monthly'), nd = h('input', { type: 'date', value: S.today, required: '' }), kind = select([{ value: 'bill', label: 'Bill' }, { value: 'subscription', label: 'Subscription' }, { value: 'planned', label: 'Planned expense' }, { value: 'income', label: 'Regular income' }], 'bill');
    form('New bill or plan', [field('Name', n), field('Kind', kind), field('Amount', amt), field('Account', acc), field('Category', cat), field('Repeats', fr), field('Next due', nd)], async () => { await api('POST', '/recurring', { name: n.value, kind: kind.value, amount: amt.value, accountId: acc.value, categoryId: cat.value || null, frequency: fr.value, nextDue: nd.value }); again(); }); };
  const act = (r, o, action) => async () => { try { const x = await api('POST', `/recurring/${r.id}/${action}`, { dueDate: o.dueDate }); toast(action === 'post' ? (x.replayed ? 'Already posted' : 'Posted') : 'Skipped'); again(); } catch (e) { toast(e.message); } };
  body.replaceChildren(h('p', { class: 'fine' }, 'Orbit reminds you here; nothing is posted until you tap Post.'), h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: add }, icon('plus'), 'Add')),
    due.length ? h('div', { class: 'card' }, h('h3', {}, 'Due soon'), due.map((o) => { const r = rules.find((x) => x.id === o.ruleId); return h('div', { class: 'brow' }, h('div', { class: 'line' }, h('span', {}, `${o.name} · ${o.dueDate}`), h('b', { class: o.overdue ? 'neg' : '' }, money(o.amountMinor, o.currency))), h('div', { class: 'row tight' }, h('button', { class: 'btn small', onclick: act(r, o, 'post') }, 'Post'), h('button', { class: 'btn small ghost', onclick: act(r, o, 'skip') }, 'Skip'))); })) : null,
    rules.length ? h('div', { class: 'card' }, h('h3', {}, 'All'), rules.map((r) => h('div', { class: 'line' }, h('span', {}, `${r.name} · ${r.frequency} · next ${r.nextDue}`), h('b', {}, money(r.amountMinor, r.currency))))) : emptyState('Nothing scheduled', 'Add rent, subscriptions or planned expenses.'));
}

async function networth(body, again) {
  const nw = await api('GET', '/networth');
  const add = () => { const n = inp({ required: '', maxlength: 60 }), v = inp({ inputmode: 'decimal', required: '' }), k = select([{ value: 'asset', label: 'Asset (you own it)' }, { value: 'liability', label: 'Liability (you owe it)' }], 'asset');
    form('Add asset or liability', [field('Name', n), field('Type', k), field('Current value', v)], async () => { await api('POST', '/networth/items', { name: n.value, kind: k.value, value: v.value }); again(); }); };
  body.replaceChildren(h('p', { class: 'fine' }, nw.explanation), h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: add }, icon('plus'), 'Add asset / liability')),
    Object.entries(nw.byCurrency).map(([c, x]) => h('div', { class: 'card' }, h('h3', {}, `Net worth (${c})`), h('div', { class: 'big' }, money(x.netWorth, c)), h('div', { class: 'line' }, h('span', {}, 'Assets'), h('b', { class: 'pos' }, money(x.assets, c))), h('div', { class: 'line' }, h('span', {}, 'Liabilities'), h('b', { class: 'neg' }, money(x.liabilities, c))),
      h('details', {}, h('summary', {}, 'What is included'), x.lines.map((l) => h('div', { class: 'line' }, h('span', {}, l.label), h('b', {}, `${l.kind === 'liability' ? '-' : ''}${money(l.minor, c)}`)))))),
    nw.items.length ? h('div', { class: 'card' }, h('h3', {}, 'Your list'), nw.items.map((i) => h('div', { class: 'line' }, h('span', {}, `${i.name} (${i.kind})`), h('span', { class: 'row tight' }, h('b', {}, money(i.valueMinor, i.currency)), h('button', { class: 'btn ghost small', 'aria-label': `Remove ${i.name}`, onclick: async () => { await api('DELETE', `/networth/items/${i.id}`); again(); } }, icon('trash'))))) ) : null);
}
