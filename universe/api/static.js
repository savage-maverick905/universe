import { readFile, stat } from 'node:fs/promises';
import { resolve, sep, extname, join } from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

// Serves the dashboard, shared assets, and files of ACTIVE apps only.
// Never served: dotfiles, node_modules, and any `server/` folder (put app backend code there).
export async function serveStatic(req, res, url, s) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let p; try { p = decodeURIComponent(url.pathname); } catch { return false; }
  let root, rel;
  if (p === '/' || p === '/dashboard' || p === '/dashboard/') { root = s.paths.dashboard; rel = 'index.html'; }
  else if (p.startsWith('/dashboard/')) { root = s.paths.dashboard; rel = p.slice(11); }
  else if (p.startsWith('/shared/')) { root = s.paths.shared; rel = p.slice(8); }
  else if (p.startsWith('/apps/')) {
    const [id, ...rest] = p.slice(6).split('/');
    if (!(await s.installer.isActive(id))) return false;
    root = join(s.paths.apps, id); rel = rest.join('/') || 'index.html';
  } else return false;
  const parts = rel.split('/');
  if (parts.some((x) => x.startsWith('.') || x === 'server' || x === 'node_modules')) return false;
  const type = TYPES[extname(rel).toLowerCase()];
  const file = resolve(root, rel);
  if (!type || !file.startsWith(resolve(root) + sep)) return false;
  try {
    if (!(await stat(file)).isFile()) return false;
    const data = await readFile(file);
    res.statusCode = 200; res.setHeader('Content-Type', type); res.setHeader('Content-Length', data.length);
    res.end(req.method === 'HEAD' ? undefined : data);
    return true;
  } catch { return false; }
}
