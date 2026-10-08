import test from 'node:test';
import assert from 'node:assert/strict';
import {PiGhBridge, readIssue, B_PROPOSAL_TOOLS} from '../src/ports/pi-gh.js';
import {toToolResult} from '../src/core/result.js';
import {renderEpicBlock} from '../src/core/epic-render.js';
import type {ScaffoldStatus} from '../src/core/contracts.js';
import {FakePiGh} from './helpers/fake-pi-gh.js';
import {makeScope} from './helpers/scope.js';
import {initialDoc} from './helpers/docs.js';

const anyData = (v: unknown) => v;
const epicIssue = () => ({number: 10, title: '一覧をCSVで保存できるようにする', body: renderEpicBlock(initialDoc()), labels: ['Type: Scaffold', 'Scope: Epic'], state: 'open' as const});

test('capabilities pass when contract 1 provides every required tool', async () => {
  const gh = new FakePiGh(), bridge = new PiGhBridge(gh.execute);
  const r = await bridge.requireCapabilities(['gh_issue_get', 'gh_subissues_list'], makeScope());
  assert.deepEqual(r, {ok: true, value: undefined});
});

test('one missing capability blocks before any other call', async () => {
  const gh = new FakePiGh(), bridge = new PiGhBridge(gh.execute);
  const r = await bridge.requireCapabilities(['gh_issue_get', ...B_PROPOSAL_TOOLS], makeScope());
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.problems.every(p => p.code === 'CAPABILITY_MISSING'));
  assert.ok(!r.ok && r.problems.some(p => p.message.includes('gh_issue_edit_if_current')));
  assert.deepEqual(gh.calls.map(c => c.name), ['gh_capabilities']);
  gh.enableProposals();
  assert.equal((await new PiGhBridge(gh.execute).requireCapabilities([...B_PROPOSAL_TOOLS], makeScope())).ok, true);
});

test('absent pi-gh or another contract version blocks', async () => {
  const gone = new FakePiGh(); gone.loaded = false;
  const r1 = await new PiGhBridge(gone.execute).requireCapabilities(['gh_issue_get'], makeScope());
  assert.ok(!r1.ok && r1.problems[0]!.code === 'PI_GH_UNAVAILABLE');
  const v2 = new FakePiGh(); v2.contractVersion = 2;
  const r2 = await new PiGhBridge(v2.execute).requireCapabilities(['gh_issue_get'], makeScope());
  assert.ok(!r2.ok && r2.problems[0]!.code === 'CONTRACT_MISMATCH');
});

test('isError is never converted into success', async () => {
  const gh = new FakePiGh();
  gh.overrides.set('gh_issue_get', () => ({...FakePiGh.ok({number: 1}), isError: true}));
  gh.overrides.set('gh_issue_edit', () => ({...FakePiGh.ok({repo: 'example/demo'}, 'applied'), isError: true}));
  const bridge = new PiGhBridge(gh.execute);
  const read = await bridge.call('gh_issue_get', {repo: 'example/demo', issue: 1}, anyData, makeScope());
  assert.equal(read.status, 'blocked'); assert.equal(read.isError, true);
  const write = await bridge.call('gh_issue_edit', {changePath: '/x.json'}, anyData, makeScope());
  assert.equal(write.status, 'unknown'); assert.equal(write.isError, true);
});

test('missing structuredContent: write is unknown, read is blocked', async () => {
  const gh = new FakePiGh();
  const bare = () => ({result: {content: [{type: 'text', text: '{"status":"applied"}'}]}, isError: false});
  gh.overrides.set('gh_issue_edit', bare); gh.overrides.set('gh_issue_get', bare);
  const bridge = new PiGhBridge(gh.execute);
  assert.equal((await bridge.call('gh_issue_edit', {changePath: '/x'}, anyData, makeScope())).status, 'unknown');
  assert.equal((await bridge.call('gh_issue_get', {repo: 'example/demo', issue: 1}, anyData, makeScope())).status, 'blocked');
});

test('decoder failure: write is unknown, read is blocked', async () => {
  const gh = new FakePiGh().add(epicIssue());
  const bridge = new PiGhBridge(gh.execute);
  const reject = () => undefined;
  assert.equal((await bridge.call('gh_issue_close', {changePath: '/x'}, reject, makeScope())).status, 'unknown');
  assert.equal((await bridge.call('gh_issue_get', {repo: 'example/demo', issue: 10}, reject, makeScope())).status, 'blocked');
});

test('pi-gh statuses map onto outcomes', async () => {
  const gh = new FakePiGh(), bridge = new PiGhBridge(gh.execute);
  for (const [status, isError, expected] of [['applied', false, 'ok'], ['created', false, 'ok'], ['noop', false, 'noop'], ['rejected', true, 'blocked'], ['not-started', true, 'blocked'], ['unknown', true, 'unknown']] as const) {
    gh.overrides.set('gh_issue_edit', () => ({result: {content: [], structuredContent: {status, data: {repo: 'example/demo'}}}, isError}));
    assert.equal((await bridge.call('gh_issue_edit', {changePath: '/x'}, anyData, makeScope())).status, expected, status);
  }
});

test('a throwing executor or timeout: write is unknown, read is blocked', async () => {
  const gh = new FakePiGh();
  gh.overrides.set('gh_issue_edit', () => { throw new Error('boom'); });
  gh.overrides.set('gh_issue_get', () => { throw new Error('boom'); });
  const bridge = new PiGhBridge(gh.execute);
  assert.equal((await bridge.call('gh_issue_edit', {changePath: '/x'}, anyData, makeScope())).status, 'unknown');
  assert.equal((await bridge.call('gh_issue_get', {repo: 'example/demo', issue: 1}, anyData, makeScope())).status, 'blocked');
  const slow = new FakePiGh();
  const never = () => new Promise<never>(() => {});
  slow.overrides.set('gh_issue_edit', never); slow.overrides.set('gh_issue_get', never);
  const timed = new PiGhBridge(slow.execute, {timeoutMs: 20});
  const w = await timed.call('gh_issue_edit', {changePath: '/x'}, anyData, makeScope());
  assert.equal(w.status, 'unknown'); assert.ok(w.problems.some(p => p.code === 'TIMEOUT'));
  assert.equal((await timed.call('gh_issue_get', {repo: 'example/demo', issue: 1}, anyData, makeScope())).status, 'blocked');
});

test('an expired or aborted scope makes no call', async () => {
  const gh = new FakePiGh(), bridge = new PiGhBridge(gh.execute);
  const scope = makeScope(); scope.expire();
  assert.equal((await bridge.call('gh_issue_edit', {changePath: '/x'}, anyData, scope)).status, 'cancelled');
  const aborted = makeScope(); aborted.abort();
  assert.equal((await bridge.requireCapabilities(['gh_issue_get'], aborted)).ok, false);
  assert.equal(gh.calls.length, 0);
});

test('readIssue returns the real title and a validated snapshot', async () => {
  const gh = new FakePiGh().add(epicIssue());
  const r = await readIssue('example/demo', 10, new PiGhBridge(gh.execute), makeScope());
  assert.ok(r.ok);
  assert.equal(r.value.title, '一覧をCSVで保存できるようにする');
  assert.equal(r.value.doc.kind, 'epic');
  assert.deepEqual(r.value.labels, ['Scope: Epic', 'Type: Scaffold']);
});

test('readIssue blocks on PRs, missing bodies and direct edits', async () => {
  const gh = new FakePiGh().add(epicIssue()).add({...epicIssue(), number: 11, body: ''}).add({...epicIssue(), number: 12, body: epicIssue().body.replace('## 目的\n利用者', '## 目的\n管理者')});
  gh.overrides.set('gh_issue_get', (args) => (args as {issue: number}).issue === 10 ? FakePiGh.ok({...gh.github(gh.issues.get(10)!), pull_request: {}}) : undefined);
  const bridge = new PiGhBridge(gh.execute);
  const pr = await readIssue('example/demo', 10, bridge, makeScope());
  assert.ok(!pr.ok && pr.problems.some(p => p.code === 'GITHUB_IDENTITY'));
  const empty = await readIssue('example/demo', 11, bridge, makeScope());
  assert.ok(!empty.ok && empty.problems.some(p => p.code === 'INVALID_MANAGED_DOCUMENT'));
  const edited = await readIssue('example/demo', 12, bridge, makeScope());
  assert.ok(!edited.ok && edited.problems.some(p => p.code === 'DOC_PROJECTION_MISMATCH'));
});

test('tool results flag every non-success status as an error', () => {
  for (const status of ['blocked', 'partial', 'unknown', 'cancelled', 'applied', 'noop', 'prepared', 'validated'] as ScaffoldStatus[]) {
    const r = toToolResult({status, operation: 'scaffold_example', problems: []});
    assert.equal(r.isError, ['blocked', 'partial', 'unknown', 'cancelled'].includes(status), status);
    assert.equal((r.structuredContent as {status: string}).status, status);
    assert.equal(r.content[0]!.type, 'text');
  }
});

test('interactive writes wait for human approval beyond the call limit; reads and headless writes do not', async () => {
  const gh = new FakePiGh();
  const late = (data: unknown, status: string) => () => new Promise<ReturnType<typeof FakePiGh.ok>>(r => setTimeout(() => r(FakePiGh.ok(data, status)), 60));
  gh.overrides.set('gh_issue_edit', late({repo: 'example/demo'}, 'applied'));
  gh.overrides.set('gh_issue_get', late({}, 'read'));
  const interactive = new PiGhBridge(gh.execute, {timeoutMs: 20, interactiveWrites: true});
  assert.equal((await interactive.call('gh_issue_edit', {changePath: '/x'}, anyData, makeScope())).status, 'ok');
  assert.equal((await interactive.call('gh_issue_get', {repo: 'example/demo', issue: 1}, anyData, makeScope())).status, 'blocked');
  const headless = new PiGhBridge(gh.execute, {timeoutMs: 20});
  assert.equal((await headless.call('gh_issue_edit', {changePath: '/x'}, anyData, makeScope())).status, 'unknown');
  const scope = makeScope();
  const pending = interactive.call('gh_issue_edit', {changePath: '/x'}, anyData, scope);
  scope.abort();
  assert.equal((await pending).status, 'unknown', 'a cancelled in-flight write is never assumed not to have happened');
});
