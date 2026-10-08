import test from 'node:test';
import assert from 'node:assert/strict';
import {stat, writeFile} from 'node:fs/promises';
import {createHarness, loadToolModule, type Scenario} from './helpers/harness.js';
import {FakePiGh} from './helpers/fake-pi-gh.js';
import {FakeHerdr} from './helpers/fake-herdr.js';
import {renderEpicBlock, composeManagedBlock} from '../src/core/epic-render.js';
import {parseIssueBody} from '../src/core/body-codec.js';
import {sha256Text} from '../src/core/digests.js';
import {labelDefinitions} from '../src/core/label-definitions.js';
import {acceptStartupPacket, recordTurnStarted} from '../src/handoff/receiver.js';
import type {EpicDocV1} from '../src/core/contracts.js';
import type {OwnerPolicy} from '../src/core/model-bindings.js';
import {initialDoc, populatedDoc, OPERATION_ID} from './helpers/docs.js';

const policy: OwnerPolicy = {version: 1, repos: {'example/demo': {authMode: 'file-backed', models: []}}};
const profile = (id = 'developer', instructions = '開発用（架空）') => ({type: 'custom', customType: 'startup-profile-state', data: {version: 1, id, label: id, instructions}});
const environment = {HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w9', HERDR_PANE_ID: 'w9:pA', HERDR_SOCKET_PATH: '/synthetic/herdr.sock'};
const TOOLS = ['gh_capabilities', 'gh_issue_get', 'gh_issue_edit_if_current', 'gh_issue_labels_if_current', 'scaffold_labels_ensure', 'scaffold_epic_draft_create', 'scaffold_handoff_specification'];

function epicBody(mutate: (d: EpicDocV1) => void = () => {}) { const d = initialDoc(); mutate(d); return renderEpicBlock(d); }
function world(body = epicBody(), labels = ['Type: Scaffold', 'Scope: Epic'], title = '一覧をCSVで保存できるようにする') {
  const gh = new FakePiGh().seedLabels(labelDefinitions()).enableProposals();
  gh.add({number: 10, title, body, labels, state: 'open'});
  return gh;
}
const params = (gh: FakePiGh, extra: Record<string, unknown> = {}) => ({
  repo: 'example/demo', epicIssue: 10, operationId: OPERATION_ID, expectedRevision: 1,
  expectedBodySha256: sha256Text(gh.issues.get(10)!.body), expectedStage: 'setup', nextStage: 'specification', ...extra,
});
/** The receiving Pi, simulated with the real receiver code: ready on launch, started on the first prompt. */
function receiver(herdr: FakeHerdr, agentDir: () => string, opts: {ready?: boolean; started?: boolean; entries?: unknown[]; tools?: string[]; cwd?: string} = {}) {
  let packetPath = '';
  herdr.onPaneRun = async (_pane, command) => {
    packetPath = /--scaffold-handoff '([^']+)'/.exec(command)![1]!;
    if (opts.ready === false) return;
    const r = await acceptStartupPacket({packetPath, agentDir: agentDir(), cwd: opts.cwd ?? '/synthetic/repo', sessionId: 'target-session', sessionEntries: opts.entries ?? [profile()], toolNames: opts.tools ?? TOOLS, policy});
    assert.ok(r.ok || opts.cwd || opts.entries || opts.tools, JSON.stringify(r));
  };
  herdr.onPrompt = async (_pane, text) => { if (opts.started !== false) await recordTurnStarted({packetPath, agentDir: agentDir(), sessionId: 'target-session', prompt: text}); };
  return {packetPath: () => packetPath};
}
async function harness(t: {after(fn: () => Promise<void>): void}, gh: FakePiGh, herdr: FakeHerdr, scenario: Scenario = {}) {
  const {createTool} = await loadToolModule('extensions/tools/handoff-specification.ts');
  const h = await createHarness(createTool, {scenario: {gh, herdr, policy, sessionEntries: [profile()], environment, tools: TOOLS, waitMs: 300, pollMs: 10, defaultParams: params(gh), ...scenario}});
  t.after(h.dispose);
  return h;
}
const noLaunch = (herdr: FakeHerdr) => { assert.equal(herdr.tabCreates, 0); assert.equal(herdr.count('paneRun'), 0); assert.equal(herdr.count('agentPrompt'), 0); };

test('a valid setup Epic is handed to a new Specification session and only started counts', async t => {
  const gh = world(), herdr = new FakeHerdr();
  let agentDir = '';
  const rx = receiver(herdr, () => agentDir);
  const h = await harness(t, gh, herdr); agentDir = h.agentDir;
  const out = await h.invoke();
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.deepEqual(Object.keys(out.r.data as object).sort(), ['nonceSha256', 'paneId', 'phase', 'tabId', 'targetSessionId']);
  assert.equal((out.r.data as {phase: string}).phase, 'turn-started');
  assert.equal(herdr.tabCreates, 1);
  const tab = herdr.calls.find(c => c.command === 'tabCreate')!.args as {workspaceId: string; cwd: string; label: string};
  assert.deepEqual([tab.workspaceId, tab.cwd], ['w9', '/synthetic/repo']);
  const run = herdr.calls.find(c => c.command === 'paneRun')!.args as {paneId: string; command: string};
  assert.equal(run.paneId, 'w9:p2', 'runs only in the root pane of the created tab');
  assert.match(run.command, /^pi-profile launch --profile developer -- --scaffold-handoff '[^']+' --model 'example-provider\/planner-1' --thinking 'medium'$/);
  assert.equal((await stat(rx.packetPath())).mode & 0o777, 0o600);
  const doc = (parseIssueBody(gh.issues.get(10)!.body) as {ok: true; value: {doc: EpicDocV1}}).value.doc;
  assert.equal(doc.stage, 'specification');
  assert.equal(doc.revision, 2);
  assert.equal(doc.handoff?.nonceSha256, (out.r.data as {nonceSha256: string}).nonceSha256);
  assert.ok(!JSON.stringify(doc).includes(JSON.parse(await (await import('node:fs/promises')).readFile(rx.packetPath(), 'utf8')).nonce), 'the nonce itself never reaches the Issue');
  assert.deepEqual(gh.issues.get(10)!.labels.sort(), ['Scope: Epic', 'Stage: Specification', 'Type: Scaffold']);
  assert.ok(out.ghWrites >= 2);
});

test('a minimal draft with unanswered questions and pending research is accepted', async t => {
  const body = epicBody(d => { d.questions = [{questionId: 'Q001', kind: 'question', question: '対象は？', answer: null, required: true, sourceRef: null}]; d.research = [{researchId: 'R001', question: 'q', requiredEvidence: 'e', doneCondition: 'd', state: 'pending', claim: null, conclusion: null, evidenceRefs: [], limitations: []}]; });
  const gh = world(body), herdr = new FakeHerdr();
  let agentDir = ''; receiver(herdr, () => agentDir);
  const h = await harness(t, gh, herdr); agentDir = h.agentDir;
  assert.equal((await h.invoke()).r.status, 'applied');
});

for (const [label, title] of [['empty', ''], ['blank', '   ']] as const) {
  test(`a ${label} GitHub title blocks before any launch or write`, async t => {
    const gh = world(epicBody(), undefined, title), herdr = new FakeHerdr();
    const out = await (await harness(t, gh, herdr)).invoke();
    assert.equal(out.r.status, 'blocked');
    assert.ok(out.r.problems.some(p => p.path === 'title'));
    noLaunch(herdr); assert.equal(out.ghWrites, 0);
  });
}

test('broken records in the managed JSON block with their path', async t => {
  const doc = populatedDoc(); doc.stage = 'setup'; doc.design = null; doc.dependencyPlan = null; doc.wavePlan = null;
  const json = JSON.stringify(doc, null, 2).replace('"description": "顧客一覧をCSVで保存できる"', '"description": ""');
  const body = composeManagedBlock('x', doc).replace(/```json\n[\s\S]*\n```/, '```json\n' + json + '\n```');
  const gh = world(body), herdr = new FakeHerdr();
  const out = await (await harness(t, gh, herdr)).invoke();
  assert.equal(out.r.status, 'blocked');
  noLaunch(herdr); assert.equal(out.ghWrites, 0);
});

test('only setup → specification is accepted', async t => {
  const gh = world(), herdr = new FakeHerdr();
  const h = await harness(t, gh, herdr);
  for (const bad of [{expectedStage: 'specification'}, {nextStage: 'basic-design'}, {expectedStage: 'setup', nextStage: 'setup'}]) {
    const out = await h.invoke(params(gh, bad));
    assert.equal(out.r.status, 'blocked', JSON.stringify(bad));
  }
  noLaunch(herdr);
});

for (const [label, labels] of [['Blocked', ['Type: Scaffold', 'Scope: Epic', 'Blocked']], ['an existing Stage', ['Type: Scaffold', 'Scope: Epic', 'Stage: Specification']], ['duplicate Scope', ['Type: Scaffold', 'Scope: Epic', 'Scope: Feature']]] as const) {
  test(`${label} stops the handoff with zero side effects`, async t => {
    const gh = world(epicBody(), [...labels]), herdr = new FakeHerdr();
    const out = await (await harness(t, gh, herdr)).invoke();
    assert.equal(out.r.status, 'blocked', JSON.stringify(out.r));
    noLaunch(herdr); assert.equal(out.ghWrites, 0);
  });
}

test('environment preconditions block before creating a tab', async t => {
  for (const [label, scenario, code] of [
    ['no Herdr', {environment: {}}, 'HERDR_UNAVAILABLE'],
    ['child', {environment: {...environment, PI_SUBAGENT_CHILD: '1'}}, 'CHILD_SESSION'],
    ['untrusted', {trusted: false}, 'UNTRUSTED_PROJECT'],
    ['other profile', {sessionEntries: [profile('reviewer')]}, 'PROFILE_NOT_DEVELOPMENT'],
    ['no account binding', {policy: undefined}, 'ACCOUNT_UNBOUND'],
    ['missing tool', {tools: TOOLS.filter(n => n !== 'gh_issue_get')}, 'REQUIRED_TOOL_MISSING'],
  ] as [string, Scenario, string][]) {
    const gh = world(), herdr = new FakeHerdr();
    const out = await (await harness(t, gh, herdr, scenario)).invoke();
    assert.equal(out.r.status, 'blocked', label);
    assert.ok(out.r.problems.some(p => p.code === code), `${label}: ${JSON.stringify(out.r.problems)}`);
    noLaunch(herdr);
  }
  const old = new FakeHerdr(); old.version_ = {version: '0.9.2', protocol: 23};
  const out = await (await harness(t, world(), old)).invoke();
  assert.ok(out.r.problems.some(p => p.code === 'HERDR_UNSUPPORTED'));
  noLaunch(old);
  const gh = world(); gh.operations = gh.operations.filter(o => o !== 'gh_issue_labels_if_current');
  const capless = new FakeHerdr();
  const missing = await (await harness(t, gh, capless)).invoke();
  assert.ok(missing.r.problems.some(p => p.code === 'CAPABILITY_MISSING'));
  noLaunch(capless);
});

test('ready without a started turn is not applied; the same operation resumes without a new tab', async t => {
  const gh = world(), herdr = new FakeHerdr();
  let agentDir = '';
  const rx = receiver(herdr, () => agentDir, {started: false});
  const h = await harness(t, gh, herdr); agentDir = h.agentDir;
  const first = await h.invoke();
  assert.equal(first.r.status, 'partial');
  assert.equal(first.r.resumeToken, OPERATION_ID);
  const prompt = (herdr.calls.find(c => c.command === 'agentPrompt')!.args as {text: string}).text;
  await recordTurnStarted({packetPath: rx.packetPath(), agentDir, sessionId: 'target-session', prompt});
  const resumed = await h.invoke();
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.equal(herdr.tabCreates, 1); assert.equal(herdr.count('paneRun'), 1); assert.equal(herdr.count('agentPrompt'), 1);
});

test('no receiver-ready yet: nothing is committed or prompted, and resume reuses the tab', async t => {
  const gh = world(), herdr = new FakeHerdr();
  let agentDir = '';
  const rx = receiver(herdr, () => agentDir, {ready: false});
  const h = await harness(t, gh, herdr); agentDir = h.agentDir;
  assert.equal((await h.invoke()).r.status, 'partial');
  assert.equal(gh.conditionalChanges.length, 0, 'Stage is not committed before the receiver is ready');
  assert.equal(herdr.count('agentPrompt'), 0);
  const ok = await acceptStartupPacket({packetPath: rx.packetPath(), agentDir, cwd: '/synthetic/repo', sessionId: 'target-session', sessionEntries: [profile()], toolNames: TOOLS, policy});
  assert.ok(ok.ok);
  const resumed = await h.invoke();
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.equal(herdr.tabCreates, 1); assert.equal(herdr.count('paneRun'), 1);
});

test('a lost tab-create reply is reconciled by the tab label, never by creating another tab', async t => {
  const gh = world(), herdr = new FakeHerdr();
  let agentDir = ''; receiver(herdr, () => agentDir);
  herdr.fail.tabCreate = 'unknown';
  const h = await harness(t, gh, herdr); agentDir = h.agentDir;
  assert.equal((await h.invoke()).r.status, 'unknown');
  delete herdr.fail.tabCreate;
  const resumed = await h.invoke();
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.equal(herdr.tabCreates, 1);
});

test('a changed caller binding stops before the next control with no focused-pane fallback', async t => {
  const gh = world(), herdr = new FakeHerdr();
  let agentDir = ''; receiver(herdr, () => agentDir);
  const original = herdr.tabCreate.bind(herdr);
  herdr.tabCreate = async o => { const r = await original(o); herdr.pane = {workspaceId: 'w9', paneId: 'w9:pZ'}; return r; };
  const h = await harness(t, gh, herdr); agentDir = h.agentDir;
  const out = await h.invoke();
  assert.equal(out.r.status, 'partial');
  assert.ok(out.r.problems.some(p => p.code === 'HERDR_BINDING_CHANGED'));
  assert.equal(herdr.count('paneRun'), 0);
  assert.equal(herdr.count('agentPrompt'), 0);
});

test('a concurrent Epic edit stops the stage commit before any prompt', async t => {
  const gh = world(), herdr = new FakeHerdr();
  let agentDir = '';
  receiver(herdr, () => agentDir);
  const run = herdr.onPaneRun!;
  herdr.onPaneRun = async (p, c) => { await run(p, c); gh.issues.get(10)!.body += '\n手で追記'; };
  const h = await harness(t, gh, herdr); agentDir = h.agentDir;
  const out = await h.invoke();
  assert.equal(out.r.status, 'partial');
  assert.equal(herdr.count('agentPrompt'), 0);
  assert.ok(!gh.issues.get(10)!.labels.includes('Stage: Specification'));
});

test('the receiver refuses packets that do not match its session', async t => {
  const gh = world(), herdr = new FakeHerdr();
  let agentDir = ''; const rx = receiver(herdr, () => agentDir, {ready: false});
  const h = await harness(t, gh, herdr); agentDir = h.agentDir;
  await h.invoke();
  const base = {packetPath: rx.packetPath(), agentDir, cwd: '/synthetic/repo', sessionId: 'target-session', sessionEntries: [profile()], toolNames: TOOLS, policy};
  for (const [label, over, code] of [
    ['cwd', {cwd: '/elsewhere'}, 'RECEIVER_CWD_MISMATCH'],
    ['profile', {sessionEntries: [profile('developer', '別の指示')]}, 'RECEIVER_PROFILE_MISMATCH'],
    ['tools', {toolNames: ['gh_issue_get']}, 'REQUIRED_TOOL_MISSING'],
    ['account', {policy: {version: 1 as const, repos: {}}}, 'RECEIVER_ACCOUNT_MISMATCH'],
    ['outside root', {packetPath: '/tmp/packet.json'}, 'OUTSIDE_ROOT'],
  ] as [string, object, string][]) {
    const r = await acceptStartupPacket({...base, ...over});
    assert.ok(!r.ok && r.problems.some(p => p.code === code), `${label}: ${JSON.stringify(r)}`);
  }
});

test('a packet changed after it was written is detected by the driver before any stage change', async t => {
  const gh = world(), herdr = new FakeHerdr();
  let agentDir = '';
  const rx = receiver(herdr, () => agentDir);
  const run = herdr.onPaneRun!;
  herdr.onPaneRun = async (p, c) => {
    const path = /--scaffold-handoff '([^']+)'/.exec(c)![1]!;
    const {readFile} = await import('node:fs/promises');
    await writeFile(path, (await readFile(path, 'utf8')).replace('"targetStage": "specification"', '"targetStage": "specification" '), {mode: 0o600});
    await run(p, c);
  };
  const h = await harness(t, gh, herdr); agentDir = h.agentDir;
  const out = await h.invoke();
  assert.notEqual(out.r.status, 'applied');
  assert.ok(out.r.problems.some(p => p.code === 'RECEIVER_PACKET_MISMATCH'), JSON.stringify(out.r.problems));
  assert.equal(gh.conditionalChanges.length, 0);
  assert.equal(herdr.count('agentPrompt'), 0);
  void rx;
});

test('resuming before the stage commit re-checks the Epic against the input (third-party edit, blank title)', async t => {
  const gh = world(), herdr = new FakeHerdr();
  let agentDir = ''; const rx = receiver(herdr, () => agentDir, {ready: false});
  const h = await harness(t, gh, herdr); agentDir = h.agentDir;
  assert.equal((await h.invoke()).r.status, 'partial');
  gh.issues.get(10)!.body += '\n第三者の追記'; gh.issues.get(10)!.title = '  ';
  await acceptStartupPacket({packetPath: rx.packetPath(), agentDir, cwd: '/synthetic/repo', sessionId: 'target-session', sessionEntries: [profile()], toolNames: TOOLS, policy});
  const resumed = await h.invoke();
  assert.notEqual(resumed.r.status, 'applied');
  assert.ok(resumed.r.problems.some(p => p.code === 'STALE_BODY'), JSON.stringify(resumed.r.problems));
  assert.equal(gh.conditionalChanges.length, 0);
  assert.equal(herdr.count('agentPrompt'), 0);
});

test('a second operation cannot start while a handoff is in progress, and an Epic committed by another operation is never overwritten', async t => {
  const gh = world(), herdr = new FakeHerdr();
  let agentDir = ''; receiver(herdr, () => agentDir, {ready: false});
  const h = await harness(t, gh, herdr, {confirm: false}); agentDir = h.agentDir;
  assert.equal((await h.invoke()).r.status, 'partial');
  const other = await h.invoke(params(gh, {operationId: '66666666-6666-4666-8666-666666666666'}));
  assert.equal(other.r.status, 'blocked');
  assert.ok(other.r.problems.some(p => p.code === 'HANDOFF_IN_PROGRESS'), JSON.stringify(other.r.problems));
  assert.equal(herdr.tabCreates, 1);
  // Someone else committed the stage meanwhile: resuming the first operation must stop, not overwrite.
  const doc = (parseIssueBody(gh.issues.get(10)!.body) as {ok: true; value: {doc: EpicDocV1}}).value.doc;
  gh.issues.get(10)!.body = renderEpicBlock({...doc, stage: 'specification', revision: 2, handoff: {nonceSha256: 'e'.repeat(64), sourceStage: 'setup', targetStage: 'specification', phase: 'stage-committed', operationId: '66666666-6666-4666-8666-666666666666'}});
  const resumed = await h.invoke();
  assert.notEqual(resumed.r.status, 'applied');
  assert.equal(herdr.count('agentPrompt'), 0);
  assert.ok(gh.issues.get(10)!.body.includes('66666666-6666-4666-8666-666666666666'));
});

test('Blocked appearing while waiting stops before the body is changed', async t => {
  const gh = world(), herdr = new FakeHerdr();
  let agentDir = ''; receiver(herdr, () => agentDir);
  const run = herdr.onPaneRun!;
  herdr.onPaneRun = async (p, c) => { await run(p, c); gh.issues.get(10)!.labels.push('Blocked'); };
  const h = await harness(t, gh, herdr); agentDir = h.agentDir;
  const out = await h.invoke();
  assert.notEqual(out.r.status, 'applied');
  assert.ok(out.r.problems.some(p => p.code === 'BLOCKED'), JSON.stringify(out.r.problems));
  assert.equal(gh.conditionalChanges.length, 0, 'the stage is not written while Blocked');
});

test('values that a shell could interpret are refused before any tab is created', async t => {
  for (const id of ["prov/x\\';echo INJECTED;#", 'prov/a b', 'prov/$(id)']) {
    const gh = world(), herdr = new FakeHerdr();
    const out = await (await harness(t, gh, herdr, {model: {provider: id.split('/')[0]!, id: id.split('/')[1]!}})).invoke();
    assert.equal(out.r.status, 'blocked', id);
    assert.ok(out.r.problems.some(p => p.code === 'UNSAFE_LAUNCH_VALUE' && p.message.includes('model')), id);
    noLaunch(herdr);
  }
});

test('a failed launch is never resent blindly', async t => {
  const gh = world(), herdr = new FakeHerdr();
  let agentDir = ''; receiver(herdr, () => agentDir);
  herdr.fail.paneRun = 'not-started';
  const h = await harness(t, gh, herdr); agentDir = h.agentDir;
  assert.notEqual((await h.invoke()).r.status, 'applied');
  delete herdr.fail.paneRun; herdr.shellReady = false;
  const again = await h.invoke();
  assert.notEqual(again.r.status, 'applied');
  assert.equal(herdr.count('paneRun'), 1, 'not resent while the pane is not an idle shell');
});

test('the call budget pauses between steps instead of running minutes in one call', async t => {
  let clock = 0;
  const gh = world(), herdr = new FakeHerdr();
  let agentDir = ''; receiver(herdr, () => agentDir);
  const create = herdr.tabCreate.bind(herdr);
  herdr.tabCreate = async o => { clock += 70_000; return create(o); };
  const h = await harness(t, gh, herdr, {budgetMs: 60_000, now: () => clock}); agentDir = h.agentDir;
  const first = await h.invoke();
  assert.equal(first.r.status, 'partial');
  assert.ok(first.r.problems.some(p => p.code === 'CALL_BUDGET_EXHAUSTED'));
  assert.equal(herdr.count('paneRun'), 0);
  clock = 0; herdr.tabCreate = create;
  const resumed = await h.invoke();
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.equal(herdr.tabCreates, 1);
});

test('only the stage prompt turn counts as started', async t => {
  const gh = world(), herdr = new FakeHerdr();
  let agentDir = ''; const rx = receiver(herdr, () => agentDir, {started: false});
  const h = await harness(t, gh, herdr); agentDir = h.agentDir;
  assert.equal((await h.invoke()).r.status, 'partial');
  assert.equal(await recordTurnStarted({packetPath: rx.packetPath(), agentDir, sessionId: 'target-session', prompt: 'こんにちは'}), false);
  assert.equal(await recordTurnStarted({packetPath: rx.packetPath(), agentDir, sessionId: 'other-session', prompt: (herdr.calls.find(c => c.command === 'agentPrompt')!.args as {text: string}).text}), false);
  assert.equal((await h.invoke()).r.status, 'partial');
});

test('a stuck handoff can be abandoned only through the parent TUI confirmation; tabs are never closed', async t => {
  const gh = world(), herdr = new FakeHerdr();
  let agentDir = ''; receiver(herdr, () => agentDir, {ready: false});
  let answer = false;
  const h = await harness(t, gh, herdr, {confirm: () => answer}); agentDir = h.agentDir;
  assert.equal((await h.invoke()).r.status, 'partial');
  const next = params(gh, {operationId: '66666666-6666-4666-8666-666666666666'});
  const declined = await h.invoke(next);
  assert.equal(declined.r.status, 'blocked');
  assert.ok(declined.r.problems.some(p => p.code === 'HANDOFF_IN_PROGRESS'));
  assert.equal(declined.confirmCalls, 1, 'the human is asked in the parent TUI');
  assert.equal(herdr.tabCreates, 1);
  receiver(herdr, () => agentDir);
  answer = true;
  const fresh = await h.invoke(next);
  assert.equal(fresh.r.status, 'applied', JSON.stringify(fresh.r.problems));
  assert.equal(herdr.tabCreates, 2, 'a new tab; the old one is kept');
  assert.ok(herdr.tabs.length === 2);
  const old = await h.invoke();
  assert.notEqual(old.r.status, 'applied', 'the abandoned operation cannot be resumed');
});

test('headless or child sessions cannot abandon a stuck handoff', async t => {
  const gh = world(), herdr = new FakeHerdr();
  let agentDir = ''; receiver(herdr, () => agentDir, {ready: false});
  const h = await harness(t, gh, herdr, {interactive: false}); agentDir = h.agentDir;
  assert.equal((await h.invoke()).r.status, 'partial');
  const next = await h.invoke(params(gh, {operationId: '66666666-6666-4666-8666-666666666666'}));
  assert.equal(next.r.status, 'blocked');
  assert.equal(next.confirmCalls, 0);
  assert.equal(herdr.tabCreates, 1);
});

test('a tab-create reply lost before the tab existed is reconciled as not applied and created once', async t => {
  const gh = world(), herdr = new FakeHerdr();
  let agentDir = ''; receiver(herdr, () => agentDir);
  herdr.fail.tabCreate = 'unknown-before';
  const h = await harness(t, gh, herdr); agentDir = h.agentDir;
  assert.equal((await h.invoke()).r.status, 'unknown');
  delete herdr.fail.tabCreate;
  const resumed = await h.invoke();
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.equal(herdr.tabs.length, 1);
});
