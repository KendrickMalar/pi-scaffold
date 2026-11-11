import test from 'node:test';
import assert from 'node:assert/strict';
import {observe, stageTabPattern} from '../src/orchestrator-wait/observe.js';
import {FakeReader, pane, target} from './orchestrator-wait-fakes.js';

test('observe marks gone when socket missing', async () => {
  const f = new FakeReader();
  const o = await observe([target()], f);
  assert.equal(o.tabs.get('/s/a.sock|w1:p1')!.gone, true);
  assert.deepEqual(o.errors, []);
});

test('observe marks gone when pane missing or has no agent', async () => {
  const f = new FakeReader();
  f.panesBySocket.set('/s/a.sock', [pane({paneId: 'w1:p2', agent: undefined, status: undefined})]);
  const o = await observe([target(), target({pane: 'w1:p2'})], f);
  assert.equal(o.tabs.get('/s/a.sock|w1:p1')!.gone, true);
  assert.equal(o.tabs.get('/s/a.sock|w1:p2')!.gone, true);
});

test('observe collects stage tab bodies', async () => {
  const f = new FakeReader();
  f.panesBySocket.set('/s/a.sock', [
    pane({paneId: 'w1:p1', status: 'done'}),
    pane({paneId: 'w2:p1', status: 'blocked', tabLabel: 'design-e12-r1'}),
    pane({paneId: 'w3:p1', status: 'blocked', tabLabel: 'impl-mgr-f40'}),
    pane({paneId: 'w4:p1', status: 'idle', tabLabel: 'spec-e99'}),
  ]);
  const o = await observe([target()], f);
  assert.deepEqual(o.tabs.get('/s/a.sock|w1:p1'), {gone: false, bodies: {'w1:p1': 'done', 'w2:p1': 'blocked'}, working: false});
});

test('observe keeps sessions apart', async () => {
  const f = new FakeReader();
  f.panesBySocket.set('/s/a.sock', [pane({socket: '/s/a.sock', status: 'blocked'})]);
  f.panesBySocket.set('/s/b.sock', [pane({socket: '/s/b.sock', status: 'working'})]);
  const o = await observe([target(), target({socket: '/s/b.sock', label: 'Epic #13', epics: [13]})], f);
  assert.equal(o.tabs.get('/s/a.sock|w1:p1')!.bodies['w1:p1'], 'blocked');
  assert.equal(o.tabs.get('/s/b.sock|w1:p1')!.bodies['w1:p1'], 'working');
});

test('observe does not report gone when session list fails', async () => {
  const f = new FakeReader();
  f.panesBySocket.set('/s/a.sock', [pane({})]);
  f.failSockets = true;
  const o = await observe([target()], f);
  assert.equal(o.tabs.size, 0);
  assert.equal(o.errors.length, 1);
});

test('observe skips only the tab whose pane list fails', async () => {
  const f = new FakeReader();
  f.panesBySocket.set('/s/a.sock', [pane({})]);
  f.panesBySocket.set('/s/b.sock', [pane({socket: '/s/b.sock'})]);
  f.failPanes.add('/s/a.sock');
  const o = await observe([target(), target({socket: '/s/b.sock'})], f);
  assert.equal(o.tabs.has('/s/a.sock|w1:p1'), false);
  assert.equal(o.tabs.get('/s/b.sock|w1:p1')!.gone, false);
  assert.equal(o.errors.length, 1);
});

test('stageTabPattern matches only the tab epics', () => {
  const r = stageTabPattern([12, 13])!;
  assert.ok(r.test('spec-e13'));
  assert.ok(r.test('verify-e12-r2-a1b2'));
  assert.ok(!r.test('spec-e130'));
  assert.ok(!r.test('impl-mgr-f12'));
  assert.equal(stageTabPattern([]), undefined);
});

test('observe without epics uses only the recorded pane', async () => {
  const f = new FakeReader();
  f.panesBySocket.set('/s/a.sock', [pane({}), pane({paneId: 'w2:p1', tabLabel: 'spec-e12', status: 'blocked'})]);
  const o = await observe([target({epics: [], label: 'terminal T1'})], f);
  assert.deepEqual(o.tabs.get('/s/a.sock|w1:p1')!.bodies, {'w1:p1': 'working'});
});

test('observe sets working across cleanup sockets', async () => {
  const f = new FakeReader();
  f.panesBySocket.set('/s/a.sock', [pane({status: 'done'})]);
  f.panesBySocket.set('/s/old.sock', [pane({socket: '/s/old.sock', status: 'working', tabLabel: 'impl-mgr-f40'})]);
  const o = await observe([target({status: 'cleanup_waiting', cleanupSockets: ['/s/a.sock', '/s/old.sock']})], f);
  assert.equal(o.tabs.get('/s/a.sock|w1:p1')!.working, true);
});

test('observe still collects stage bodies when the recorded pane is gone', async () => {
  const f = new FakeReader();
  f.panesBySocket.set('/s/a.sock', [pane({paneId: 'w2:p1', status: 'working', tabLabel: 'verify-e12'})]);
  const o = await observe([target()], f);
  assert.deepEqual(o.tabs.get('/s/a.sock|w1:p1'), {gone: true, bodies: {'w2:p1': 'working'}, working: true});
});
