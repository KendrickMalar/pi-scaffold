import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {diffTab} from '../src/orchestrator-wait/diff.js';
import {waitForChange, waitForManagerChange, type ManagerDeps, type WaitDeps} from '../src/orchestrator-wait/run.js';
import {scanWatchdogLog, type WatchdogMark} from '../src/orchestrator-wait/watchdog-log.js';
import {FakeReader, boxTarget, pane} from './orchestrator-wait-fakes.js';

const STAGE = {tabLabel: 'impl-e12'};
const MGR = {tabLabel: 'mgr-e12'};

// --- normal mode with a manager tab ---
async function normal(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-mgr-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const statePath = join(dir, 'state.json');
  await writeFile(statePath, JSON.stringify({tabs: [{socket: '/s/a.sock', pane: 'w1:p1', epics: [12], status: 'running'}]}));
  const fleet = new FakeReader();
  let clock = 0;
  const deps: WaitDeps = {statePath, recordPath: `${statePath}.wait.json`, fleet, now: () => clock, sleep: async ms => { clock += ms; }, intervalMs: 5000, maxWaitMs: 20000};
  return {fleet, deps};
}
const set = (f: FakeReader, panes: ReturnType<typeof pane>[]) => f.panesBySocket.set('/s/a.sock', panes);

test('with a manager tab, a stage tab going working->blocked does not wake', async t => {
  const s = await normal(t);
  set(s.fleet, [pane({status: 'working'}), pane({paneId: 'w2:p1', ...STAGE, status: 'working'}), pane({paneId: 'w3:p1', ...MGR, status: 'working'})]);
  assert.equal((await waitForChange(s.deps)).kind, 'timeout');
  set(s.fleet, [pane({status: 'blocked'}), pane({paneId: 'w2:p1', ...STAGE, status: 'blocked'}), pane({paneId: 'w3:p1', ...MGR, status: 'working'})]);
  assert.equal((await waitForChange(s.deps)).kind, 'timeout');
});

test('with a manager tab, the manager going blocked wakes', async t => {
  const s = await normal(t);
  set(s.fleet, [pane({}), pane({paneId: 'w3:p1', ...MGR, status: 'working'})]);
  await waitForChange(s.deps);
  set(s.fleet, [pane({}), pane({paneId: 'w3:p1', ...MGR, status: 'blocked'})]);
  assert.deepEqual(await waitForChange(s.deps), {kind: 'changes', lines: ['Epic #12 w3:p1 working->blocked']});
});

test('wakes when the manager agent disappears, and when its tab closes', async t => {
  const s = await normal(t);
  set(s.fleet, [pane({}), pane({paneId: 'w3:p1', ...MGR, status: 'working'})]);
  await waitForChange(s.deps);
  set(s.fleet, [pane({}), pane({paneId: 'w3:p1', ...MGR, agent: undefined, status: 'unknown'})]);
  assert.deepEqual(await waitForChange(s.deps), {kind: 'changes', lines: ['Epic #12 w3:p1 gone']});
  set(s.fleet, [pane({}), pane({paneId: 'w3:p1', ...MGR, status: 'working'})]);
  await waitForChange(s.deps);
  set(s.fleet, [pane({})]);
  assert.deepEqual(await waitForChange(s.deps), {kind: 'changes', lines: ['Epic #12 w3:p1 gone']});
});

test('a manager label must match whole and the epic must be one of the tab epics', async t => {
  const s = await normal(t);
  set(s.fleet, [pane({status: 'working'}), pane({paneId: 'w3:p1', tabLabel: 'mgr-e13', status: 'working'}), pane({paneId: 'w4:p1', tabLabel: 'mgr-e12-extra', status: 'working'})]);
  await waitForChange(s.deps);
  set(s.fleet, [pane({status: 'blocked'}), pane({paneId: 'w3:p1', tabLabel: 'mgr-e13', status: 'working'}), pane({paneId: 'w4:p1', tabLabel: 'mgr-e12-extra', status: 'working'})]);
  assert.deepEqual(await waitForChange(s.deps), {kind: 'changes', lines: ['Epic #12 w1:p1 working->blocked']});
});

test('a manager appearing does not report the hidden stage panes as gone', async t => {
  const s = await normal(t);
  set(s.fleet, [pane({status: 'working'}), pane({paneId: 'w2:p1', ...STAGE, status: 'working'})]);
  await waitForChange(s.deps);
  set(s.fleet, [pane({status: 'working'}), pane({paneId: 'w2:p1', ...STAGE, status: 'working'}), pane({paneId: 'w3:p1', ...MGR, status: 'working'})]);
  assert.equal((await waitForChange(s.deps)).kind, 'timeout');
});

test('with a manager in a box, the cleanup working check still looks at every pane', async t => {
  const tg = boxTarget({status: 'cleanup_waiting'});
  const mgr = {working: true, manager: true, gone: false, bodies: {'w3:p1': 'idle'}};
  assert.deepEqual(diffTab(tg, mgr, {...mgr, working: false}), [`${tg.label} cleanup: no working agent`]);
  
});

// --- manager mode ---
async function mgr(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-mgr-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const summaryPath = join(dir, 'summary.json');
  await writeFile(summaryPath, JSON.stringify({epic: 12, repo: 'o/r', extra: 1}));
  const fleet = new FakeReader();
  let clock = 0, log: string | Error = '';
  const deps: ManagerDeps = {
    summaryPath, recordPath: `${summaryPath}.wait.json`, socket: '/s/m.sock', ownPane: 'w9:p9',
    fleet: {panes: s => fleet.panes(s)},
    readWatchdogLog: async () => { if (log instanceof Error) throw log; return log; },
    now: () => clock, sleep: async ms => { clock += ms; }, intervalMs: 5000, maxWaitMs: 20000,
  };
  return {dir, summaryPath, fleet, deps, setLog: (l: string | Error) => { log = l; }};
}
const row = (o: Record<string, unknown>) => JSON.stringify({at: '2026-11-18T01:00:00.000Z', event: 'prompted', repo: 'o/r', epic: 12, stage: 'implementation', ...o});
const setM = (f: FakeReader, panes: ReturnType<typeof pane>[]) => f.panesBySocket.set('/s/m.sock', panes);

test('manager mode ignores its own pane and wakes on a stage tab blocked', async t => {
  const s = await mgr(t);
  setM(s.fleet, [pane({paneId: 'w9:p9', status: 'working'}), pane({paneId: 'w2:p1', ...STAGE, status: 'working'})]);
  assert.equal((await waitForManagerChange(s.deps)).kind, 'timeout');
  setM(s.fleet, [pane({paneId: 'w9:p9', status: 'blocked'}), pane({paneId: 'w2:p1', ...STAGE, status: 'working'})]);
  assert.equal((await waitForManagerChange(s.deps)).kind, 'timeout');
  setM(s.fleet, [pane({paneId: 'w9:p9', status: 'idle'}), pane({paneId: 'w2:p1', ...STAGE, status: 'blocked'})]);
  assert.deepEqual(await waitForManagerChange(s.deps), {kind: 'changes', lines: ['Epic #12 w2:p1 working->blocked']});
});

test('manager mode watches only stage tabs of its Epic', async t => {
  const s = await mgr(t);
  setM(s.fleet, [pane({paneId: 'w2:p1', tabLabel: 'impl-e13', status: 'blocked'}), pane({paneId: 'w3:p1', tabLabel: 'impl-mgr-f1', status: 'blocked'}), pane({paneId: 'w4:p1', tabLabel: 'mgr-e12', status: 'blocked'})]);
  assert.equal((await waitForManagerChange(s.deps)).kind, 'timeout');
});

test('manager mode wakes when a stage pane disappears', async t => {
  const s = await mgr(t);
  setM(s.fleet, [pane({paneId: 'w2:p1', tabLabel: 'verify-e12-r2-a1b2', status: 'working'})]);
  await waitForManagerChange(s.deps);
  setM(s.fleet, []);
  assert.deepEqual(await waitForManagerChange(s.deps), {kind: 'changes', lines: ['Epic #12 w2:p1 gone']});
});

test('manager mode wakes on new watchdog lines for its repo and epic only, with the baseline ignored', async t => {
  const s = await mgr(t);
  setM(s.fleet, []);
  s.setLog(`${row({})}\n`);
  assert.equal((await waitForManagerChange(s.deps)).kind, 'timeout');
  s.setLog(`${row({})}\n${row({at: '2026-11-18T01:00:05.000Z', epic: 13})}\n${row({at: '2026-11-18T01:00:06.000Z', repo: 'o/other'})}\n${row({at: '2026-11-18T01:00:07.000Z', event: 'error'})}\n`);
  assert.equal((await waitForManagerChange(s.deps)).kind, 'timeout');
  s.setLog(`${row({})}\n${row({at: '2026-11-18T01:01:00.000Z', event: 'awaiting-human', stage: 'specification'})}\n`);
  assert.deepEqual(await waitForManagerChange(s.deps), {kind: 'changes', lines: ['watchdog awaiting-human specification']});
  assert.equal((await waitForManagerChange(s.deps)).kind, 'timeout');
});

test('manager mode does not wake twice for the same line across a log rotation', async t => {
  const s = await mgr(t);
  setM(s.fleet, []);
  const a = row({at: '2026-11-18T01:01:00.000Z', event: 'blocked', stage: 'design'});
  s.setLog('');
  await waitForManagerChange(s.deps);
  s.setLog(`${a}\n`);
  assert.deepEqual(await waitForManagerChange(s.deps), {kind: 'changes', lines: ['watchdog blocked design']});
  s.setLog('');
  assert.equal((await waitForManagerChange(s.deps)).kind, 'timeout');
  s.setLog(`${a}\n`);
  assert.equal((await waitForManagerChange(s.deps)).kind, 'timeout');
  const b = row({at: '2026-11-18T01:02:00.000Z', event: 'retired', stage: 'design'});
  s.setLog(`${b}\n`);
  assert.deepEqual(await waitForManagerChange(s.deps), {kind: 'changes', lines: ['watchdog retired design']});
});

test('manager mode adds an unreadable watchdog log to the timeout errors and never wakes for it', async t => {
  const s = await mgr(t);
  setM(s.fleet, []);
  s.setLog(new Error('ENOENT: no such file'));
  assert.deepEqual(await waitForManagerChange(s.deps), {kind: 'timeout', errors: ['watchdog log: ENOENT: no such file']});
});

test('manager mode writes only its own record and keeps the summary file', async t => {
  const s = await mgr(t);
  setM(s.fleet, [pane({paneId: 'w2:p1', ...STAGE, status: 'working'})]);
  s.setLog(`${row({})}\n`);
  const before = await readFile(s.summaryPath, 'utf8');
  await waitForManagerChange(s.deps);
  assert.equal(await readFile(s.summaryPath, 'utf8'), before);
  const rec = JSON.parse(await readFile(s.deps.recordPath, 'utf8'));
  assert.equal(rec.version, 1);
  assert.equal(rec.watchdog.lastAt, '2026-11-18T01:00:00.000Z');
});

test('manager mode rejects a summary without epic or repo', async t => {
  const s = await mgr(t);
  await writeFile(s.summaryPath, JSON.stringify({epic: 'x', repo: 'o/r'}));
  await assert.rejects(waitForManagerChange(s.deps));
  await writeFile(s.summaryPath, JSON.stringify({epic: 12, repo: 'nope'}));
  await assert.rejects(waitForManagerChange(s.deps));
});

test('scanWatchdogLog counts identical lines at the same instant and ignores broken lines', () => {
  const who = {repo: 'o/r', epic: 12};
  const a = row({});
  let mark: WatchdogMark | undefined = scanWatchdogLog(`${a}\n`, who, undefined).mark;
  const r = scanWatchdogLog(`not json\n${a}\n${a}\n`, who, mark);
  assert.deepEqual(r.lines, ['watchdog prompted implementation']);
  mark = r.mark;
  assert.deepEqual(scanWatchdogLog(`${a}\n${a}\n`, who, mark).lines, []);
});
