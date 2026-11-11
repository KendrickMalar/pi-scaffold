import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {waitForChange, type WaitDeps} from '../src/orchestrator-wait/run.js';
import {FakeReader, pane} from './orchestrator-wait-fakes.js';

const tab = (o: Record<string, unknown> = {}) => ({terminal: 'T1', socket: '/s/a.sock', pane: 'w1:p1', epics: [12], status: 'running', ...o});
const stateText = (tabs: unknown[]) => JSON.stringify({repo: '/r', tabs});

async function setup(t: test.TestContext, tabs: unknown[] = [tab()]) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-wait-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const statePath = join(dir, 'state.json');
  await writeFile(statePath, stateText(tabs));
  const fleet = new FakeReader();
  let clock = 0, reads = 0;
  const onTick: (() => void | Promise<void>)[] = [];
  const counting = {sockets: async () => { reads++; await onTick[reads - 1]?.(); return fleet.sockets(); }, panes: (s: string) => fleet.panes(s)};
  const deps: WaitDeps = {statePath, recordPath: `${statePath}.wait.json`, fleet: counting, now: () => clock, sleep: async ms => { clock += ms; }, intervalMs: 5000, maxWaitMs: 300000};
  return {dir, statePath, fleet, deps, onTick, reads: () => reads};
}

test('waitForChange returns on blocked', async t => {
  const s = await setup(t);
  s.fleet.panesBySocket.set('/s/a.sock', [pane({status: 'working'})]);
  s.onTick[2] = () => { s.fleet.panesBySocket.set('/s/a.sock', [pane({status: 'blocked'})]); };
  assert.deepEqual(await waitForChange(s.deps), {kind: 'changes', lines: ['Epic #12 w1:p1 working->blocked']});
  assert.equal(s.reads(), 3);
});

test('waitForChange times out after maxWaitMs', async t => {
  const s = await setup(t);
  s.fleet.panesBySocket.set('/s/a.sock', [pane({})]);
  assert.deepEqual(await waitForChange(s.deps), {kind: 'timeout', errors: []});
  assert.ok(s.reads() >= 60 && s.reads() <= 62, `reads ${s.reads()}`);
});

test('waitForChange does not wake twice for the same state', async t => {
  const s = await setup(t);
  s.fleet.panesBySocket.set('/s/a.sock', [pane({status: 'blocked'})]);
  assert.equal((await waitForChange(s.deps)).kind, 'changes');
  assert.equal((await waitForChange(s.deps)).kind, 'timeout');
});

test('waitForChange picks up changes between calls', async t => {
  const s = await setup(t);
  s.fleet.panesBySocket.set('/s/a.sock', [pane({status: 'working'})]);
  s.deps.maxWaitMs = 10000;
  assert.equal((await waitForChange(s.deps)).kind, 'timeout');
  s.fleet.panesBySocket.set('/s/a.sock', [pane({status: 'idle'})]);
  const before = s.reads();
  assert.deepEqual(await waitForChange(s.deps), {kind: 'changes', lines: ['Epic #12 w1:p1 working->idle']});
  assert.equal(s.reads() - before, 1);
});

test('waitForChange survives a half-written state file', async t => {
  const s = await setup(t);
  s.fleet.panesBySocket.set('/s/a.sock', [pane({})]);
  s.deps.maxWaitMs = 20000;
  s.onTick[1] = () => writeFile(s.statePath, '{"tabs": [');
  const r = await waitForChange(s.deps);
  assert.equal(r.kind, 'timeout');
  assert.equal(r.kind === 'timeout' && r.errors.length, 1);
});

test('waitForChange throws when the state file is unreadable at start', async t => {
  const s = await setup(t);
  await writeFile(s.statePath, 'nope');
  await assert.rejects(waitForChange(s.deps));
});

test('waitForChange treats a broken record as empty', async t => {
  const s = await setup(t);
  await writeFile(s.deps.recordPath, 'nope');
  s.fleet.panesBySocket.set('/s/a.sock', [pane({status: 'blocked'})]);
  assert.deepEqual(await waitForChange(s.deps), {kind: 'changes', lines: ['Epic #12 w1:p1 new->blocked']});
});

test('waitForChange drops records of removed tabs', async t => {
  const s = await setup(t, [tab(), tab({pane: 'w1:p2', epics: [13]})]);
  s.fleet.panesBySocket.set('/s/a.sock', [pane({}), pane({paneId: 'w1:p2'})]);
  s.deps.maxWaitMs = 5000;
  await waitForChange(s.deps);
  await writeFile(s.statePath, stateText([tab()]));
  await waitForChange(s.deps);
  const rec = JSON.parse(await readFile(s.deps.recordPath, 'utf8'));
  assert.deepEqual(Object.keys(rec.tabs), ['/s/a.sock|w1:p1']);
  assert.equal(rec.version, 1);
});

test('waitForChange keeps the record of a tab it could not read', async t => {
  const s = await setup(t);
  s.fleet.panesBySocket.set('/s/a.sock', [pane({status: 'working'})]);
  s.deps.maxWaitMs = 5000;
  await waitForChange(s.deps);
  s.fleet.failPanes.add('/s/a.sock');
  const r = await waitForChange(s.deps);
  assert.equal(r.kind === 'timeout' && r.errors.length, 1);
  s.fleet.failPanes.clear();
  s.fleet.panesBySocket.set('/s/a.sock', [pane({status: 'blocked'})]);
  assert.deepEqual(await waitForChange(s.deps), {kind: 'changes', lines: ['Epic #12 w1:p1 working->blocked']});
});

test('waitForChange never writes the state file', async t => {
  const s = await setup(t);
  s.fleet.panesBySocket.set('/s/a.sock', [pane({status: 'blocked'})]);
  const before = await readFile(s.statePath, 'utf8');
  await waitForChange(s.deps);
  assert.equal(await readFile(s.statePath, 'utf8'), before);
});
