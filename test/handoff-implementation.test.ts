import test from 'node:test';
import assert from 'node:assert/strict';
import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createHarness, loadToolModule, type Scenario} from './helpers/harness.js';
import {FakePiGh} from './helpers/fake-pi-gh.js';
import {FakeHerdr} from './helpers/fake-herdr.js';
import {renderEpicBlock, renderFeatureBlock} from '../src/core/epic-render.js';
import {parseIssueBody} from '../src/core/body-codec.js';
import {sha256Text, taggedDigest} from '../src/core/digests.js';
import {labelDefinitions} from '../src/core/label-definitions.js';
import {repoHash} from '../src/core/repo-context.js';
import {acceptStartupPacket, recordTurnStarted} from '../src/handoff/receiver.js';
import type {EpicDocV1, FeatureDocV1, WavePlan} from '../src/core/contracts.js';
import type {OwnerPolicy} from '../src/core/model-bindings.js';
import {populatedDoc, featureDoc, OPERATION_ID} from './helpers/docs.js';

const COMMIT = '2'.repeat(40), DESIGN = '# 基本設計（架空）\n構成と境界\n';
const MODEL = 'example-provider/coder-1';
const policy: OwnerPolicy = {version: 1, repos: {'example/demo': {authMode: 'file-backed', models: [
  {model: MODEL, thinking: 'medium', tier: 'basic', roles: ['coding-manager', 'coder', 'tester']},
]}}};
const profile = {type: 'custom', customType: 'startup-profile-state', data: {version: 1, id: 'developer', label: 'developer', instructions: '開発用（架空）'}};
const environment = {HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w9', HERDR_PANE_ID: 'w9:pA', HERDR_SOCKET_PATH: '/synthetic/herdr.sock'};
const TOOLS = ['gh_capabilities', 'gh_issue_get', 'gh_issue_edit_if_current', 'gh_issue_labels_if_current', 'scaffold_handoff_implementation'];
const ISSUES = [11, 12];
const KEY = (n: number) => `F00${n - 10}`;
const binding = {model: MODEL, thinking: 'medium' as const, reason: '架空'};

function feature(epic: EpicDocV1, n: number, mutate: (f: FeatureDocV1) => void = () => {}): FeatureDocV1 {
  const f: FeatureDocV1 = {...featureDoc(), workflowId: epic.workflowId, featureKey: KEY(n), parentEpic: 10, editScope: [`src/f${n}/`],
    designRef: {path: 'docs/design.md', sha256: sha256Text(DESIGN), gitRef: COMMIT},
    criteria: [{id: `AC10${n - 10}`, requirementIds: [n === 11 ? 'REQ001' : 'REQ002'], verification: '単体テスト', expectedResult: '期待どおり'}],
    bindings: {'coding-manager': binding, coder: binding, tester: binding}, createOperationId: `eeeeeeee-eeee-4eee-8eee-${String(n).padStart(12, '0')}`};
  mutate(f);
  return f;
}
function epicDoc(mutate: (d: EpicDocV1) => void = () => {}): EpicDocV1 {
  const d = populatedDoc();
  d.stage = 'basic-design'; d.revision = 9; d.handoff = null;
  d.questions = d.questions.map(q => ({...q, answer: q.answer ?? '回答', sourceRef: q.sourceRef ?? 'hearing-1'}));
  d.research = d.research.map(r => ({...r, state: 'resolved' as const, claim: null, conclusion: r.conclusion ?? '結論', evidenceRefs: r.evidenceRefs.length ? r.evidenceRefs : ['https://example.com/e']}));
  d.design = {path: 'docs/design.md', sha256: sha256Text(DESIGN), gitRef: COMMIT};
  d.dependencyPlan = {version: 1, nodes: ISSUES.map(n => ({featureKey: KEY(n), issue: n, contracts: [], startConditions: [], editScope: [`src/f${n}/`]})), edges: [{from: 11, to: 12, reason: '架空'}]};
  d.wavePlan = {version: 1, assignments: [{issue: 11, wave: 1}, {issue: 12, wave: 2}], dependencyDigest: taggedDigest('dependency-plan', d.dependencyPlan),
    featureSetDigest: taggedDigest('feature-set', ISSUES.map(n => ({issue: n, featureKey: KEY(n)})))} satisfies WavePlan;
  mutate(d);
  return d;
}
function world(opts: {epic?: EpicDocV1; features?: Record<number, FeatureDocV1>; epicLabels?: string[]; waveLabels?: Record<number, string>} = {}) {
  const gh = new FakePiGh().seedLabels(labelDefinitions()).enableProposals();
  const epic = opts.epic ?? epicDoc();
  gh.add({number: 10, title: 'Epic', body: renderEpicBlock(epic), labels: opts.epicLabels ?? ['Type: Scaffold', 'Scope: Epic', 'Stage: BasicDesign'], state: 'open', subIssues: [...ISSUES]});
  for (const n of ISSUES) gh.add({number: n, title: `F${n}`, body: renderFeatureBlock(opts.features?.[n] ?? feature(epic, n)), labels: ['Type: Scaffold', 'Scope: Feature', 'Stage: BasicDesign', opts.waveLabels?.[n] ?? `Wave: ${n - 10}`], state: 'open'});
  gh.issues.get(12)!.blockedBy = [11];
  return gh;
}
const docOf = (gh: FakePiGh) => (parseIssueBody(gh.issues.get(10)!.body) as {ok: true; value: {doc: EpicDocV1}}).value.doc;
const params = (gh: FakePiGh, extra: Record<string, unknown> = {}) => ({
  repo: 'example/demo', epicIssue: 10, operationId: OPERATION_ID, expectedRevision: docOf(gh).revision, expectedBodySha256: sha256Text(gh.issues.get(10)!.body), ...extra,
});
function receiver(herdr: FakeHerdr, agentDir: () => string) {
  let packetPath = '';
  herdr.onPaneRun = async (_pane, command) => {
    packetPath = /--scaffold-handoff '([^']+)'/.exec(command)![1]!;
    const r = await acceptStartupPacket({packetPath, agentDir: agentDir(), cwd: '/synthetic/repo', sessionId: 'impl-session', sessionEntries: [profile], toolNames: TOOLS, policy});
    assert.ok(r.ok, JSON.stringify(r));
  };
  herdr.onPrompt = async (_pane, text) => { await recordTurnStarted({packetPath, agentDir: agentDir(), sessionId: 'impl-session', prompt: text}); };
}
async function harness(t: {after(fn: () => Promise<void>): void}, gh: FakePiGh, herdr = new FakeHerdr(), scenario: Scenario = {}) {
  const {createTool} = await loadToolModule('extensions/tools/handoff-implementation.ts');
  let agentDir = '';
  receiver(herdr, () => agentDir);
  const h = await createHarness(createTool, {scenario: {gh, herdr, policy, sessionEntries: [profile], environment, tools: TOOLS, availableModels: [MODEL], waitMs: 300, pollMs: 10,
    blobs: {[`${COMMIT}:docs/design.md`]: DESIGN}, defaultParams: scenario.defaultParams ?? params(gh), ...scenario}});
  agentDir = h.agentDir;
  t.after(h.dispose);
  return {h, herdr};
}
const noLaunch = (herdr: FakeHerdr, gh: FakePiGh) => {
  assert.equal(herdr.tabCreates, 0); assert.equal(herdr.count('paneRun'), 0); assert.equal(herdr.count('agentPrompt'), 0);
  assert.equal(gh.conditionalChanges.length, 0, 'no Stage/body change');
};
async function blockedNoLaunch(t: {after(fn: () => Promise<void>): void}, gh: FakePiGh, code?: string, scenario: Scenario = {}) {
  const {h, herdr} = await harness(t, gh, new FakeHerdr(), scenario);
  const out = await h.invoke();
  assert.equal(out.r.status, 'blocked', JSON.stringify(out.r));
  if (code) assert.ok(out.r.problems.some(p => p.code === code), JSON.stringify(out.r.problems));
  assert.equal(out.confirmCalls, 0, 'nothing is asked for a handoff that cannot proceed');
  noLaunch(herdr, gh);
}

// ---- design gate ----------------------------------------------------------------------------------

test('no design reference is blocked', async t => { await blockedNoLaunch(t, world({epic: epicDoc(d => { d.design = null; })}), 'DESIGN_UNSET'); });
test('a design file missing at gitRef is blocked', async t => { await blockedNoLaunch(t, world(), 'DESIGN_NOT_FOUND', {blobs: {}}); });
test('a design sha mismatch is blocked', async t => { await blockedNoLaunch(t, world(), 'DESIGN_HASH_MISMATCH', {blobs: {[`${COMMIT}:docs/design.md`]: DESIGN + '改変'}}); });
test('an Epic requirement no Feature covers is blocked', async t => {
  const epic = epicDoc();
  await blockedNoLaunch(t, world({epic, features: {12: feature(epic, 12, f => { f.criteria = [{id: 'AC102', requirementIds: ['REQ001'], verification: 'v', expectedResult: 'e'}]; })}}), 'REQUIREMENT_UNCOVERED');
});
test('a Feature AC referencing a REQ the Epic does not have is blocked', async t => {
  const epic = epicDoc();
  await blockedNoLaunch(t, world({epic, features: {12: feature(epic, 12, f => { f.criteria = [{id: 'AC102', requirementIds: ['REQ999'], verification: 'v', expectedResult: 'e'}]; })}}), 'UNKNOWN_REFERENCE');
});
test('a Feature binding the owner policy no longer allows is blocked', async t => {
  const epic = epicDoc();
  await blockedNoLaunch(t, world({epic, features: {11: feature(epic, 11, f => { f.bindings.tester = {model: 'example-provider/gone-1', thinking: 'low', reason: 'x'}; })}}), 'POLICY_MODEL');
});
test('no saved Wave plan is blocked', async t => { await blockedNoLaunch(t, world({epic: epicDoc(d => { d.wavePlan = null; })}), 'PLAN_UNSET'); });
test('a Wave check that does not pass (labels out of sync) is blocked', async t => { await blockedNoLaunch(t, world({waveLabels: {12: 'Wave: 1'}}), 'WAVE_LABEL_MISMATCH'); });
test('Blocked, a duplicate Stage or a direct visible edit stop before anything', async t => {
  await blockedNoLaunch(t, world({epicLabels: ['Type: Scaffold', 'Scope: Epic', 'Stage: BasicDesign', 'Blocked']}), 'BLOCKED');
  await blockedNoLaunch(t, world({epicLabels: ['Type: Scaffold', 'Scope: Epic', 'Stage: BasicDesign', 'Stage: Implementation']}), 'DUPLICATE_MANAGED_LABEL');
  const gh = world(); gh.issues.get(10)!.body = gh.issues.get(10)!.body.replace('## 目的', '## 目的（手で編集）');
  const {h, herdr} = await harness(t, gh, new FakeHerdr(), {defaultParams: {repo: 'example/demo', epicIssue: 10, operationId: OPERATION_ID, expectedRevision: 9, expectedBodySha256: sha256Text(gh.issues.get(10)!.body)}});
  const out = await h.invoke();
  assert.equal(out.r.status, 'blocked'); assert.ok(out.r.problems.some(p => p.code === 'DOC_PROJECTION_MISMATCH')); noLaunch(herdr, gh);
});
test('only basic-design → implementation; startApproved and stage overrides are rejected', async t => {
  await blockedNoLaunch(t, world({epic: epicDoc(d => { d.stage = 'specification'; }), epicLabels: ['Type: Scaffold', 'Scope: Epic', 'Stage: Specification']}), 'STAGE_MISMATCH');
  for (const extra of [{startApproved: true}, {nextStage: 'verification'}]) {
    const gh = world();
    const {h, herdr} = await harness(t, gh);
    const out = await h.invoke(params(gh, extra));
    assert.equal(out.inputSchemaValid, false); assert.equal(out.r.status, 'blocked'); noLaunch(herdr, gh);
  }
});

// ---- the start approval -------------------------------------------------------------------------

test('the parent TUI approves the start, then only the Epic moves to Stage: Implementation in a new session', async t => {
  const gh = world();
  const {h, herdr} = await harness(t, gh);
  const out = await h.invoke();
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.equal(out.confirmCalls, 1);
  assert.equal((out.r.data as {phase: string}).phase, 'turn-started');
  assert.equal(herdr.tabCreates, 1);
  assert.equal(docOf(gh).stage, 'implementation');
  assert.deepEqual(gh.issues.get(10)!.labels.sort(), ['Scope: Epic', 'Stage: Implementation', 'Type: Scaffold']);
  for (const n of ISSUES) assert.ok(gh.issues.get(n)!.labels.includes('Stage: BasicDesign'), 'Features are not moved');
  assert.match(herdr.calls.filter(c => c.command === 'agentPrompt').map(c => (c.args as {text: string}).text).join(), /詳細設計・実装/);
  assert.ok(!('implemented' in (out.r.data as object)) && !('completed' in (out.r.data as object)), 'starting is not completing');
});

test('declining the start cancels with zero launches; headless cannot create the start approval', async t => {
  const gh = world();
  const {h, herdr} = await harness(t, gh, new FakeHerdr(), {confirm: false});
  assert.equal((await h.invoke()).r.status, 'cancelled'); noLaunch(herdr, gh);
  const g2 = world();
  const {h: headless, herdr: hh} = await harness(t, g2, new FakeHerdr(), {interactive: false});
  const out = await headless.invoke();
  assert.equal(out.r.status, 'blocked'); assert.ok(out.r.problems.some(p => p.code === 'APPROVAL_UI_REQUIRED')); noLaunch(hh, g2);
});

test('a specification approval or D record is never a start approval', async t => {
  const gh = world({epic: epicDoc(d => { d.decisions.push({id: 'D009', topic: '実装開始', decision: '実装開始を承認', reason: '親が承認', sourceRefs: []}); })});
  const {h, herdr} = await harness(t, gh, new FakeHerdr(), {interactive: false});
  const out = await h.invoke();
  assert.equal(out.r.status, 'blocked'); assert.ok(out.r.problems.some(p => p.code === 'APPROVAL_UI_REQUIRED')); noLaunch(herdr, gh);
});

test('a start approval bound to an older Feature/AC/Wave state is not reused', async t => {
  const gh = world();
  const {h: parent} = await harness(t, gh, new FakeHerdr(), {tools: ['gh_capabilities']});
  const p = await parent.invoke();
  assert.equal(p.confirmCalls, 1); assert.ok(p.r.problems.some(x => x.code === 'REQUIRED_TOOL_MISSING'), JSON.stringify(p.r.problems));
  // A Feature's acceptance criterion changes after the approval.
  const epic = docOf(gh);
  gh.issues.get(11)!.body = renderFeatureBlock(feature(epic, 11, f => { f.criteria = [{...f.criteria[0]!, expectedResult: '変更後の期待'}]; }));
  const {h, herdr} = await harness(t, gh, new FakeHerdr(), {agentDir: parent.agentDir, interactive: false});
  const out = await h.invoke();
  assert.equal(out.r.status, 'blocked'); assert.ok(out.r.problems.some(x => x.code === 'APPROVAL_UI_REQUIRED'), JSON.stringify(out.r.problems)); noLaunch(herdr, gh);
});

test('an existing start approval of the same state is referenced headless', async t => {
  const gh = world();
  const {h: parent} = await harness(t, gh, new FakeHerdr(), {tools: ['gh_capabilities']});
  await parent.invoke();
  const {h, herdr} = await harness(t, gh, new FakeHerdr(), {agentDir: parent.agentDir, interactive: false});
  const out = await h.invoke();
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.equal(out.confirmCalls, 0); assert.equal(herdr.tabCreates, 1);
});

test('the start approval is re-checked at the stage commit (approval gone while launching)', async t => {
  const gh = world();
  const herdr = new FakeHerdr();
  const {h} = await harness(t, gh, herdr);
  const run = herdr.onPaneRun!;
  herdr.onPaneRun = async (p, c) => { await run(p, c); await rm(join(h.agentDir, 'pi-scaffold', 'state', repoHash('example/demo'), epicDoc().workflowId, 'approvals'), {recursive: true, force: true}); };
  const out = await h.invoke();
  assert.notEqual(out.r.status, 'applied');
  assert.ok(out.r.problems.some(p => p.code === 'APPROVAL_MISSING'), JSON.stringify(out.r.problems));
  assert.equal(docOf(gh).stage, 'basic-design');
  assert.equal(herdr.count('agentPrompt'), 0);
});

test('a Feature added after the approval stops the stage commit', async t => {
  const gh = world();
  const herdr = new FakeHerdr();
  const {h} = await harness(t, gh, herdr);
  const run = herdr.onPaneRun!;
  herdr.onPaneRun = async (p, c) => {
    await run(p, c);
    const epic = docOf(gh);
    gh.add({number: 13, title: 'F13', body: renderFeatureBlock({...feature(epic, 11), featureKey: 'F003', createOperationId: 'eeeeeeee-eeee-4eee-8eee-000000000013'}), labels: ['Type: Scaffold', 'Scope: Feature', 'Stage: BasicDesign', 'Wave: 1'], state: 'open'});
    gh.issues.get(10)!.subIssues!.push(13);
  };
  const out = await h.invoke();
  assert.notEqual(out.r.status, 'applied');
  assert.ok(out.r.problems.some(p => ['WAVE_LABEL_MISSING', 'UNASSIGNED_FEATURE', 'FEATURE_SET_CHANGED', 'APPROVAL_MISSING'].includes(p.code)), JSON.stringify(out.r.problems));
  assert.equal(docOf(gh).stage, 'basic-design');
});

test('a stale Epic body or revision is refused before the start approval is asked', async t => {
  for (const extra of [{expectedBodySha256: 'f'.repeat(64)}, {expectedRevision: 2}]) {
    const gh = world();
    const {h, herdr} = await harness(t, gh);
    const out = await h.invoke(params(gh, extra));
    assert.equal(out.r.status, 'blocked');
    assert.ok(out.r.problems.some(p => p.code === ('expectedRevision' in extra ? 'STALE_REVISION' : 'STALE_BODY')), JSON.stringify(out.r.problems));
    assert.equal(out.confirmCalls, 0);
    noLaunch(herdr, gh);
  }
});

// ---- review follow-ups --------------------------------------------------------------------------

for (const [label, change] of [
  ['outOfScope', (f: FeatureDocV1) => { f.outOfScope = []; }],
  ['the rest of the purpose', (f: FeatureDocV1) => { f.purpose = f.purpose + '\n追加の目的'; }],
] as const) {
  test(`a start approval does not survive a change to a Feature's ${label}`, async t => {
    const gh = world({features: {11: feature(epicDoc(), 11, f => { f.outOfScope = ['PDF出力']; })}});
    const {h: parent} = await harness(t, gh, new FakeHerdr(), {tools: ['gh_capabilities']});
    assert.equal((await parent.invoke()).confirmCalls, 1);
    gh.issues.get(11)!.body = renderFeatureBlock(feature(docOf(gh), 11, f => { f.outOfScope = ['PDF出力']; change(f); }));
    const {h, herdr} = await harness(t, gh, new FakeHerdr(), {agentDir: parent.agentDir, interactive: false});
    const out = await h.invoke();
    assert.equal(out.r.status, 'blocked'); assert.ok(out.r.problems.some(x => x.code === 'APPROVAL_UI_REQUIRED'), JSON.stringify(out.r.problems)); noLaunch(herdr, gh);
  });
}

test('a design file that cannot be read is reported as unreadable, not as missing', async t => {
  await blockedNoLaunch(t, world(), 'DESIGN_UNREADABLE', {blobs: {[`${COMMIT}:docs/design.md`]: '__THROW__'}});
});

test('one call reads the Feature set a bounded number of times', async t => {
  const gh = world();
  const {h} = await harness(t, gh);
  assert.equal((await h.invoke()).r.status, 'applied');
  // pre-approval readiness (verify reads twice) + pre-commit readiness (twice); the driver's own pre-op gate reuses the first.
  assert.ok(gh.count('gh_subissues_list') <= 4, `subissue lists: ${gh.count('gh_subissues_list')}`);
});

test('a missing write capability the handoff needs later stops before the start approval is asked', async t => {
  for (const op of ['gh_issue_edit_if_current', 'gh_issue_labels_if_current']) {
    const gh = world(); gh.operations = gh.operations.filter(o => o !== op);
    const {h, herdr} = await harness(t, gh);
    const out = await h.invoke();
    assert.equal(out.r.status, 'blocked'); assert.ok(out.r.problems.some(p => p.code === 'CAPABILITY_MISSING'), op);
    assert.equal(out.confirmCalls, 0, op); noLaunch(herdr, gh);
  }
});
