import assert from 'node:assert/strict';
import test from 'node:test';
import { canAccessCollection } from '../dist/auth/collection-access.js';

test('collection access denies editor reads and writes when administrator is required', () => {
  const protectedCollection = { access: { read: 'admin', create: 'admin', update: 'admin', delete: 'admin' } };
  for (const operation of ['read', 'create', 'update', 'delete']) {
    assert.equal(canAccessCollection(protectedCollection, { role: 'editor' }, operation), false);
    assert.equal(canAccessCollection(protectedCollection, { role: 'admin' }, operation), true);
  }
  assert.equal(canAccessCollection({}, { role: 'editor' }, 'read'), true);
});
