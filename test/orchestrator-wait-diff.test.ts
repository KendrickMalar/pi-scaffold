import test from 'node:test';
import assert from 'node:assert/strict';
import {diffTab} from '../src/orchestrator-wait/diff.js';
import type {TabObs} from '../src/orchestrator-wait/observe.js';
import type {WaitTarget} from '../src/orchestrator-wait/targets.js';

const t = (o: Partial<WaitTarget> = {}): WaitTarget => ({key: '/s/a.sock|w1:p1', label: 'Epic #12', socket: '/s/a.sock', pane: 'w1:p1', epics: [12], status: 'running', cleanupSockets: ['/s/a.sock'], ...o});
const obs = (bodies: Record<string, string>, o: Partial<TabObs> = {}): TabObs => ({gone: false, bodies, working: false, ...o});

test('diffTab reports a body turning blocked', () => {
  assert.deepEqual(diffTab(t(), obs({'w1:p1': 'working'}), obs({'w1:p1': 'blocked'})), ['Epic #12 w1:p1 working->blocked']);
});
test('diffTab reports idle and done', () => {
  assert.deepEqual(diffTab(t(), obs({'w1:p1': 'working'}), obs({'w1:p1': 'idle'})), ['Epic #12 w1:p1 working->idle']);
  assert.deepEqual(diffTab(t(), obs({'w1:p1': 'blocked'}), obs({'w1:p1': 'done'})), ['Epic #12 w1:p1 blocked->done']);
});
test('diffTab stays quiet for idle->done and unchanged states', () => {
  assert.deepEqual(diffTab(t(), obs({'w1:p1': 'idle'}), obs({'w1:p1': 'done'})), []);
  assert.deepEqual(diffTab(t(), obs({'w1:p1': 'blocked'}), obs({'w1:p1': 'blocked'})), []);
  assert.deepEqual(diffTab(t(), obs({'w1:p1': 'blocked'}), obs({'w1:p1': 'working'})), []);
});
test('diffTab reports a new stage pane', () => {
  assert.deepEqual(diffTab(t(), obs({'w1:p1': 'done'}), obs({'w1:p1': 'done', 'w2:p1': 'blocked'})), ['Epic #12 w2:p1 new->blocked']);
  assert.deepEqual(diffTab(t(), obs({'w1:p1': 'done'}), obs({'w1:p1': 'done', 'w2:p1': 'working'})), []);
});
test('diffTab on a new tab wakes only for blocked or gone', () => {
  assert.deepEqual(diffTab(t(), undefined, obs({'w1:p1': 'blocked'})), ['Epic #12 w1:p1 new->blocked']);
  assert.deepEqual(diffTab(t(), undefined, obs({'w1:p1': 'working'})), []);
  assert.deepEqual(diffTab(t(), undefined, obs({'w1:p1': 'idle'})), []);
  assert.deepEqual(diffTab(t(), undefined, obs({}, {gone: true})), ['Epic #12 pane w1:p1 gone']);
});
test('diffTab reports gone once', () => {
  assert.deepEqual(diffTab(t(), obs({'w1:p1': 'working', 'w2:p1': 'working'}), obs({}, {gone: true})), ['Epic #12 pane w1:p1 gone']);
  assert.deepEqual(diffTab(t(), obs({}, {gone: true}), obs({}, {gone: true})), []);
});
test('diffTab reports a vanished stage pane', () => {
  assert.deepEqual(diffTab(t(), obs({'w1:p1': 'done', 'w2:p1': 'working'}), obs({'w1:p1': 'done'})), ['Epic #12 w2:p1 gone']);
});
test('diffTab reports cleanup progress only for cleanup_waiting', () => {
  const c = t({status: 'cleanup_waiting'});
  assert.deepEqual(diffTab(c, obs({'w1:p1': 'done'}, {working: true}), obs({'w1:p1': 'done'})), ['Epic #12 cleanup: no working agent']);
  assert.deepEqual(diffTab(t(), obs({'w1:p1': 'done'}, {working: true}), obs({'w1:p1': 'done'})), []);
});
