import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SEMVER = /^\d+\.\d+\.\d+$/;
const ID = /^[a-z][a-z0-9_-]{1,31}$/;

// Returns a list of problems (empty = valid). Mirrors core/schemas/app-manifest.schema.json
// plus the namespacing rules that keep apps from colliding with each other.
export function validateManifest(m, folder) {
  const e = [];
  if (!m || typeof m !== 'object') return ['manifest is not an object'];
  if (m.manifestVersion !== 1) e.push('manifestVersion must be 1');
  if (!ID.test(m.id || '')) e.push('id is invalid');
  else if (m.id !== folder) e.push(`id "${m.id}" must equal its folder name "${folder}"`);
  for (const k of ['name', 'description', 'entry']) if (typeof m[k] !== 'string' || !m[k]) e.push(`${k} is required`);
  if (!SEMVER.test(m.version || '')) e.push('version must look like 1.0.0');
  if (typeof m.entry === 'string' && (m.entry.includes('..') || m.entry.startsWith('/'))) e.push('entry must be a relative path');
  for (const p of m.permissions || []) if (!String(p).startsWith(`${m.id}.`)) e.push(`permission "${p}" must start with "${m.id}."`);
  for (const r of m.dataResources || []) if (!String(r).startsWith(`${m.id}_`)) e.push(`dataResource "${r}" must start with "${m.id}_"`);
  for (const w of m.widgets || []) {
    if (!['stat', 'list', 'chart'].includes(w.type)) e.push(`widget "${w.id}" has an unknown type`);
    if (!String(w.dataEndpoint || '').startsWith(`/api/apps/${m.id}/`)) e.push(`widget "${w.id}" dataEndpoint must start with /api/apps/${m.id}/`);
    if (w.requiredPermission && !String(w.requiredPermission).startsWith(`${m.id}.`)) e.push(`widget "${w.id}" requiredPermission must be in the app's namespace`);
  }
  for (const t of m.aiTools || []) if (!String(t.name || '').startsWith(`${m.id}.`)) e.push(`aiTool "${t.name}" must start with "${m.id}."`);
  return e;
}

// Discovers apps by scanning apps/*/manifest.json. Nothing is hard-coded.
export class AppRegistry {
  constructor({ appsDir, permissionRegistry, log = console }) {
    this.apps = new Map();
    if (!existsSync(appsDir)) return;
    for (const folder of readdirSync(appsDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const file = join(appsDir, folder.name, 'manifest.json');
      if (!existsSync(file)) continue;
      try {
        const m = JSON.parse(readFileSync(file, 'utf8'));
        const problems = validateManifest(m, folder.name);
        if (problems.length) { log.warn?.(`Skipping app "${folder.name}": ${problems.join('; ')}`); continue; }
        permissionRegistry.register(m.id, m.permissions || []);
        this.apps.set(m.id, m);
      } catch (err) { log.warn?.(`Skipping app "${folder.name}": ${err.message}`); }
    }
  }
  list() { return [...this.apps.values()]; }
  get(id) { return this.apps.get(id) || null; }
}
