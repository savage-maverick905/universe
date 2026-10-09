// Per-field profile visibility. The same canView() is what AI tools must use later,
// so the AI can never reveal more than the human asking could see directly.
import { v, allowKeys } from '../shared/validate.js';

export const PROFILE_FIELDS = ['displayName', 'avatarUrl', 'bio'];

export const defaultVisibility = () => ({
  displayName: { level: 'public', sharedWith: [] },
  avatarUrl: { level: 'public', sharedWith: [] },
  bio: { level: 'private', sharedWith: [] },
});

export function canView(viewer, owner, field) {
  if (viewer.id === owner.id) return true;
  const rule = owner.profileVisibility?.[field];
  if (!rule) return false;
  if (rule.level === 'public') return true;
  if (rule.level === 'shared') return rule.sharedWith.includes(viewer.id);
  return false;
}

export function viewProfile(viewer, owner) {
  const out = { id: owner.id };
  for (const f of PROFILE_FIELDS) {
    if (canView(viewer, owner, f)) out[f] = f === 'displayName' ? owner.displayName : owner.profile?.[f] ?? null;
  }
  return out;
}

export function validateVisibilityPatch(input) {
  allowKeys(v.object(input), PROFILE_FIELDS, 'visibility');
  const out = {};
  for (const [field, rule] of Object.entries(input)) {
    allowKeys(v.object(rule, field), ['level', 'sharedWith']);
    const level = v.enum(rule.level, `${field}.level`, ['public', 'shared', 'private']);
    out[field] = { level, sharedWith: level === 'shared' ? v.stringArray(rule.sharedWith ?? [], `${field}.sharedWith`, { max: 100 }) : [] };
  }
  return out;
}
