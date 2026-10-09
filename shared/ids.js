import { randomBytes } from 'node:crypto';
export const newId = (prefix) => `${prefix}_${randomBytes(9).toString('hex')}`;
export const nowIso = () => new Date().toISOString();
