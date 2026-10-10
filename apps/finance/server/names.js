// Deterministic name matching, used by the assistant to turn words like "opay" into one of the user's real accounts.
// It never guesses between several candidates: ambiguous input comes back as `candidates` so the user gets asked.
export const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// items: [{ id, names: [string, ...] }]  ->  { match, matchedBy, candidates }
export function matchName(query, items) {
  const q = norm(query);
  if (!q) return { match: null, matchedBy: null, candidates: [] };
  const exact = items.filter((i) => i.names.some((n) => norm(n) === q));
  if (exact.length === 1) return { match: exact[0], matchedBy: 'exact', candidates: [] };
  if (exact.length > 1) return { match: null, matchedBy: null, candidates: exact };
  const part = items.filter((i) => i.names.some((n) => { const x = norm(n); return x && (x.includes(q) || q.includes(x)); }));
  if (part.length === 1) return { match: part[0], matchedBy: 'partial', candidates: [] };
  if (part.length > 1) return { match: null, matchedBy: null, candidates: part };
  const qt = new Set(q.split(' ')), tok = items.filter((i) => i.names.some((n) => norm(n).split(' ').some((w) => w.length > 2 && qt.has(w))));
  if (tok.length === 1) return { match: tok[0], matchedBy: 'partial', candidates: [] };
  return { match: null, matchedBy: null, candidates: tok };
}
