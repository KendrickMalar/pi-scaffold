import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile, readFile, readdir, lstat, chmod, symlink, readlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join, dirname} from 'node:path';
import * as runtimeModule from '../src/core/runtime.js';
import * as contextModule from '../src/core/repo-context.js';
import {createRuntime, ToolCall, type ToolEnv} from '../src/core/runtime.js';
import {createCallScope} from '../src/core/lifecycle.js';
import {loadOwnerPolicy, type OwnerPolicy} from '../src/core/model-bindings.js';
import {sha256Text} from '../src/core/digests.js';
import {writeOwnedFile} from '../src/core/files.js';
import {evidenceRootOf, readEvidence} from '../src/core/evidence.js';
import {WatchRegistry} from '../src/watch/registry.js';
import {INITIAL_PROGRESS, type WatchEntry} from '../src/watch/decide.js';
import {StageWatcher} from '../src/watch/watcher.js';
import {acceptStartupPacket, recordTurnStarted, promptTag} from '../src/handoff/receiver.js';
import {writePacket, readPacket, readReceipt, nonceSha256, type HandoffPacketV1} from '../src/handoff/packet.js';
import {unsafeLaunchValues} from '../src/handoff/launcher.js';
import {renderEpicBlock} from '../src/core/epic-render.js';
import {labelDefinitions} from '../src/core/label-definitions.js';
import {createHarness, loadToolModule} from './helpers/harness.js';
import {FakeHerdr} from './helpers/fake-herdr.js';
import {FakePiGh} from './helpers/fake-pi-gh.js';
import {WORKFLOW_ID, OPERATION_ID, initialDoc, populatedDoc} from './helpers/docs.js';

// Structural future-API signatures keep baseline compilation valid. They do not mock implementation:
// missing exports/options fail runtime assertions, rather than preventing all tests from executing.
type Resolve = (env: Record<string, string | undefined>, agentDir: string) => string;
function resolveDir(): Resolve {
  const exports = {...contextModule, ...runtimeModule} as Record<string, unknown>;
  assert.equal(typeof exports.resolveScaffoldDir, 'function', 'resolveScaffoldDir must be exported');
  return exports.resolveScaffoldDir as Resolve;
}
const Registry = WatchRegistry as unknown as new (agentDir: string, scaffoldDir?: string) => WatchRegistry;
const loadPolicy = loadOwnerPolicy as (agentDir: string, scaffoldDir?: string) => ReturnType<typeof loadOwnerPolicy>;
const policy: OwnerPolicy = {version: 1, repos: {'example/demo': {authMode: 'file-backed', models: []}}};
const profile = (id = 'developer') => ({type: 'custom', customType: 'startup-profile-state', data: {version: 1, id, label: id, instructions: '合成の開発指示'}});
const entry = (paneId = 'w9:p2', owner = 'parent'): WatchEntry => ({ownerSessionId: owner, paneId, tabId: 'w9:t2', workspaceId: 'w9', targetSessionId: `s-${paneId}`, cwd: '/synthetic/repo', repo: 'example/demo', epicIssue: 10, targetStage: 'specification', addedAt: '2026-10-12T00:00:00.000Z'});
type Cleanup = {after(fn: () => Promise<void>): void};
async function fixture(t: Cleanup) {
  const base = join(process.cwd(), '.task-artifacts', 'tmp');
  await mkdir(base, {recursive: true, mode: 0o700});
  const home = await mkdtemp(join(base, 'storage-dir-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const agentDir = join(home, 'auth-agent'), scaffoldDir = join(home, 'shared'), legacy = join(agentDir, 'pi-scaffold');
  for (const dir of [agentDir, scaffoldDir, legacy]) await mkdir(dir, {recursive: true, mode: 0o700});
  await writeFile(join(scaffoldDir, 'policy.json'), JSON.stringify(policy), {mode: 0o600});
  return {home, agentDir, scaffoldDir, legacy};
}
function callFor(agentDir: string, scaffoldDir?: string) {
  const git = {
    run: async () => ({code: 1, stdout: ''}),
    repoIdentity: async () => ({repoRoot: '/synthetic/repo', gitCommonDir: '/synthetic/repo/.git', origin: 'https://github.com/example/demo.git'}),
    readBlob: async () => undefined, listTree: async () => [],
  };
  const options = {agentDir, git, env: {}, ...(scaffoldDir === undefined ? {} : {scaffoldDir})};
  const runtime = createRuntime(options);
  const scope = createCallScope(runtime.scope, () => ({sessionId: 'parent', leafId: 'leaf'}));
  const env: ToolEnv = {
    cwd: '/synthetic/repo', isProjectTrusted: () => true,
    executeTool: async () => { throw new Error('No remote tool permitted in local contract test'); },
    approvalUi: {interactive: true, confirm: async () => true}, identity: () => ({sessionId: 'parent', leafId: 'leaf'}),
    sessionEntries: () => [profile()], availableModels: () => [], scopedModels: () => [], toolNames: () => [], currentModel: () => undefined,
  };
  return {runtime, scope, call: new ToolCall(runtime, env, scope)};
}

// Catches fallback on explicitly invalid input and accidental shell expansion.
test('resolveScaffoldDir defaults only when absent, preserves absolute literals and rejects explicit empty/relative/control', () => {
  const resolve = resolveDir();
  assert.equal(resolve({}, '/auth/agent'), '/auth/agent/pi-scaffold');
  assert.equal(resolve({PI_SCAFFOLD_DIR: undefined}, '/auth/agent'), '/auth/agent/pi-scaffold');
  for (const path of ['/shared/scaffold', '/shared/$HOME', '/shared/~/literal']) assert.equal(resolve({PI_SCAFFOLD_DIR: path}, '/auth/agent'), path);
  for (const path of ['', 'relative', '~/scaffold', '$HOME/scaffold', '/shared/\0bad', '/shared/\nbad', '/shared/\tbad', '/shared/\rbad', '/shared/\x7fbad']) {
    assert.throws(() => resolve({PI_SCAFFOLD_DIR: path}, '/auth/agent'), JSON.stringify(path));
  }
});

test('createRuntime honors env and explicit scaffoldDir without changing agentDir', async t => {
  const f = await fixture(t);
  const fromEnv = createRuntime({env: {PI_CODING_AGENT_DIR: f.agentDir, PI_SCAFFOLD_DIR: f.scaffoldDir}, home: f.home});
  assert.equal(fromEnv.agentDir, f.agentDir);
  assert.equal((fromEnv as unknown as {scaffoldDir: string}).scaffoldDir, f.scaffoldDir, 'PI_SCAFFOLD_DIR must choose the 保存先');
  const options = {env: {PI_CODING_AGENT_DIR: f.agentDir, PI_SCAFFOLD_DIR: f.legacy}, scaffoldDir: f.scaffoldDir};
  const explicit = createRuntime(options);
  assert.equal((explicit as unknown as {scaffoldDir: string}).scaffoldDir, f.scaffoldDir);
  const bad = {agentDir: f.agentDir, env: {}, scaffoldDir: ''};
  assert.throws(() => createRuntime(bad), 'explicit empty scaffoldDir must not fall back');
});

test('policy reads only the explicit 保存先 and legacy callers remain compatible', async t => {
  const f = await fixture(t);
  const legacyPolicy: OwnerPolicy = {version: 1, repos: {'other/demo': {authMode: 'file-backed', models: []}}};
  await writeFile(join(f.legacy, 'policy.json'), JSON.stringify(legacyPolicy), {mode: 0o600});
  assert.deepEqual(await loadPolicy(f.agentDir, f.scaffoldDir), {ok: true, value: policy});
  assert.deepEqual(await loadOwnerPolicy(f.agentDir), {ok: true, value: legacyPolicy});
  await chmod(join(f.scaffoldDir, 'policy.json'), 0o644);
  const insecure = await loadPolicy(f.agentDir, f.scaffoldDir);
  assert.ok(!insecure.ok && insecure.problems.some(p => p.code === 'INSECURE_MODE'), 'must not fall back to legacy policy');
});

test('context, approvals and journal use scaffoldDir but account binding stays at realpath(agentDir)', async t => {
  const f = await fixture(t);
  await writeFile(join(f.legacy, 'policy.json'), JSON.stringify(policy), {mode: 0o600});
  const moved = callFor(f.agentDir, f.scaffoldDir), old = callFor(f.agentDir);
  t.after(async () => { moved.scope.dispose(); old.scope.dispose(); });
  const a = await moved.call.repoContext('example/demo', WORKFLOW_ID), b = await old.call.repoContext('example/demo', WORKFLOW_ID);
  assert.ok(a.ok && b.ok, JSON.stringify({a, b}));
  assert.equal(moved.call.namespaceRoot, f.scaffoldDir, 'namespace 保存先 must be shared');
  assert.ok(a.value.workflowStateRoot.startsWith(join(f.scaffoldDir, 'state') + '/'));
  assert.equal(a.value.workflowStateRoot.slice(f.scaffoldDir.length), b.value.workflowStateRoot.slice(f.legacy.length));
  assert.equal(a.value.accountBinding, b.value.accountBinding);
  assert.equal(moved.runtime.agentDir, f.agentDir);
  const view = {contentDigest: 'a'.repeat(64), text: '承認対象（合成）'};
  const approved = await moved.call.approvals.confirmContent('specification', WORKFLOW_ID, view, a.value, moved.call.env.approvalUi, moved.scope);
  assert.equal(approved.status, 'validated'); assert.ok(approved.data);
  const digest = approved.data.viewDigest;
  const approvalPath = join(a.value.workflowStateRoot, 'approvals', 'specification', digest + '.json');
  assert.equal((await lstat(approvalPath)).mode & 0o777, 0o600);
  assert.ok((await moved.call.approvals.requireContentApproval('specification', WORKFLOW_ID, digest, a.value)).ok);
  for (const changed of [{...a.value, accountBinding: 'f'.repeat(64)}, {...a.value, profileId: 'reviewer'}]) {
    const rejected = await moved.call.approvals.requireContentApproval('specification', WORKFLOW_ID, digest, changed);
    assert.ok(!rejected.ok && rejected.problems.some(p => p.code === 'APPROVAL_MISMATCH'));
  }
  const begun = await moved.call.journal(a.value).begin({repo: 'example/demo', workflowId: WORKFLOW_ID, operationId: OPERATION_ID, operation: 'contract', payloadDigest: 'b'.repeat(64)});
  assert.equal(begun.kind, 'new');
  assert.equal((await lstat(join(a.value.workflowStateRoot, 'operations', OPERATION_ID + '.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(f.legacy), ['policy.json'], 'no private state written to auth-agent');
});

test('explicit watch root is shared, retries survive re-upsert and the legacy root is untouched', async t => {
  const f = await fixture(t), r = new Registry(f.agentDir, f.scaffoldDir);
  await r.upsert(entry());
  await r.update({entry: entry(), progress: {...INITIAL_PROGRESS, retryCount: 3}});
  await new Registry(f.agentDir, f.scaffoldDir).upsert(entry());
  assert.equal(r.path, join(f.scaffoldDir, 'state', 'watches.json'));
  assert.equal((await r.load()).records[0]?.progress.retryCount, 3);
  assert.equal((await lstat(r.path)).mode & 0o777, 0o600);
  assert.equal((await lstat(dirname(r.path))).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(f.legacy), []);
});

test('uncreated explicit watch ledger emits no warning and another owner watch is not acted on', async t => {
  const f = await fixture(t), r = new Registry(f.agentDir, f.scaffoldDir), herdr = new FakeHerdr(), notices: string[] = [];
  const watcher = new StageWatcher({ownerSessionId: 'parent', registry: r, herdr, readTail: async () => { throw new Error('foreign watch must never be read'); }, notify: text => { notices.push(text); }, now: () => 0});
  t.after(async () => watcher.stop());
  assert.deepEqual(await r.load(), {records: [], corrupt: false});
  await watcher.resume(); await watcher.tick();
  assert.deepEqual(notices, []); assert.equal(watcher.active, false);
  await r.upsert(entry('w9:p3', 'other-owner'));
  const before = await readFile(r.path);
  await watcher.tick();
  assert.deepEqual(await readFile(r.path), before); assert.deepEqual(herdr.calls, []); assert.deepEqual(notices, []);
  assert.equal(r.path, join(f.scaffoldDir, 'state', 'watches.json'));
});

// FS refusal is not corrupt JSON: no rename/overwrite may occur, even on remove/update.
for (const refusal of ['file-symlink', 'state-symlink', 'root-symlink', 'file-mode', 'state-mode', 'fifo', 'size'] as const) {
  test(`watch scaffoldDir refuses ${refusal} without changing bytes or names`, async t => {
    const f = await fixture(t), state = join(f.scaffoldDir, 'state'), target = join(f.home, 'target');
    await mkdir(state, {mode: 0o700}); await mkdir(target, {mode: 0o700});
    const file = join(state, 'watches.json'), bytes = JSON.stringify({version: 1, watches: [{entry: entry(), progress: INITIAL_PROGRESS}]});
    let root = f.scaffoldDir, observed = file;
    if (refusal === 'file-symlink') { observed = join(target, 'original'); await writeFile(observed, bytes, {mode: 0o600}); await symlink(observed, file); }
    else if (refusal === 'state-symlink') { await rm(state, {recursive: true}); await symlink(target, state); await writeFile(file, bytes, {mode: 0o600}); }
    else if (refusal === 'root-symlink') { root = join(f.home, 'linked-root'); await symlink(f.scaffoldDir, root); await writeFile(file, bytes, {mode: 0o600}); }
    else if (refusal === 'fifo') execFileSync('mkfifo', [file]);
    else await writeFile(file, refusal === 'size' ? 'x'.repeat(2 * 1024 * 1024 + 1) : bytes, {mode: 0o600});
    if (refusal === 'file-mode') await chmod(file, 0o644);
    if (refusal === 'state-mode') await chmod(state, 0o755);
    const beforeNames = await readdir(state), beforeStat = await lstat(file), before = refusal === 'fifo' ? undefined : await readFile(observed);
    const link = beforeStat.isSymbolicLink() ? await readlink(file) : undefined;
    const r = new Registry(f.agentDir, root);
    // Each mutation must reject; checking after each prevents a destructive first mutation being hidden.
    for (const mutate of [() => r.upsert(entry('w9:p8')), () => r.update({entry: entry(), progress: {...INITIAL_PROGRESS, retryCount: 9}}), () => r.remove(entry())]) {
      await assert.rejects(mutate, `${refusal}: FS refusal must not be renamed as corruption`);
      assert.deepEqual(await readdir(state), beforeNames);
      assert.equal((await lstat(file)).ino, beforeStat.ino);
      if (before) assert.deepEqual(await readFile(observed), before);
      if (link) assert.equal(await readlink(file), link);
    }
  });
}

test('true malformed watch record is quarantined while good records and retryCount survive at scaffoldDir', async t => {
  const f = await fixture(t), r = new Registry(f.agentDir, f.scaffoldDir);
  await mkdir(dirname(r.path), {recursive: true, mode: 0o700});
  const original = JSON.stringify({version: 1, watches: [{entry: entry(), progress: {...INITIAL_PROGRESS, retryCount: 2}}, {entry: {paneId: 3}}]});
  await writeFile(r.path, original, {mode: 0o600});
  await r.upsert(entry('w9:p3'));
  const names = (await readdir(dirname(r.path))).filter(n => n.startsWith('watches.json.corrupt-'));
  assert.equal(names.length, 1);
  assert.equal(await readFile(join(dirname(r.path), names[0]!), 'utf8'), original);
  const loaded = await r.load(); assert.equal(loaded.corrupt, false);
  assert.equal(loaded.records.find(r => r.entry.paneId === 'w9:p2')?.progress.retryCount, 2);
  assert.equal(r.path, join(f.scaffoldDir, 'state', 'watches.json'));
});

async function packetFixture(t: Cleanup) {
  const f = await fixture(t), {call, scope} = callFor(f.agentDir);
  t.after(async () => scope.dispose());
  // Derive the account binding independently of the new storage-root path contract.
  await writeFile(join(f.legacy, 'policy.json'), JSON.stringify(policy), {mode: 0o600});
  const context = await call.repoContext('example/demo', WORKFLOW_ID); assert.ok(context.ok); assert.ok(context.value.accountBinding);
  const packet: HandoffPacketV1 = {version: 1, nonce: '1'.repeat(64), workflowId: WORKFLOW_ID, repo: 'example/demo', epicIssue: 10, sourceStage: 'setup', targetStage: 'specification', artifactDigests: {epicBodySha256: 'a'.repeat(64), epicLabelsSha256: 'b'.repeat(64)}, cwd: '/synthetic/repo', profileId: 'developer', profileInstructionsDigest: sha256Text('合成の開発指示'), accountBinding: context.value.accountBinding, requiredTools: ['scaffold_handoff_specification'], resourceRefs: []};
  const dir = join(f.scaffoldDir, 'state', 'workflow', 'handoff', OPERATION_ID), written = await writePacket(dir, packet, f.scaffoldDir);
  const input = {packetPath: written.path, agentDir: f.agentDir, scaffoldDir: f.scaffoldDir, cwd: packet.cwd, sessionId: 'target', sessionEntries: [profile()], toolNames: packet.requiredTools, policy};
  return {...f, packet, dir, written, input};
}

test('receiver accepts explicit scaffoldDir, writes matching ready/started receipts and rejects foreign root/account/profile', async t => {
  const f = await packetFixture(t), accepted = await acceptStartupPacket(f.input);
  assert.ok(accepted.ok, `scaffoldDir receiver: ${JSON.stringify(accepted)}`);
  assert.equal(accepted.value.packetSha256, f.written.sha256);
  const ready = await readReceipt(f.dir, 'receiver-ready', f.scaffoldDir); assert.ok(ready);
  assert.equal(ready.nonceSha256, sha256Text('1'.repeat(64))); assert.equal(ready.packetSha256, f.written.sha256); assert.equal(ready.sessionId, 'target');
  assert.equal((await lstat(join(f.dir, 'ready.json'))).mode & 0o777, 0o600);
  assert.equal(await recordTurnStarted({...f.input, prompt: 'unrelated'}), false);
  assert.equal(await recordTurnStarted({...f.input, sessionId: 'other', prompt: promptTag(ready.nonceSha256)}), false);
  assert.equal(await recordTurnStarted({...f.input, prompt: promptTag(ready.nonceSha256)}), true);
  const started = await readReceipt(f.dir, 'turn-started', f.scaffoldDir); assert.ok(started);
  assert.equal(started.packetSha256, f.written.sha256); assert.equal(started.nonceSha256, ready.nonceSha256);
  assert.equal(await recordTurnStarted({...f.input, prompt: promptTag(ready.nonceSha256)}), false);
  for (const input of [{...f.input, scaffoldDir: f.legacy}, {...f.input, agentDir: f.home}, {...f.input, sessionEntries: [profile('reviewer')]}]) assert.equal((await acceptStartupPacket(input)).ok, false);
});

test('launch safety checks include explicit auth and scaffoldDir values', () => {
  for (const field of ['agentDir', 'scaffoldDir'] as const) {
    for (const value of ["/x/';touch INJECTED;#", '/x/$(id)', '/x/a b', '/x/\nbad']) {
      const values = {packetPath: '/safe/packet.json', agentDir: '/safe/auth', scaffoldDir: '/safe/shared', [field]: value};
      assert.ok(unsafeLaunchValues(values).includes(field), `${field} injection must be refused`);
    }
  }
});

for (const tamper of ['none', 'nonceSha256', 'packetSha256'] as const) {
test(`real handoff driver propagates auth/scaffoldDir and verifies receipts: ${tamper}`, async t => {
  const f = await fixture(t), gh = new FakePiGh().seedLabels(labelDefinitions()).enableProposals(), herdr = new FakeHerdr();
  gh.add({number: 10, title: '合成の目的', body: renderEpicBlock(initialDoc()), labels: ['Type: Scaffold', 'Scope: Epic'], state: 'open'});
  const tools = ['gh_capabilities', 'gh_issue_get', 'gh_issue_edit_if_current', 'gh_issue_labels_if_current', 'scaffold_labels_ensure', 'scaffold_epic_draft_create', 'scaffold_handoff_specification'];
  const {createTool} = await loadToolModule('extensions/tools/handoff-specification.ts');
  const h = await createHarness(createTool, {scenario: {agentDir: f.agentDir, gh, herdr, policy, sessionEntries: [profile()], tools, environment: {HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w9', HERDR_PANE_ID: 'w9:pA', HERDR_SOCKET_PATH: '/synthetic/herdr.sock', PI_SCAFFOLD_DIR: f.scaffoldDir}, waitMs: 300, pollMs: 10}});
  t.after(h.dispose);
  Object.assign(h.runtime, {scaffoldDir: f.scaffoldDir});
  let packetPath = '';
  herdr.onPaneRun = async (_pane, command) => {
    assert.ok(command.includes(`PI_CODING_AGENT_DIR='${f.agentDir}'`), 'original auth directory must be propagated');
    assert.ok(command.includes(`PI_SCAFFOLD_DIR='${f.scaffoldDir}'`), 'shared 保存先 must be propagated');
    packetPath = /--scaffold-handoff '([^']+)'/.exec(command)?.[1] ?? '';
    assert.ok(packetPath.startsWith(f.scaffoldDir + '/'));
    const input = {packetPath, agentDir: f.agentDir, scaffoldDir: f.scaffoldDir, cwd: '/synthetic/repo', sessionId: 'target-session', sessionEntries: [profile()], toolNames: tools, policy};
    assert.ok((await acceptStartupPacket(input)).ok);
    if (tamper !== 'none') {
      const readyPath = join(dirname(packetPath), 'ready.json');
      const ready = JSON.parse(await readFile(readyPath, 'utf8')) as Record<string, unknown>;
      await writeFile(readyPath, JSON.stringify({...ready, [tamper]: 'e'.repeat(64)}));
    }
  };
  herdr.onPrompt = async (_pane, prompt) => {
    const input = {packetPath, agentDir: f.agentDir, scaffoldDir: f.scaffoldDir, sessionId: 'target-session', prompt};
    assert.equal(await recordTurnStarted(input), true);
  };
  const out = await h.invoke({repo: 'example/demo', epicIssue: 10, operationId: OPERATION_ID, expectedRevision: 1, expectedBodySha256: sha256Text(gh.issues.get(10)!.body), expectedStage: 'setup', nextStage: 'specification'});
  if (tamper !== 'none') {
    assert.notEqual(out.r.status, 'applied', 'a mismatched nonce/hash receipt must not commit the stage');
    assert.ok(packetPath.startsWith(f.scaffoldDir + '/'), 'must reach explicit-root receiver');
    assert.equal(herdr.count('agentPrompt'), 0);
    assert.equal(gh.conditionalChanges.length, 0);
    return;
  }
  assert.equal(out.r.status, 'applied', `scaffoldDir driver: ${JSON.stringify(out.r.problems)}`);
  const read = await readPacket(packetPath, f.scaffoldDir); assert.ok(read.ok);
  const dir = dirname(packetPath), ready = await readReceipt(dir, 'receiver-ready', f.scaffoldDir), started = await readReceipt(dir, 'turn-started', f.scaffoldDir);
  assert.equal(ready?.packetSha256, read.value.sha256); assert.equal(started?.nonceSha256, nonceSha256(read.value.packet.nonce));
  assert.equal(started?.sessionId, 'target-session');
  assert.deepEqual(await readdir(f.legacy), ['policy.json']);
  assert.equal((await lstat(packetPath)).mode & 0o777, 0o600);
});
}

test('legacy registry also refuses insecure FS without renaming the original', async t => {
  const f = await fixture(t), r = new WatchRegistry(f.agentDir);
  await mkdir(dirname(r.path), {mode: 0o700});
  const original = JSON.stringify({version: 1, watches: [{entry: entry(), progress: INITIAL_PROGRESS}]});
  await writeFile(r.path, original, {mode: 0o644});
  const names = await readdir(dirname(r.path));
  await assert.rejects(() => r.upsert(entry('w9:p3')), 'INSECURE_MODE must not be treated as corruption');
  assert.deepEqual(await readdir(dirname(r.path)), names);
  assert.equal(await readFile(r.path, 'utf8'), original);
});

test('research tool writes planned edit and journal to explicit scaffoldDir, not auth-agent', async t => {
  const f = await fixture(t), gh = new FakePiGh().seedLabels(labelDefinitions()).enableProposals();
  const doc = populatedDoc();
  doc.stage = 'specification'; doc.revision = 3; doc.design = null; doc.dependencyPlan = null; doc.wavePlan = null; doc.handoff = null;
  gh.add({number: 10, title: '合成の目的', body: renderEpicBlock(doc), labels: ['Type: Scaffold', 'Scope: Epic', 'Stage: Specification'], state: 'open'});
  const {createTool} = await loadToolModule('extensions/tools/research-begin.ts');
  const h = await createHarness(createTool, {scenario: {agentDir: f.agentDir, gh, policy, sessionEntries: [profile()]}});
  t.after(h.dispose); Object.assign(h.runtime, {scaffoldDir: f.scaffoldDir});
  const out = await h.invoke({repo: 'example/demo', epicIssue: 10, operationId: OPERATION_ID, expectedRevision: 3, expectedBodySha256: sha256Text(gh.issues.get(10)!.body), researchIds: ['R002']});
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  const context = callFor(f.agentDir, f.scaffoldDir); t.after(async () => context.scope.dispose());
  const c = await context.call.repoContext('example/demo', WORKFLOW_ID); assert.ok(c.ok);
  const planned = join(c.value.workflowStateRoot, 'research-begin', OPERATION_ID, 'epic-body.json');
  assert.ok(planned.startsWith(f.scaffoldDir + '/'), 'research 保存先 must be shared');
  assert.equal((await lstat(planned)).mode & 0o777, 0o600);
  assert.equal((await lstat(join(c.value.workflowStateRoot, 'operations', OPERATION_ID + '.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(f.legacy), ['policy.json']);
});

test('evidence at derived scaffoldDir verifies actual report/log hashes and refuses tampering', async t => {
  const f = await fixture(t), {call, scope} = callFor(f.agentDir, f.scaffoldDir);
  t.after(async () => scope.dispose());
  const c = await call.repoContext('example/demo', WORKFLOW_ID); assert.ok(c.ok);
  const evidenceRoot = evidenceRootOf(c.value.workflowStateRoot);
  assert.ok(evidenceRoot.startsWith(f.scaffoldDir + '/'), 'evidence 保存先 must be shared');
  const log = '合成テストログ\n';
  const report = JSON.stringify({version: 1, workflowId: WORKFLOW_ID, featureIssue: 11, productRef: 'c'.repeat(40), suiteRef: 'd'.repeat(40), criteria: [{id: 'AC101', status: 'pass', command: 'synthetic test', exitCode: 0, logPath: 'test.log', logSha256: sha256Text(log)}]});
  await writeOwnedFile(join(evidenceRoot, 'report.json'), report, {root: call.namespaceRoot});
  await writeOwnedFile(join(evidenceRoot, 'test.log'), log, {root: call.namespaceRoot});
  const refs = [{relativePath: 'report.json', sha256: sha256Text(report)}];
  const good = await readEvidence(refs, evidenceRoot, call.namespaceRoot);
  assert.deepEqual(good.problems, []); assert.equal(good.reports.length, 1);
  await writeFile(join(evidenceRoot, 'test.log'), 'changed');
  assert.ok((await readEvidence(refs, evidenceRoot, call.namespaceRoot)).problems.some(p => p.code === 'LOG_HASH_MISMATCH'));
  assert.ok((await readEvidence([{...refs[0]!, sha256: 'e'.repeat(64)}], evidenceRoot, call.namespaceRoot)).problems.some(p => p.code === 'REPORT_HASH_MISMATCH'));
});

for (const bad of ['symlink', 'mode', 'fifo', 'size', 'encoding', 'json'] as const) {
  test(`receiver at scaffoldDir rejects ${bad} packet before writing ready`, async t => {
    const f = await packetFixture(t);
    const accepted = await acceptStartupPacket(f.input);
    assert.ok(accepted.ok, `must first reach scaffoldDir receiver: ${JSON.stringify(accepted)}`);
    // Use a fresh directory: this malformed packet must produce no ready receipt.
    const dir = join(f.scaffoldDir, 'bad-packet'), path = join(dir, 'packet.json');
    await mkdir(dir, {mode: 0o700});
    if (bad === 'symlink') await symlink(f.written.path, path);
    else if (bad === 'fifo') execFileSync('mkfifo', [path]);
    else await writeFile(path, bad === 'encoding' ? Buffer.from([0xff, 0xfe]) : bad === 'json' ? '{not json' : bad === 'size' ? 'x'.repeat(65537) : JSON.stringify(f.packet), {mode: bad === 'mode' ? 0o644 : 0o600});
    const before = await readdir(dir);
    assert.equal((await acceptStartupPacket({...f.input, packetPath: path})).ok, false);
    assert.deepEqual(await readdir(dir), before, 'rejected packet must create no receipt');
  });
}

test('policy rejects explicit scaffoldDir symlink and non-directory root rather than falling back', async t => {
  const f = await fixture(t), linked = join(f.home, 'linked'), file = join(f.home, 'not-directory');
  await symlink(f.scaffoldDir, linked); await writeFile(file, 'root bytes', {mode: 0o600});
  for (const root of [linked, file]) {
    const result = await loadPolicy(f.agentDir, root);
    assert.equal(result.ok, false, `scaffoldDir must be an actual directory: ${root}`);
  }
});
