// Usage: npm run import -- backup.json [--replace]
// Default "merge" upserts documents by id. "--replace" first empties each collection that is in the file.
import { readFileSync } from 'node:fs';
import { loadConfig, loadDotEnv } from '../config/env.js';
import { createStorage } from '../database/storage.js';

const [file, flag] = process.argv.slice(2);
if (!file) { console.error('Usage: npm run import -- <file.json> [--replace]'); process.exit(1); }
loadDotEnv();
const storage = await createStorage(loadConfig().storage);
const data = JSON.parse(readFileSync(file, 'utf8'));
await storage.importAll(data, { mode: flag === '--replace' ? 'replace' : 'merge' });
console.log(`Imported ${Object.keys(data.collections).length} collections from ${file}`);
await storage.close();
