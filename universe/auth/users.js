import { v } from '../shared/validate.js';
import { HttpError } from '../shared/errors.js';
import { newId, nowIso } from '../shared/ids.js';
import { hashPassword, validatePasswordPolicy } from './passwords.js';
import { defaultVisibility } from './visibility.js';

export class UserService {
  constructor({ storage }) {
    this.storage = storage;
    this.col = storage.collection('users', { indexes: ['email', 'roleId', 'status'] });
  }
  // Views: the stored document contains passwordHash and must never be returned directly.
  static account(u) {
    return { id: u.id, email: u.email, displayName: u.displayName, roleId: u.roleId, status: u.status,
      grants: u.grants, denies: u.denies, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt };
  }
  static self(u) {
    return { ...UserService.account(u), profile: u.profile, profileVisibility: u.profileVisibility };
  }
  async getById(id) { return this.col.get(id); }
  async getByEmail(email) { return (await this.col.find({ where: { email }, limit: 1 }))[0] || null; }
  list() { return this.col.find({ orderBy: { field: 'createdAt', dir: 'asc' }, limit: 10000 }); }
  count() { return this.col.count(); }

  async create({ email, displayName, password, roleId }) {
    email = v.email(email);
    displayName = v.string(displayName, 'displayName', { min: 1, max: 80 });
    validatePasswordPolicy(password);
    const passwordHash = await hashPassword(password); // slow; done outside the transaction
    return this.storage.transaction(async () => {
      if (await this.getByEmail(email)) throw new HttpError(409, 'An account with that email already exists', 'email_taken');
      const now = nowIso();
      return this.col.insert({
        id: newId('user'), email, displayName, passwordHash, roleId, status: 'active',
        grants: [], denies: [], profile: { avatarUrl: null, bio: '' }, profileVisibility: defaultVisibility(),
        lastLoginAt: null, passwordChangedAt: now, createdAt: now, updatedAt: now,
      });
    });
  }
  async setPassword(id, password) {
    validatePasswordPolicy(password);
    return this.col.update(id, { passwordHash: await hashPassword(password), passwordChangedAt: nowIso() });
  }
  update(id, patch) { return this.col.update(id, patch); }
}
