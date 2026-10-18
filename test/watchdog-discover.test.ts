import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {discoverTargets} from '../src/watchdog/discover.js';
import {findSuccessor, matchPane, parseEpic, parsePaneList, parseSessionList, parseTabList, sessionCreatedAt, type PaneSnapshot} from '../src/watchdog/herdr-fleet.js';
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
const ready = (sessionId: string, at = '2026-10-18T00:00:00.000Z', extra: Record<string, unknown> = {}) => ({version: 1, phase: 'receiver-ready', sessionId, at, ...extra});
const NOW = Date.parse('2026-10-18T01:00:00.000Z');

test('discover: a handoff with a ready receiver becomes a target, with its owner from the watch registry', async t => {
  const dir = await scaffoldDir(t);
  await handoff(dir, 'op1', packet(), ready('s1'));
  await handoff(dir, 'op2', packet({targetStage: 'verification'})); // receiver never got ready: nothing to watch
  await mkdir(join(dir, 'state'), {recursive: true});
  await writeFile(join(dir, 'state', 'watches.json'), JSON.stringify({version: 1, watches: [{entry: {targetSessionId: 's1', ownerSessionId: 'o1'}, progress: {}}]}));
  const targets = await discoverTargets([{dir, agent: 'pi'}], NOW);
  assert.deepEqual(targets, [{key: 's1', agent: 'pi', repo: 'example/demo', epicIssue: 7, targetStage: 'implementation', cwd: '/repo', sessionId: 's1', handoffAt: Date.parse('2026-10-18T00:00:00.000Z'), ownerSessionId: 'o1'} satisfies Target]);
});

test('discover: the handoff tab tag comes from the receipt nonce, as the sender labels the tab', async t => {
  const dir = await scaffoldDir(t);
  await handoff(dir, 'op1', packet(), ready('s1', undefined, {nonceSha256: '7d019e3f8e78322daa4abb8fdbfc19022cf3fd89cb98a0b3a7e99ac709fc69d1'}));
  const [target] = await discoverTargets([{dir, agent: 'pi'}], NOW);
  assert.equal(target?.tabTag, 'scaffold-7d019e3f8e78');
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

test('herdr: pane list keeps agent, status, session, revision, cwd and tab', () => {
  const json = JSON.stringify({id: 'cli:pane:list', result: {panes: [
    {pane_id: 'w1:p1', agent: 'pi', agent_status: 'idle', agent_session: {kind: 'path', value: '/s/x_s1.jsonl'}, revision: 36, cwd: '/repo', tab_id: 'w1:t1'},
    {pane_id: 'w1:p2', agent_status: 'unknown', revision: 4},
  ]}});
  assert.deepEqual(parsePaneList('/a.sock', json), [
    {socket: '/a.sock', paneId: 'w1:p1', agent: 'pi', status: 'idle', sessionValue: '/s/x_s1.jsonl', revision: 36, cwd: '/repo', tabId: 'w1:t1'},
    {socket: '/a.sock', paneId: 'w1:p2', status: 'unknown', revision: 4},
  ]);
});

test('herdr: a pi target matches by session path suffix, a claude target by id', () => {
  const panes = [
    {socket: '/a', paneId: 'w1:p1', agent: 'pi', status: 'idle', sessionValue: '/s/2026_s1.jsonl', revision: 1},
    {socket: '/b', paneId: 'w1:p1', agent: 'claude', status: 'idle', sessionValue: 'c1', revision: 1},
  ];
  const base = {repo: 'r/r', epicIssue: 1, targetStage: 'implementation' as const, cwd: '/r', handoffAt: 0};
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

test('herdr: tab list maps tab id to label', () => {
  const json = JSON.stringify({id: 'cli:tab:list', result: {tabs: [{tab_id: 'w1:tA', label: 'scaffold-7d019e3f8e78'}, {tab_id: 'w1:t1'}], type: 'tab_list'}});
  assert.deepEqual([...parseTabList(json)], [['w1:tA', 'scaffold-7d019e3f8e78']]);
  assert.equal(parseTabList('nope').size, 0);
});

test('session creation time: pi file name, else a UUIDv7 id, else unknown', () => {
  assert.equal(sessionCreatedAt('pi', '/h/.pi/agent-muu/sessions/--x--/2026-10-16T17-22-56-031Z_01a145bc-fd9f-74d9-b536-8e36d8bc0476.jsonl'), Date.parse('2026-10-16T17:22:56.031Z'));
  assert.equal(sessionCreatedAt('claude', '0199f3a0-0000-7000-8000-000000000000'), 0x0199f3a00000);
  assert.equal(sessionCreatedAt('claude', '6f1c2a10-1111-4222-8333-444455556666'), undefined, 'UUIDv4 carries no time');
});

const HANDOFF_AT = Date.parse('2026-10-16T04:41:26.683Z');
const CWD = '/wt/epic-2';
const piPane = (paneId: string, stamp: string, id: string, o: Partial<PaneSnapshot> = {}): PaneSnapshot => ({socket: '/papillon.sock', paneId, agent: 'pi', status: 'idle', sessionValue: `/h/.pi/agent-muu/sessions/--wt--/${stamp}_${id}.jsonl`, revision: 3, cwd: CWD, ...o});
const lost = (o: Partial<Target> = {}): Target => ({key: '01a14303-cb93-71e0-8098-d73cc4d595c0', agent: 'pi', repo: 'KendrickMalar/lost-castle-above-the-clouds', epicIssue: 2, targetStage: 'implementation', cwd: CWD, sessionId: '01a14303-cb93-71e0-8098-d73cc4d595c0', handoffAt: HANDOFF_AT, tabTag: 'scaffold-7d019e3f8e78', ...o});

test('successor: the 2026-10-18 case, same tab relaunched as another conversation, is found', () => {
  const panes = [
    piPane('w1:p7', '2026-10-15T08-23-31-125Z', '01a13ea8-c835-775d-b001-632a06624e6b', {tabLabel: '仕様改訂 #2'}),
    piPane('w1:pB', '2026-10-16T04-24-27-785Z', '01a142f4-4788-7517-8261-d992dfe9168f', {tabLabel: '基本設計 v3（引き継ぎ）'}),
    piPane('w1:pD', '2026-10-16T17-22-56-031Z', '01a145bc-fd9f-74d9-b536-8e36d8bc0476', {status: 'working', tabLabel: 'scaffold-7d019e3f8e78'}),
    piPane('w1:p1', '2026-10-17T00-00-00-000Z', '01a14600-0000-7000-8000-000000000000', {cwd: '/elsewhere'}),
  ];
  const r = findSuccessor(lost(), panes, new Set());
  assert.equal(r.kind, 'one');
  assert.equal(r.kind === 'one' && r.pane.paneId, 'w1:pD');
  assert.equal(r.kind === 'one' && r.sessionId, '01a145bc-fd9f-74d9-b536-8e36d8bc0476');
});

test('successor: the tagged tab wins over other later conversations in the same cwd', () => {
  const panes = [
    piPane('w1:pD', '2026-10-16T17-22-56-031Z', 'n1', {tabLabel: 'scaffold-7d019e3f8e78'}),
    piPane('w1:pE', '2026-10-16T18-00-00-000Z', 'n2', {tabLabel: 'other'}),
  ];
  const r = findSuccessor(lost(), panes, new Set());
  assert.equal(r.kind === 'one' && r.pane.paneId, 'w1:pD');
});

test('successor: without a tagged tab, two later conversations in the same cwd are ambiguous', () => {
  const panes = [
    piPane('w1:pD', '2026-10-16T17-22-56-031Z', 'n1'),
    piPane('w1:pE', '2026-10-16T18-00-00-000Z', 'n2'),
  ];
  const r = findSuccessor(lost(), panes, new Set());
  assert.equal(r.kind, 'ambiguous');
  assert.deepEqual(r.kind === 'ambiguous' && r.panes.map(p => p.paneId), ['w1:pD', 'w1:pE']);
});

test('successor: older, other-agent, already-claimed, owner and timeless untagged conversations are not candidates', () => {
  const panes = [
    piPane('w1:p1', '2026-10-16T04-00-00-000Z', 'old'),
    {...piPane('w1:p2', '2026-10-16T17-00-00-000Z', 'c'), agent: 'claude', sessionValue: '0199f3a0-0000-7000-8000-000000000000'},
    piPane('w1:p3', '2026-10-16T17-00-00-000Z', 'claimed'),
    piPane('w1:p4', '2026-10-16T17-00-00-000Z', 'owner'),
    {...piPane('w1:p5', '', ''), sessionValue: '/h/sessions/no-stamp.jsonl'},
  ];
  assert.deepEqual(findSuccessor(lost({ownerSessionId: 'owner'}), panes, new Set(['claimed'])), {kind: 'none'});
  const claude = lost({agent: 'claude', tabTag: undefined});
  assert.equal(findSuccessor(claude, [{socket: '/s', paneId: 'w1:c', agent: 'claude', status: 'idle', sessionValue: '6f1c2a10-1111-4222-8333-444455556666', revision: 1, cwd: CWD}], new Set()).kind, 'none', 'a Claude id without a time needs the tagged tab');
  assert.equal(findSuccessor({...claude, tabTag: 'scaffold-7d019e3f8e78'}, [{socket: '/s', paneId: 'w1:c', agent: 'claude', status: 'idle', sessionValue: '6f1c2a10-1111-4222-8333-444455556666', revision: 1, cwd: CWD, tabLabel: 'scaffold-7d019e3f8e78'}], new Set()).kind, 'one');
});
