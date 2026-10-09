import { newId, nowIso } from '../shared/ids.js';

const SENSITIVE = /pass|secret|token|key|hash/i;
const clean = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;
  return Object.fromEntries(Object.entries(obj).map(([k, val]) => [k, SENSITIVE.test(k) ? '[redacted]' : val]));
};

export class AuditLog {
  constructor(storage) {
    this.col = storage.collection('audit_log', { indexes: ['at', 'actorId', 'action'] });
  }
  record({ actorId = null, action, targetType = null, targetId = null, outcome = 'success', meta = {}, ip = null }) {
    return this.col.insert({ id: newId('aud'), at: nowIso(), actorId, action, targetType, targetId, outcome, meta: clean(meta), ip });
  }
  list({ limit = 50, offset = 0, actorId, action } = {}) {
    const where = {};
    if (actorId) where.actorId = actorId;
    if (action) where.action = action;
    return this.col.find({ where, orderBy: { field: 'at', dir: 'desc' }, limit, offset });
  }
}
