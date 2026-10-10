// Category tree rules. Records refer to categories by ID only, so renaming never breaks history; the display path
// ("Bills & Utilities › Data & Airtime") is computed on read.
export const MAX_DEPTH = 8;
export const KINDS = ['income', 'expense'];

// Editable starter set (copied into each user's own data on first use; nothing is shared between users).
export const STARTER = {
  income: [
    ['Salary & Wages', '💼', '#00ADEF', ['Salary', 'Bonus', 'Allowance']],
    ['Business & Freelance', '🧑‍💻', '#ED6627', ['Client payments', 'Sales', 'Commissions']],
    ['Gifts Received', '🎁', '#B07CFF', []], ['Interest & Returns', '📈', '#3DD68C', []], ['Other Income', '➕', '#A6A6A6', []],
  ],
  expense: [
    ['Food & Dining', '🍲', '#ED6627', ['Groceries', 'Restaurants', 'Snacks & Drinks']],
    ['Transport', '🚌', '#00ADEF', ['Fuel', 'Ride-hailing', 'Public transport']],
    ['Bills & Utilities', '💡', '#F5B93C', ['Data & Airtime', 'Electricity', 'Internet', 'Subscriptions']],
    ['Housing', '🏠', '#3DD68C', ['Rent', 'Repairs & Maintenance']],
    ['Education', '🎓', '#B07CFF', ['Tuition & Fees', 'Books & Materials', 'Courses']],
    ['Health', '🩺', '#E5484D', ['Pharmacy', 'Hospital']],
    ['Shopping', '🛍️', '#FF8CC6', ['Clothing', 'Electronics']],
    ['Business Expenses', '🧰', '#4cc7f5', ['Hosting & Domains', 'Tools & Software', 'Marketing']],
    ['Entertainment', '🎮', '#7BD88F', []], ['Gifts & Giving', '🤝', '#FFAD80', ['Gifts', 'Charity & Tithes']],
    ['Fees & Charges', '🏦', '#A6A6A6', ['Bank charges', 'Transfer fees']], ['Personal Care', '🧴', '#C9A7FF', []], ['Other Expense', '➖', '#707070', []],
  ],
};

export function starterCategories(ownerId, newId, now) {
  const docs = []; let order = 0;
  for (const kind of KINDS) for (const [name, icon, color, subs] of STARTER[kind]) {
    const parent = { id: newId('cat'), ownerId, kind, parentId: null, name, icon, color, sortOrder: order++, archived: false, starter: true, createdAt: now, updatedAt: now };
    docs.push(parent);
    subs.forEach((s, i) => docs.push({ id: newId('cat'), ownerId, kind, parentId: parent.id, name: s, icon: null, color, sortOrder: i, archived: false, starter: true, createdAt: now, updatedAt: now }));
  }
  return docs;
}

export const byId = (cats) => new Map(cats.map((c) => [c.id, c]));
export function pathOf(map, id) {
  if (id == null) return '';
  const names = []; let cur = map.get(id), guard = 0;
  while (cur && guard++ < 50) { names.unshift(cur.name); cur = cur.parentId ? map.get(cur.parentId) : null; }
  return names.join(' › ');
}
export function descendantIds(cats, id) {
  const kids = new Map(); for (const c of cats) if (c.parentId) (kids.get(c.parentId) ?? kids.set(c.parentId, []).get(c.parentId)).push(c.id);
  const out = new Set([id]), stack = [id];
  while (stack.length) for (const k of kids.get(stack.pop()) || []) if (!out.has(k)) { out.add(k); stack.push(k); }
  return out;
}
export function depthOf(map, id) { let d = 0, cur = map.get(id); while (cur && cur.parentId && d < 50) { d++; cur = map.get(cur.parentId); } return d; }
export function subtreeHeight(cats, id) {
  const kids = (x) => cats.filter((c) => c.parentId === x);
  const h = (x, d) => (d > 50 ? 0 : Math.max(0, ...kids(x).map((k) => 1 + h(k.id, d + 1))));
  return h(id, 0);
}

// Returns an error string, or null when `id` may sit under `parentId` with `kind`.
export function parentProblem(cats, { id = null, parentId, kind }) {
  if (!parentId) return null;
  const map = byId(cats), parent = map.get(parentId);
  if (!parent) return 'Parent category not found';
  if (parent.kind !== kind) return 'A subcategory must have the same type (income or expense) as its parent';
  if (parent.archived) return 'Cannot add under an archived category';
  if (id) {
    if (id === parentId || descendantIds(cats, id).has(parentId)) return 'A category cannot be moved under itself or one of its own subcategories';
    if (depthOf(map, parentId) + 1 + subtreeHeight(cats, id) >= MAX_DEPTH) return `Categories can be nested at most ${MAX_DEPTH} levels deep`;
  } else if (depthOf(map, parentId) + 1 >= MAX_DEPTH) return `Categories can be nested at most ${MAX_DEPTH} levels deep`;
  return null;
}
