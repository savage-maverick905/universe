import test from 'node:test';
import assert from 'node:assert/strict';
import { insights, suggest } from '../apps/finance/server/smart.js';

const cats = [{ id: 'c_food', name: 'Food', parentId: null, kind: 'expense' }, { id: 'c_data', name: 'Data', parentId: null, kind: 'expense' }];
const tx = (id, date, amount, o = {}) => ({ id, type: 'expense', status: 'posted', currency: 'NGN', accountId: 'a1', localDate: date, amountMinor: amount * 100, ...o });

test('smart suggestions learn the category you used for similar descriptions', () => {
  const list = [tx('1', '2026-09-01', 3500, { description: 'MTN data', categoryId: 'c_data' }), tx('2', '2026-09-08', 3500, { description: 'MTN Data 2', categoryId: 'c_data' }), tx('3', '2026-09-09', 900, { description: 'Lunch', categoryId: 'c_food' })];
  const s = suggest(list, 'mtn data', 'expense');
  assert.equal(s.categoryId, 'c_data'); assert.equal(s.typicalMinor, 350000); assert.equal(s.count, 2);
  assert.equal(suggest(list, 'zzz unknown', 'expense'), null);
  assert.equal(suggest(list, 'ab', 'expense'), null); // too short to guess
  assert.equal(suggest(list, 'lunch', 'income'), null); // different type
});

test('smart insights: forecast, repeating payments, tidy-up, voided and other-currency rows ignored', () => {
  const list = [
    tx('a', '2026-07-05', 2000, { description: 'Netflix', categoryId: 'c_food' }), tx('b', '2026-08-05', 2000, { description: 'Netflix', categoryId: 'c_food' }), tx('c', '2026-09-05', 2000, { description: 'Netflix', categoryId: 'c_food' }), tx('d', '2026-10-05', 2000, { description: 'Netflix', categoryId: 'c_food' }),
    tx('e', '2026-10-06', 10000, { description: 'Groceries', categoryId: 'c_food' }), tx('f', '2026-10-07', 5000, { description: 'Misc' }),
    tx('v', '2026-10-08', 999999, { description: 'Voided', status: 'voided' }), tx('u', '2026-10-08', 999999, { description: 'Dollars', currency: 'USD' }),
  ];
  const out = insights({ txns: list, cats, accounts: [], budgets: [], today: '2026-10-10', currency: 'NGN' });
  const kinds = out.map((i) => i.kind);
  assert.ok(kinds.includes('forecast') && kinds.includes('subscriptions') && kinds.includes('tidy'));
  const f = out.find((i) => i.kind === 'forecast');
  assert.match(f.title, /₦|NGN/); assert.doesNotMatch(f.detail, /9,999/); // voided and USD rows are not counted
  assert.match(out.find((i) => i.kind === 'subscriptions').detail, /Netflix/);
  assert.deepEqual(insights({ txns: [], cats, accounts: [], budgets: [], today: '2026-10-10', currency: 'NGN' }), []);
});
