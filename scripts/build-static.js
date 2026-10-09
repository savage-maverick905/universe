// Copies the files a browser may load into dist/ (what Vercel serves from its CDN).
// Server-only code (apps/*/server, the API, the database) stays out of dist/.
import { cpSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const out = 'dist';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync('dashboard', join(out, 'dashboard'), { recursive: true });
cpSync('shared', join(out, 'shared'), { recursive: true });
if (existsSync('apps')) {
  for (const d of readdirSync('apps', { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    cpSync(join('apps', d.name), join(out, 'apps', d.name), {
      recursive: true,
      filter: (src) => !/(^|[\\/])(server|node_modules)([\\/]|$)/.test(src) && !src.endsWith('manifest.json'),
    });
  }
}
console.log('Static files ready in dist/');
