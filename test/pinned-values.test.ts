// Values that must never change across the deterministic-scaffold rename: they are baked into existing Epics.
import test from 'node:test';
import assert from 'node:assert/strict';
import {taggedDigest, canonicalJson, sha256Text} from '../src/core/digests.js';
import {MANAGED_START, MANAGED_END} from '../src/core/epic-render.js';

test('taggedDigest input prefix stays "pi-scaffold:<tag>:v1\\n" (workflowId stability)', () => {
  const value = {a: 1, b: ['x']};
  assert.equal(taggedDigest('x', value), sha256Text('pi-scaffold:x:v1\n' + canonicalJson(value)));
  assert.equal(taggedDigest('x', {}), sha256Text('pi-scaffold:x:v1\n{}'));
});

test('Issue managed-block markers stay "<!-- pi-scaffold:v1:start/end -->"', () => {
  assert.equal(MANAGED_START, '<!-- pi-scaffold:v1:start -->');
  assert.equal(MANAGED_END, '<!-- pi-scaffold:v1:end -->');
});
