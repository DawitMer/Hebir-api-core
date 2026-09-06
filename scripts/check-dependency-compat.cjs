// Check the CJS API used by transitive consumers of the uuid security override.
// Does not contact Firebase, storage, or any other remote service.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
for (const consumer of ['teeny-request', 'gaxios']) {
  const load = createRequire(require.resolve(consumer));
  const uuid = load('uuid');
  const value = uuid.v4();
  assert.equal(uuid.validate(value), true, consumer);
  assert.equal(uuid.version(value), 4, consumer);
}
require('firebase-admin/app');
require('firebase-admin/auth');
require('firebase-admin/messaging');
require('firebase-admin/storage');
console.log('Firebase entrypoints and CJS uuid consumers: OK');
