import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {discoverTargets} from '../src/watchdog/discover.js';
import {matchPane, parseEpic, parsePaneList, parseSessionList} from '../src/watchdog/herdr-fleet.js';
import type {Target} from '../src/watchdog/types.js';

async function scaffoldDir(t: {after(fn: () => Promise<void>): void}) {
  const dir = await mkdtemp(join(tmpdir(), 'watchdog-discover-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}
async function handoff(dir: string, op: string, packet: Record<string, unknown>, ready?: Record<string, unknown>) {
  const d = join(dir, 'state', 'abc', 'wf-1', 'handoff', op);
  await mkdir(d, {recursive: true});
  await writeFile(join(d, 'packet.json'), JSON.stringify(packet));
  if (ready) await writeFile(join(d, 'ready.json'), JSON.stringify(ready));
}
const packet = (o: Record<string, unknown> = {}) => ({version: 1, repo: 'example/demo', epicIssue: 7, sourceStage: 'basic-design', targetStage: 'implementation', cwd: '/repo', ...o});
const ready = (sessionId: string, at = '2026-10-18T00:00:00.000Z') => ({version: 1, phase: 'receiver-ready', sessionId, at});
const NOW = Date.parse('2026-10-18T01:00:00.000Z');

test('discover: a handoff with a ready receiver becomes a target, with its owner from the watch registry', async t => {
  const dir = await scaffoldDir(t);
  await handoff(dir, 'op1', packet(), ready('s1'));
  await handoff(dir, 'op2', packet({targetStage: 'verification'})); // receiver never got ready: nothing to watch
  await mkdir(join(dir, 'state'), {recursive: true});
  await writeFile(join(dir, 'state', 'watches.json'), JSON.stringify({version: 1, watches: [{entry: {targetSessionId: 's1', ownerSessionId: 'o1'}, progress: {}}]}));
  const targets = await discoverTargets([{dir, agent: 'pi'}], NOW);
  assert.deepEqual(targets, [{key: 's1', agent: 'pi', repo: 'example/demo', epicIssue: 7, targetStage: 'implementation', cwd: '/repo', sessionId: 's1', ownerSessionId: 'o1'} satisfies Target]);
});

test('discover: malformed records, unknown stages and old handoffs are skipped; a missing root is empty', async t => {
  const dir = await scaffoldDir(t);
  await handoff(dir, 'op1', packet({targetStage: 'completed'}), ready('s1'));
  await handoff(dir, 'op2', packet({epicIssue: 'seven'}), ready('s2'));
  await handoff(dir, 'op3', packet(), ready('s3', '2026-09-01T00:00:00.000Z'));
  await handoff(dir, 'op4', packet(), {phase: 'receiver-ready'});
  assert.deepEqual(await discoverTargets([{dir, agent: 'claude'}, {dir: join(dir, 'nope'), agent: 'pi'}], NOW), []);
});

test('herdr: session list keeps running sessions only', () => {
  const json = JSON.stringify({sessions: [{name: 'default', running: true, socket_path: '/a.sock'}, {name: 'x', running: false, socket_path: '/b.sock'}]});
  assert.deepEqual(parseSessionList(json), ['/a.sock']);
});

test('herdr: pane list keeps agent, status, session and revision', () => {
  const json = JSON.stringify({id: 'cli:pane:list', result: {panes: [
    {pane_id: 'w1:p1', agent: 'pi', agent_status: 'idle', agent_session: {kind: 'path', value: '/s/x_s1.jsonl'}, revision: 36},
    {pane_id: 'w1:p2', agent_status: 'unknown', revision: 4},
  ]}});
  assert.deepEqual(parsePaneList('/a.sock', json), [
    {socket: '/a.sock', paneId: 'w1:p1', agent: 'pi', status: 'idle', sessionValue: '/s/x_s1.jsonl', revision: 36},
    {socket: '/a.sock', paneId: 'w1:p2', status: 'unknown', revision: 4},
  ]);
});

test('herdr: a pi target matches by session path suffix, a claude target by id', () => {
  const panes = [
    {socket: '/a', paneId: 'w1:p1', agent: 'pi', status: 'idle', sessionValue: '/s/2026_s1.jsonl', revision: 1},
    {socket: '/b', paneId: 'w1:p1', agent: 'claude', status: 'idle', sessionValue: 'c1', revision: 1},
  ];
  const base = {repo: 'r/r', epicIssue: 1, targetStage: 'implementation' as const, cwd: '/r'};
  assert.equal(matchPane({...base, key: 's1', sessionId: 's1', agent: 'pi'}, panes)?.socket, '/a');
  assert.equal(matchPane({...base, key: 'c1', sessionId: 'c1', agent: 'claude'}, panes)?.socket, '/b');
  assert.equal(matchPane({...base, key: 's', sessionId: 's', agent: 'pi'}, panes), undefined, 'suffix must be _<id>.jsonl, not any ending');
});

test('gh: epic stage label and closed state', () => {
  assert.deepEqual(parseEpic(JSON.stringify({state: 'OPEN', labels: [{name: 'Type: Scaffold'}, {name: 'Stage: Implementation'}]})), {stageLabel: 'Stage: Implementation', closed: false});
  assert.deepEqual(parseEpic(JSON.stringify({state: 'CLOSED', labels: []})), {closed: true});
  assert.equal(parseEpic('not json'), 'unknown');
  assert.equal(parseEpic(JSON.stringify({state: 'OPEN', labels: [{name: 'Stage: Implementation'}, {name: 'Stage: Verification'}]})), 'unknown', 'two stage labels are never guessed');
});
