import test from 'node:test';
import assert from 'node:assert/strict';
test('intentional required-check enforcement probe; never merge', () => {
  assert.fail('Intentional failure: verify main merge blocking, then close this PR without merging.');
});
