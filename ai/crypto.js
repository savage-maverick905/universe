// AES-256-GCM for stored third-party API keys. The secret lives only in KEY_ENCRYPTION_SECRET (64 hex chars).
// Planned: key rotation (blob is versioned "v1" so a v2 can coexist).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function keyFrom(secret) {
  if (!/^[0-9a-f]{64}$/i.test(secret || '')) throw new Error('KEY_ENCRYPTION_SECRET must be 64 hex characters (32 bytes)');
  return Buffer.from(secret, 'hex');
}
export const canEncrypt = (secret) => /^[0-9a-f]{64}$/i.test(secret || '');
export function encrypt(plain, secret) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}
export function decrypt(blob, secret) {
  const [ver, iv, tag, ct] = String(blob).split(':');
  if (ver !== 'v1' || !ct) throw new Error('Unsupported key format');
  const d = createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
