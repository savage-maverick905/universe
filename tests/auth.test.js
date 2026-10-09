import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, validatePasswordPolicy } from '../auth/passwords.js';
import { matches, PermissionRegistry } from '../auth/permissions.js';
import { SessionService } from '../auth/sessions.js';
import { canView, viewProfile, defaultVisibility } from '../auth/visibility.js';
import { createStorage } from '../database/storage.js';

test('passwords: hash differs per call, verify works, wrong/malformed fail', async () => {
  const h1 = await hashPassword('a-long-password'); const h2 = await hashPassword('a-long-password');
  assert.notEqual(h1, h2);
  assert.ok(!h1.includes('a-long-password'));
  assert.equal(await verifyPassword('a-long-password', h1), true);
  assert.equal(await verifyPassword('a-long-passworD', h1), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
  assert.equal(await verifyPassword('x', undefined), false);
  assert.throws(() => validatePasswordPolicy('short'));
  assert.doesNotThrow(() => validatePasswordPolicy('long-enough-pw'));
});

test('permission matching and namespace enforcement', () => {
  assert.ok(matches('*', 'anything.at.all'));
  assert.ok(matches('inventory.*', 'inventory.item.read'));
  assert.ok(!matches('inventory.*', 'inventoryx.item.read'));
  assert.ok(!matches('inventory.item.read', 'inventory.item.write'));
  const r = new PermissionRegistry();
  r.register('inventory', ['inventory.item.read']);
  assert.throws(() => r.register('inventory', ['users.manage']));
  assert.ok(r.isValidGrant('inventory.*'));
  assert.ok(!r.isValidGrant('made.up'));
});

test('sessions: opaque token, hashed at rest, expiry, revoke', async () => {
  const st = await createStorage({ driver: 'sqlite', sqlitePath: ':memory:' });
  const svc = new SessionService(st, { ttlHours: 1 });
  const { token, session } = await svc.create('user_1');
  assert.notEqual(session.id, token);
  assert.equal((await svc.validate(token)).userId, 'user_1');
  assert.equal(await svc.validate('x'.repeat(43)), null);
  await svc.col.update(session.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(await svc.validate(token), null);
  const a = await svc.create('user_2'); await svc.create('user_2');
  await svc.destroyAllForUser('user_2', { exceptId: a.session.id });
  assert.equal(await svc.col.count({ userId: 'user_2' }), 1);
  st.close();
});

test('visibility: private by default for bio, shared list respected', () => {
  const owner = { id: 'o', displayName: 'Olu', profile: { avatarUrl: null, bio: 'secret' }, profileVisibility: defaultVisibility() };
  const other = { id: 'x' };
  assert.equal(canView(other, owner, 'bio'), false);
  assert.equal(viewProfile(other, owner).bio, undefined);
  assert.equal(viewProfile(other, owner).displayName, 'Olu');
  owner.profileVisibility.bio = { level: 'shared', sharedWith: ['x'] };
  assert.equal(viewProfile(other, owner).bio, 'secret');
  assert.equal(canView({ id: 'y' }, owner, 'bio'), false);
  assert.equal(canView(owner, owner, 'bio'), true);
});
