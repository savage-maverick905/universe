// Usage: npm run export -- backup.json
// Writes every collection (except sessions) to one JSON file. The file contains password hashes and
// encrypted API keys, so treat it as a secret. Stop the server first for a consistent snapshot.
import { writeFileSync } from 'node:fs';
import { loadConfig, loadDotEnv } from '../config/env.js';
import { createStorage } from '../database/storage.js';

const out = process.argv[2];
if (!out) { console.error('Usage: npm run export -- <file.json>'); process.exit(1); }
loadDotEnv();
const storage = await createStorage(loadConfig().storage);
const data = await storage.exportAll();
writeFileSync(out, JSON.stringify(data, null, 2), { mode: 0o600 });
console.log(`Exported ${Object.keys(data.collections).length} collections (${Object.values(data.collections).reduce((n, d) => n + d.length, 0)} documents) to ${out}`);
await storage.close();
