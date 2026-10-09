// Vercel entry point. Vercel serves the static files (dashboard, shared, apps) from its CDN and sends every /api/* request here.
// The same API code as `npm start` runs inside this function; there is no server to fall asleep.
//
// How it stays correct without a long-lived process:
//   - before a request: pick up any change someone else saved to GitHub (a cheap conditional request),
//   - before answering:  save this request's changes to GitHub, and only then send the response.
import { loadConfig } from '../config/env.js';
import { createStorage } from '../database/storage.js';
import { createApp } from '../http/server.js';

let booting = null, inflight = 0;

function boot() {
  booting ??= (async () => {
    const config = loadConfig({ ...process.env, NODE_ENV: 'production', TRUST_PROXY: 'true', STORAGE_DRIVER: 'github', GITHUB_SERVERLESS: 'true' });
    const storage = await createStorage(config.storage);
    const app = await createApp({ config, storage, log: console });
    return { app, storage };
  })().catch((e) => { booting = null; throw e; }); // a failed start is retried by the next request
  return booting;
}

const fail = (res, status, code, message) => {
  res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
  res.removeHeader('Content-Length');
  res.end(JSON.stringify({ error: { code, message } }));
};

export default async function handler(req, res) {
  let ctx;
  try { ctx = await boot(); } catch (e) { console.error('Start-up failed:', e.message); return fail(res, 503, 'unavailable', 'The data store could not be reached. Check the GitHub settings.'); }
  const { app, storage } = ctx;

  // While other requests are running in this instance, memory is already current; reloading would swap it from under them.
  if (inflight === 0) {
    try { await storage.refresh(); } catch (e) { console.error('Reload failed:', e.message); return fail(res, 503, 'unavailable', 'Could not read your data from GitHub. Try again in a moment.'); }
  }
  inflight++;

  // Hold the response back until the changes are safely saved.
  const end = res.end.bind(res);
  let finished = false;
  res.end = (...args) => {
    if (finished) return res;
    finished = true;
    storage.flush().then(() => end(...args), (e) => {
      console.error('Save failed:', e.message);
      res.removeHeader('Content-Length'); res.removeHeader('Set-Cookie');
      if (e.conflict) fail(res, 409, 'conflict', 'Your data changed on another device. Nothing was lost; try that again.');
      else fail(res, 503, 'save_failed', 'Could not save to GitHub. Try again in a moment.');
    }).finally(() => { inflight--; });
    return res;
  };
  try { await app.handler(req, res); }
  catch (e) { console.error('Unhandled error:', e); if (!finished) fail(res, 500, 'internal_error', 'Internal server error'); }
}
