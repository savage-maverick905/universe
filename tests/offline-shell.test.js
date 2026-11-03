import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APPS, swSource } from '../scripts/sw-shell.js';

test('every app keeps all the files it needs for its offline screens (run `npm run sw` if this fails)', () => {
  for (const [id, base] of APPS) {
    const have = readFileSync(new URL(`..${base}sw.js`, import.meta.url), 'utf8'), version = /version: '([^']+)'/.exec(have)[1];
    assert.equal(have, swSource(id, base, version), `${base}sw.js is out of date: run npm run sw`);
  }
});

test('the service worker never stores API data, and the offline notice reaches every app', () => {
  const core = readFileSync(new URL('../shared/sw-core.js', import.meta.url), 'utf8');
  assert.match(core, /startsWith\('\/api\/'\)\) return/);
  for (const f of ['apps/nova/app.js', 'apps/finance/app.js', 'apps/inventory/app.js', 'dashboard/app.js', 'apps/pulsar/app.js']) assert.match(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), /showOfflineScreen/, f);
});
