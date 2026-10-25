import { HttpError } from '../shared/errors.js';

// Minimal JSON-schema subset check. Unknown arguments are rejected, so a model cannot slip in
// things like a userId. Identity always comes from the server-side session, never from arguments.
export function validateArgs(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  const props = schema.properties || {};
  for (const k of Object.keys(args)) if (!(k in props)) return `unknown argument: ${k}`;
  for (const r of schema.required || []) if (args[r] === undefined) return `missing argument: ${r}`;
  for (const [k, p] of Object.entries(props)) {
    const val = args[k];
    if (val === undefined) continue;
    if (p.type === 'string') { if (typeof val !== 'string' || val.length > (p.maxLength ?? 200)) return `${k} must be a string of at most ${p.maxLength ?? 200} characters`; }
    else if (p.type === 'integer') { if (!Number.isInteger(val) || val < (p.minimum ?? -1e9) || val > (p.maximum ?? 1e9)) return `${k} must be an integer in range`; }
    else if (p.type === 'boolean') { if (typeof val !== 'boolean') return `${k} must be true or false`; }
    else return `${k} has an unsupported type`;
    if (p.enum && !p.enum.includes(val)) return `${k} must be one of: ${p.enum.join(', ')}`;
  }
  return null;
}

const MAX_RESULT_CHARS = 6000;
const MAX_CLIENT_ACTIONS = 4, MAX_ACTION_CHARS = 12000;

let _drop;
export class ToolRegistry {
  constructor({ installer, permissions, audit, apps }) {
    Object.assign(this, { installer, permissions, audit, apps });
    this.tools = new Map();
  }
  // Core tools define themselves.
  registerCore(def) { this.tools.set(def.name, { ...def, appId: null }); }
  // App tools must be declared in the app's manifest (which supplies access + required permission).
  registerApp(appId, name, { parameters, handler }) {
    const decl = this.apps.get(appId)?.aiTools?.find((t) => t.name === name);
    if (!decl) throw new Error(`Tool "${name}" is not declared in ${appId}/manifest.json`);
    this.tools.set(name, { ...decl, parameters: { type: 'object', additionalProperties: false, required: [], ...parameters }, handler, appId });
  }
  async _allowed(user, t) {
    if (t.appId && !(await this.installer.isActive(t.appId))) return false;
    return this.permissions.can(user, t.requiredPermission);
  }
  // What THIS user's assistant is allowed to even see.
  async available(user) {
    const out = [];
    for (const t of this.tools.values()) if (await this._allowed(user, t)) out.push({ name: t.name, description: t.description, parameters: t.parameters });
    return out;
  }
  // Per-app rules (manifest `aiGuidance`) for every app whose tools this user's assistant can use right now.
  async guidance(user) {
    const ids = new Set();
    for (const t of this.tools.values()) if (t.appId && (await this._allowed(user, t))) ids.add(t.appId);
    return [...ids].map((id) => this.apps.get(id)?.aiGuidance).filter(Boolean);
  }
  // The model only ever *requests* a call. This function decides whether it happens.
  async execute(user, name, rawArgs, services, extra = {}) {
    const t = this.tools.get(name);
    if (!t || !(await this._allowed(user, t))) return { ok: false, error: `Tool "${name}" is not available` };
    let args;
    try { if (String(rawArgs).length > 4000) throw new Error(); args = JSON.parse(rawArgs || '{}'); } catch { return { ok: false, error: 'Arguments were not valid JSON' }; }
    const problem = validateArgs(t.parameters, args);
    if (problem) return { ok: false, error: `Invalid arguments: ${problem}` };
    try {
      if (t.access === 'write') await this.audit.record({ actorId: user.id, action: 'ai.tool.write', meta: { tool: name, args } });
      const out = await t.handler(args, { user, services, ...extra });
      // A tool may ask the BROWSER to do something (e.g. start playing). Those instructions are built server-side from verified data,
      // are capped, and never shown to the model; the browser re-validates them and only runs a fixed set of action types.
      let clientActions = [];
      let shown = out;
      if (out && typeof out === 'object' && Array.isArray(out.clientActions)) {
        clientActions = out.clientActions.slice(0, MAX_CLIENT_ACTIONS).filter((a) => a && typeof a === 'object' && JSON.stringify(a).length <= MAX_ACTION_CHARS);
        ({ clientActions: _drop, ...shown } = out);
      }
      let text = JSON.stringify(shown);
      if (text.length > MAX_RESULT_CHARS) text = JSON.stringify({ truncated: true, partial: text.slice(0, MAX_RESULT_CHARS) });
      return { ok: true, result: JSON.parse(text), clientActions };
    } catch (e) {
      return { ok: false, error: e instanceof HttpError ? e.message : 'The tool failed', code: e instanceof HttpError ? e.code : undefined, appId: t.appId };
    }
  }
}
