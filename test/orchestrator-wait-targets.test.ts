import test from 'node:test';
import assert from 'node:assert/strict';
import {readTargets} from '../src/orchestrator-wait/targets.js';

const tab = (o: Record<string, unknown>) => ({terminal: 'T1', session: 's', socket: '/s/a.sock', pane: 'w1:p1', agent: 'orch-12', epics: [12], status: 'running', ...o});
const state = (tabs: unknown[]) => JSON.stringify({repo: '/r', tool: 'claude', done: false, plan: {status: 'approved', edges: []}, tabs});

test('readTargets reads active host tabs', () => {
  const r = readTargets(state([
    tab({status: 'running'}), tab({status: 'waiting', pane: 'w1:p2'}), tab({status: 'launching', pane: 'w1:p3'}),
    tab({status: 'cleanup_waiting', pane: 'w1:p4'}), tab({status: 'launch_failed', pane: 'w1:p5'}), tab({status: 'closed', pane: 'w1:p6'}),
  ]));
  assert.deepEqual(r.targets.map(t => t.status), ['running', 'waiting', 'launching', 'cleanup_waiting']);
  assert.equal(r.targets[0]!.key, '/s/a.sock|w1:p1');
  assert.equal(r.targets[0]!.label, 'Epic #12');
  assert.deepEqual(r.targets[0]!.epics, [12]);
  assert.equal(r.boxTabs, 0);
});

test('readTargets labels tabs', () => {
  const r = readTargets(state([tab({epics: [12, 13]}), tab({epics: [], pane: 'w1:p2'}), tab({epics: undefined, pane: 'w1:p3'})]));
  assert.deepEqual(r.targets.map(t => t.label), ['Epic #12 #13', 'terminal T1', 'terminal T1']);
  assert.deepEqual(r.targets[2]!.epics, []);
});

test('readTargets skips box tabs', () => {
  const r = readTargets(state([tab({box: 'scaffold-e12'}), tab({pane: 'w1:p2'})]));
  assert.deepEqual(r.targets.map(t => t.pane), ['w1:p2']);
  assert.equal(r.boxTabs, 1);
});

test('readTargets collects cleanup sockets', () => {
  const r = readTargets(state([tab({previous: [{socket: '/s/old.sock'}, {pane: 'w1:p2'}, {socket: '/s/a.sock'}]})]));
  assert.deepEqual(r.targets[0]!.cleanupSockets, ['/s/a.sock', '/s/old.sock']);
});

test('readTargets skips tabs without socket or pane', () => {
  const r = readTargets(state([tab({socket: undefined}), tab({pane: undefined}), tab({pane: 'w1:p9'})]));
  assert.deepEqual(r.targets.map(t => t.pane), ['w1:p9']);
});

test('readTargets throws on broken JSON', () => {
  assert.throws(() => readTargets('{'));
  assert.throws(() => readTargets(JSON.stringify({tabs: 3})));
});
