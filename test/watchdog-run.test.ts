import test from 'node:test';
import assert from 'node:assert/strict';
import {access, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runOnce, type WatchdogDeps} from '../src/watchdog/run.js';
import {IDLE_GRACE_MS, NUDGE_PROMPT} from '../src/watchdog/plan.js';
import type {Fleet, PaneSnapshot} from '../src/watchdog/herdr-fleet.js';
import type {TailResult} from '../src/watch/session-tail.js';

const SESSION = '/sessions/--repo--/2026-10-18T00-00-00-000Z_s1.jsonl';

class FakeFleet implements Fleet {
  panesBySocket = new Map<string, PaneSnapshot[]>();
  calls: {command: string; socket: string; args: unknown}[] = [];
  shellReady = true;
  /** Called after each `panes()` read, so a test can change the pane between observation and send. */
  afterRead?: () => void;
  async sockets() { return [...this.panesBySocket.keys()]; }
  async panes(socket: string) { const p = structuredClone(this.panesBySocket.get(socket) ?? []); this.afterRead?.(); return p; }
  port(socket: string) {
    return {
      processInfo: async (paneId: string) => { this.calls.push({command: 'processInfo', socket, args: paneId}); return {shellReady: this.shellReady}; },
      paneRun: async (paneId: string, command: string) => { this.calls.push({command: 'paneRun', socket, args: {paneId, command}}); },
      agentPrompt: async (paneId: string, text: string) => { this.calls.push({command: 'agentPrompt', socket, args: {paneId, text}}); },
      paneGet: async () => ({exists: false as const}),
    };
  }
  sends() { return this.calls.filter(c => c.command === 'agentPrompt' || c.command === 'paneRun'); }
}

async function setup(t: {after(fn: () => Promise<void>): void}, readyExtra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'watchdog-run-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const dir = join(root, 'pi-scaffold'), op = join(dir, 'state', 'h', 'wf', 'handoff', 'op1');
  await mkdir(op, {recursive: true});
  await writeFile(join(op, 'packet.json'), JSON.stringify({repo: 'example/demo', epicIssue: 7, targetStage: 'implementation', cwd: '/repo'}));
  await writeFile(join(op, 'ready.json'), JSON.stringify({phase: 'receiver-ready', sessionId: 's1', at: '2026-10-18T00:00:00.000Z', ...readyExtra}));
  const fleet = new FakeFleet();
  fleet.panesBySocket.set('/s.sock', [{socket: '/s.sock', paneId: 'w1:p2', agent: 'pi', status: 'idle', sessionValue: SESSION, revision: 5}]);
  const clock = {now: Date.parse('2026-10-18T01:00:00.000Z')};
  const tail: TailResult = {kind: 'stopped', reason: 'stop', at: 1};
  const deps: WatchdogDeps = {
    roots: [{dir, agent: 'pi'}], fleet, epic: async () => ({stageLabel: 'Stage: Implementation', closed: false}),
    readTail: async () => tail, statePath: join(root, 'state', 'state.json'), logPath: join(root, 'log', 'watchdog.log'),
    now: () => clock.now, diskFree: async () => 123,
  };
  const logs = async () => (await readFile(deps.logPath, 'utf8')).trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);
  return {deps, fleet, clock, logs, root};
}

test('an unfinished idle stage is prompted after the grace period, and every step is logged', async t => {
  const s = await setup(t);
  assert.equal(await runOnce(s.deps), 'ran');
  assert.equal(s.fleet.sends().length, 0);
  s.clock.now += IDLE_GRACE_MS;
  await runOnce(s.deps);
  assert.deepEqual(s.fleet.sends(), [{command: 'agentPrompt', socket: '/s.sock', args: {paneId: 'w1:p2', text: NUDGE_PROMPT}}]);
  const events = (await s.logs()).map(l => l.event);
  assert.ok(events.includes('disk'));
  assert.ok(events.includes('prompted'));
  const prompted = (await s.logs()).find(l => l.event === 'prompted')!;
  assert.equal(prompted.repo, 'example/demo'); assert.equal(prompted.epic, 7); assert.equal(prompted.stage, 'implementation');
});

test('nothing is typed when the pane changed between observation and send', async t => {
  const s = await setup(t);
  await runOnce(s.deps);
  s.clock.now += IDLE_GRACE_MS;
  let reads = 0;
  s.fleet.afterRead = () => { reads += 1; if (reads === 1) s.fleet.panesBySocket.get('/s.sock')![0]!.revision = 6; };
  await runOnce(s.deps);
  assert.equal(s.fleet.sends().length, 0);
  assert.ok((await s.logs()).some(l => l.event === 'prompt-skipped'));
});

test('a pi pane back at its shell is relaunched with its session through the shim', async t => {
  const s = await setup(t);
  await runOnce(s.deps);
  s.fleet.panesBySocket.set('/s.sock', [{socket: '/s.sock', paneId: 'w1:p2', status: 'unknown', revision: 9}]);
  s.clock.now += 1000;
  await runOnce(s.deps);
  assert.deepEqual(s.fleet.sends(), [{command: 'paneRun', socket: '/s.sock', args: {paneId: 'w1:p2', command: `pi --session '${SESSION}'`}}]);
  assert.ok((await s.logs()).some(l => l.event === 'relaunched'));
});

test('dry run decides and logs but never types', async t => {
  const s = await setup(t);
  s.deps.dryRun = true;
  await runOnce(s.deps);
  s.clock.now += IDLE_GRACE_MS;
  await runOnce(s.deps);
  assert.equal(s.fleet.sends().length, 0);
  assert.ok((await s.logs()).some(l => l.event === 'dry-run' && l.action === 'prompt'));
});

test('dry run starts from the live state but never writes it or takes its lock', async t => {
  const s = await setup(t);
  await runOnce(s.deps);
  const live = await readFile(s.deps.statePath, 'utf8');
  await mkdir(`${s.deps.statePath}.lock`);
  s.deps.dryRun = true;
  s.clock.now += IDLE_GRACE_MS;
  assert.equal(await runOnce(s.deps), 'ran');
  assert.equal(await readFile(s.deps.statePath, 'utf8'), live);
  assert.ok((await s.logs()).some(l => l.event === 'dry-run' && l.action === 'prompt'), 'the grace period counted from the live state');
  await access(`${s.deps.statePath}.dry-run`);
});

const NONCE = 'ab'.repeat(32), TAG = 'scaffold-abababababab';
const LATER = '/sessions/--repo--/2026-10-18T00-30-00-000Z_s2.jsonl';

test('a stage relaunched in its handoff tab as another conversation is rebound, logged, then nudged there', async t => {
  const s = await setup(t, {nonceSha256: NONCE});
  s.fleet.panesBySocket.set('/s.sock', [
    {socket: '/s.sock', paneId: 'w1:pD', agent: 'pi', status: 'idle', sessionValue: LATER, revision: 2, cwd: '/repo', tabId: 'w1:tA', tabLabel: TAG},
  ]);
  await runOnce(s.deps);
  const rebound = (await s.logs()).find(l => l.event === 'rebound')!;
  assert.equal(rebound.from, 's1'); assert.equal(rebound.to, 's2'); assert.equal(rebound.paneId, 'w1:pD'); assert.equal(rebound.socket, '/s.sock');
  assert.equal(s.fleet.sends().length, 0);
  s.clock.now += IDLE_GRACE_MS;
  await runOnce(s.deps);
  assert.deepEqual(s.fleet.sends(), [{command: 'agentPrompt', socket: '/s.sock', args: {paneId: 'w1:pD', text: NUDGE_PROMPT}}]);
  const events = (await s.logs()).map(l => l.event);
  assert.equal(events.filter(e => e === 'rebound').length, 1, 'rebinding is remembered, not repeated');
  assert.ok(!events.includes('missing'));
  const saved = JSON.parse(await readFile(s.deps.statePath, 'utf8'));
  assert.equal(saved.targets.s1.rebound.sessionId, 's2');
});

test('one later conversation in the same cwd outside the handoff tab: logged once, not rebound, nothing typed', async t => {
  const s = await setup(t, {nonceSha256: NONCE});
  s.fleet.panesBySocket.set('/s.sock', [
    {socket: '/s.sock', paneId: 'w1:pD', agent: 'pi', status: 'idle', sessionValue: LATER, revision: 2, cwd: '/repo', tabLabel: '1'},
  ]);
  await runOnce(s.deps);
  s.clock.now += IDLE_GRACE_MS;
  await runOnce(s.deps);
  assert.equal(s.fleet.sends().length, 0);
  const logs = await s.logs();
  const outside = logs.filter(l => l.event === 'rebind-candidate-outside-tab');
  assert.equal(outside.length, 1);
  assert.equal(outside[0]!.target, 's1');
  assert.match(String(outside[0]!.detail), /s2 \/s\.sock#w1:pD/);
  assert.ok(!logs.some(l => l.event === 'rebound'));
  const saved = JSON.parse(await readFile(s.deps.statePath, 'utf8'));
  assert.equal(saved.targets.s1.rebound, undefined);
});

test('a pane back at its shell is still relaunched when a conversation outside the handoff tab shares its cwd', async t => {
  const s = await setup(t, {nonceSha256: NONCE});
  await runOnce(s.deps);
  s.fleet.panesBySocket.set('/s.sock', [
    {socket: '/s.sock', paneId: 'w1:p2', status: 'unknown', revision: 9},
    {socket: '/s.sock', paneId: 'w1:p8', agent: 'pi', status: 'idle', sessionValue: LATER, revision: 2, cwd: '/repo', tabLabel: '1'},
  ]);
  s.clock.now += 1000;
  await runOnce(s.deps);
  assert.deepEqual(s.fleet.sends(), [{command: 'paneRun', socket: '/s.sock', args: {paneId: 'w1:p2', command: `pi --session '${SESSION}'`}}]);
  assert.ok(!(await s.logs()).some(l => l.event === 'rebind-candidate-outside-tab'));
});

test('two later conversations in the handoff tab: rebind-ambiguous, nothing typed', async t => {
  const s = await setup(t, {nonceSha256: NONCE});
  s.fleet.panesBySocket.set('/s.sock', [
    {socket: '/s.sock', paneId: 'w1:pD', agent: 'pi', status: 'idle', sessionValue: LATER, revision: 2, cwd: '/repo', tabLabel: TAG},
    {socket: '/s.sock', paneId: 'w1:pE', agent: 'pi', status: 'idle', sessionValue: '/sessions/--repo--/2026-10-18T00-40-00-000Z_s3.jsonl', revision: 2, cwd: '/repo', tabLabel: TAG},
  ]);
  await runOnce(s.deps);
  s.clock.now += IDLE_GRACE_MS;
  await runOnce(s.deps);
  assert.equal(s.fleet.sends().length, 0);
  const logs = await s.logs();
  assert.equal(logs.filter(l => l.event === 'rebind-ambiguous').length, 1);
  assert.ok(!logs.some(l => l.event === 'rebound'));
});

test('the session that handed off another stage in the same cwd is never taken as a successor', async t => {
  const s = await setup(t, {nonceSha256: NONCE});
  // A later handoff (another Epic, same cwd) whose sender runs in an untagged tab: seen on 2026-10-18 for launchd-manager.
  const op2 = join(s.root, 'pi-scaffold', 'state', 'h', 'wf2', 'handoff', 'op2');
  await mkdir(op2, {recursive: true});
  await writeFile(join(op2, 'packet.json'), JSON.stringify({repo: 'example/demo', epicIssue: 9, targetStage: 'specification', cwd: '/repo'}));
  await writeFile(join(op2, 'ready.json'), JSON.stringify({phase: 'receiver-ready', sessionId: 's4', at: '2026-10-18T00:31:00.000Z'}));
  await writeFile(join(s.root, 'pi-scaffold', 'state', 'watches.json'), JSON.stringify({version: 1, watches: [{entry: {targetSessionId: 's4', ownerSessionId: 's2'}}]}));
  s.fleet.panesBySocket.set('/s.sock', [
    {socket: '/s.sock', paneId: 'w1:p2', agent: 'pi', status: 'idle', sessionValue: LATER, revision: 2, cwd: '/repo', tabLabel: '1'},
    {socket: '/s.sock', paneId: 'w1:p3', agent: 'pi', status: 'idle', sessionValue: '/sessions/--repo--/2026-10-18T00-31-00-000Z_s4.jsonl', revision: 2, cwd: '/repo', tabLabel: 'scaffold-other'},
  ]);
  s.deps.epic = async (_repo, issue) => ({stageLabel: issue === 7 ? 'Stage: Implementation' : 'Stage: Specification', closed: false});
  await runOnce(s.deps);
  const logs = await s.logs();
  assert.ok(!logs.some(l => l.event === 'rebound'));
  assert.ok(logs.some(l => l.event === 'missing' && l.target === 's1'));
});

test('the pi-subagents reconcile hook runs every tick and its output is logged', async t => {
  const s = await setup(t);
  s.deps.reconcile = async () => '{"checked":2,"repaired":[]}';
  await runOnce(s.deps);
  assert.deepEqual((await s.logs()).find(l => l.event === 'subagents-reconcile')?.output, {checked: 2, repaired: []});
});

test('a second watchdog run while one holds the lock does nothing', async t => {
  const s = await setup(t);
  await mkdir(`${s.deps.statePath}.lock`, {recursive: true});
  assert.equal(await runOnce(s.deps), 'locked');
  assert.equal(s.fleet.calls.length, 0);
});

test('a Herdr session that cannot be read is logged and the others still run', async t => {
  const s = await setup(t);
  const panes = s.fleet.panes.bind(s.fleet);
  s.fleet.panesBySocket.set('/broken.sock', []);
  s.fleet.panes = async (socket: string) => { if (socket === '/broken.sock') throw new Error('socket refused'); return panes(socket); };
  await runOnce(s.deps);
  s.clock.now += IDLE_GRACE_MS;
  await runOnce(s.deps);
  assert.equal(s.fleet.sends().length, 1);
  assert.ok((await s.logs()).some(l => l.event === 'herdr-error'));
});

test('roots: explicit list, or every Pi agent dir and the Claude scaffold dir that exist', async t => {
  const {resolveRoots} = await import('../src/watchdog/main.js');
  assert.deepEqual(resolveRoots({SCAFFOLD_WATCHDOG_ROOTS: 'pi=/a/pi-scaffold, claude=/b/pi-scaffold'}, '/home'), [{agent: 'pi', dir: '/a/pi-scaffold'}, {agent: 'claude', dir: '/b/pi-scaffold'}]);
  assert.throws(() => resolveRoots({SCAFFOLD_WATCHDOG_ROOTS: 'codex=/a'}, '/home'), /pi=\/abs\/path/);
  const home = await mkdtemp(join(tmpdir(), 'watchdog-home-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  for (const d of ['.pi/agent/pi-scaffold', '.pi/agent-muu/pi-scaffold', '.pi/agent-rbx', '.claude/scaffold/pi-scaffold']) await mkdir(join(home, d), {recursive: true});
  assert.deepEqual(resolveRoots({}, home), [{agent: 'pi', dir: join(home, '.pi/agent/pi-scaffold')}, {agent: 'pi', dir: join(home, '.pi/agent-muu/pi-scaffold')}, {agent: 'claude', dir: join(home, '.claude/scaffold/pi-scaffold')}]);
});

test('reconcile runs with the user temp dir, where Pi keeps pi-subagents runs, even when launchd sets no TMPDIR', async () => {
  const {reconcileEnv} = await import('../src/watchdog/main.js');
  assert.equal(reconcileEnv({PATH: '/bin'}, () => '/var/folders/x/T/').TMPDIR, '/var/folders/x/T/');
  assert.equal(reconcileEnv({TMPDIR: '/keep/'}, () => '/var/folders/x/T/').TMPDIR, '/keep/');
  assert.equal(reconcileEnv({PATH: '/bin'}, () => undefined).TMPDIR, undefined);
});

test('a stage the old rule retired while the Epic still had the earlier label is watched again', async t => {
  const s = await setup(t);
  await mkdir(join(s.root, 'state'), {recursive: true});
  await writeFile(s.deps.statePath, JSON.stringify({version: 1, targets: {s1: {nudges: 0, stopNudges: 0, relaunches: 0, watch: {retryCount: 0, herdrFailures: 0}, retired: true}}}));
  s.deps.epic = async () => ({stageLabel: 'Stage: BasicDesign', closed: false});
  await runOnce(s.deps);
  const events = (await s.logs()).map(l => l.event);
  assert.ok(events.includes('unretired'));
  assert.ok(events.includes('stage-not-yet'));
  const saved = JSON.parse(await readFile(s.deps.statePath, 'utf8')) as {targets: Record<string, {retired?: boolean}>};
  assert.equal(saved.targets.s1!.retired, undefined);
});

test('a stage retired with a reason is not read again', async t => {
  const s = await setup(t);
  await mkdir(join(s.root, 'state'), {recursive: true});
  await writeFile(s.deps.statePath, JSON.stringify({version: 1, targets: {s1: {nudges: 0, stopNudges: 0, relaunches: 0, watch: {retryCount: 0, herdrFailures: 0}, retired: true, retiredReason: 'closed'}}}));
  let reads = 0;
  s.deps.epic = async () => { reads += 1; return {stageLabel: 'Stage: Implementation', closed: false}; };
  await runOnce(s.deps);
  assert.equal(reads, 0);
});
