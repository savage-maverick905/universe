// Streams a track to the browser with HTTP Range support, one stored part at a time, so a whole file is never held in memory and every
// response stays under Vercel's 4.5 MB limit. A request for `bytes=0-` is answered with a 206 for the first window; the browser simply asks for the next one.
import { HttpError } from '../../../shared/errors.js';
import { IMAGE_MIME } from './audio.js';

export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).split(',')[0].trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'bad';
  let start, end;
  if (m[1] === '') { const n = Number(m[2]); if (!n) return 'bad'; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Number(m[2]); }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'bad';
  return { start, end: Math.min(end, size - 1) };
}

export async function streamAudio({ req, res, track, media }) {
  const size = track.size, P = track.partSize;
  const range = parseRange(req.headers.range, size);
  if (range === 'bad') { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${size}`); res.setHeader('Cache-Control', 'no-store'); res.end(); return { __handled: true }; }
  let start = 0, end = size - 1, status = 200;
  if (range) { ({ start, end } = range); status = 206; }
  const first = Math.floor(start / P);
  // One part per response. Small tracks (a single part) with no Range header get a plain 200.
  const partEnd = (first + 1) * P - 1;
  if (end > partEnd) { end = partEnd; status = 206; }
  const part = track.parts[first];
  if (!part) throw new HttpError(404, 'This track\'s audio is missing from storage.', 'audio_missing');
  let blob;
  try { blob = await media.getBlob(part.ref); }
  catch (e) { throw e.missing ? new HttpError(404, 'This track\'s audio is missing from storage.', 'audio_missing') : new HttpError(502, 'Could not read the audio from storage right now. Try again.', 'storage_unavailable'); }
  const body = blob.subarray(start - first * P, end - first * P + 1);
  res.statusCode = status;
  res.setHeader('Content-Type', track.mime); res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Content-Length', body.length);
  if (status === 206) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.setHeader('Cache-Control', 'private, max-age=3600'); res.setHeader('Vary', 'Cookie, Range'); res.setHeader('ETag', `"${track.contentHash.slice(0, 32)}"`);
  res.setHeader('Content-Disposition', 'inline');
  if (req.method === 'HEAD') res.end(); else res.end(body);
  return { __handled: true };
}

export async function streamArt({ res, media, key }) {
  const buf = await media.readFile(`art/${key}`);
  if (!buf) throw new HttpError(404, 'Artwork not found', 'not_found');
  res.statusCode = 200; res.setHeader('Content-Type', IMAGE_MIME[key.split('.').pop()] || 'application/octet-stream'); res.setHeader('Content-Length', buf.length);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable'); res.setHeader('Vary', 'Cookie');
  res.end(buf);
  return { __handled: true };
}
