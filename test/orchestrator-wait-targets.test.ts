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
  assert.deepEqual(r.errors, []);
});

test('readTargets labels tabs', () => {
  const r = readTargets(state([tab({epics: [12, 13]}), tab({epics: [], pane: 'w1:p2'}), tab({epics: undefined, pane: 'w1:p3'})]));
  assert.deepEqual(r.targets.map(t => t.label), ['Epic #12 #13', 'terminal T1', 'terminal T1']);
  assert.deepEqual(r.targets[2]!.epics, []);
});

test('readTargets reads box tabs', () => {
  const r = readTargets(state([tab({box: 'web-e12-rust', pane: 'w1:p1', socket: '/s/h.sock', agent: '', previous: [{pane: 'w1:p1', socket: '/s/p.sock'}]})]));
  assert.deepEqual(r.errors, []);
  assert.equal(r.targets.length, 1);
  const t = r.targets[0]!;
  assert.equal(t.key, 'box:web-e12-rust|w1:p1');
  assert.equal(t.label, 'Epic #12 box web-e12-rust');
  assert.equal(t.box, 'web-e12-rust');
  assert.equal(t.pane, 'w1:p1');
  assert.deepEqual(t.cleanupSockets, ['/s/h.sock', '/s/p.sock']);
});

test('readTargets labels box tabs without an Epic', () => {
  const r = readTargets(state([tab({box: 'web-e12-rust', epics: []})]));
  assert.equal(r.targets[0]!.label, 'terminal T1 box web-e12-rust');
});

test('readTargets reads box tabs without a host socket', () => {
  const r = readTargets(state([tab({box: 'web-e12-rust', socket: undefined})]));
  assert.equal(r.targets[0]!.socket, '');
  assert.deepEqual(r.targets[0]!.cleanupSockets, []);
});

test('readTargets skips box tabs without pane', () => {
  const r = readTargets(state([tab({box: 'web-e12-rust', pane: ''}), tab({box: 'web-e13-rust', pane: undefined})]));
  assert.deepEqual(r.targets, []);
  assert.deepEqual(r.errors, []);
});

test('readTargets rejects bad box names', () => {
  const bad = ['a;rm -rf ~', '-x', 'A', 'a'.repeat(42), 'x-'];
  const r = readTargets(state([...bad.map(b => tab({box: b})), tab({box: 'sched-daily-1', pane: 'w1:p2'}), tab({box: 'a'.repeat(41), pane: 'w1:p3'})]));
  assert.deepEqual(r.targets.map(t => t.box), ['sched-daily-1', 'a'.repeat(41)]);
  assert.deepEqual(r.errors, bad.map(b => `box name rejected: ${b}`));
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
