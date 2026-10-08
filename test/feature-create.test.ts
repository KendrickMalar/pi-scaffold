import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness, loadToolModule, type Scenario} from './helpers/harness.js';
import {FakePiGh} from './helpers/fake-pi-gh.js';
import {renderEpicBlock, renderFeatureBlock, renderFeatureVisible} from '../src/core/epic-render.js';
import {parseIssueBody} from '../src/core/body-codec.js';
import {sha256Text, specificationDigest} from '../src/core/digests.js';
import {labelDefinitions} from '../src/core/label-definitions.js';
import {ApprovalStore} from '../src/core/approvals.js';
import {specificationApprovalView} from '../src/core/specification-gate.js';
import {repoHash} from '../src/core/repo-context.js';
import type {EpicDocV1, FeatureDocV1, RepoContext} from '../src/core/contracts.js';
import type {OwnerPolicy} from '../src/core/model-bindings.js';
import {populatedDoc, featureDoc, SHA_A, SHA_B} from './helpers/docs.js';
import {join} from 'node:path';

const OP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', OTHER_OP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const COMMIT = '1'.repeat(40), DESIGN = '# 基本設計（架空）\nCSV出力の構成\n';
const MODELS = {manager: 'example-provider/manager-1', coder: 'example-provider/coder-1', tester: 'example-provider/tester-1', upper: 'example-provider/upper-1'};
const policy: OwnerPolicy = {version: 1, repos: {'example/demo': {authMode: 'file-backed', models: [
  {model: MODELS.manager, thinking: 'medium', tier: 'basic', roles: ['coding-manager']},
  {model: MODELS.coder, thinking: 'high', tier: 'basic', roles: ['coder']},
  {model: MODELS.tester, thinking: 'low', tier: 'basic', roles: ['tester']},
  {model: MODELS.upper, thinking: 'high', tier: 'upper', roles: ['coder']},
]}}};
const profile = {type: 'custom', customType: 'startup-profile-state', data: {version: 1, id: 'developer', label: 'developer', instructions: '開発用（架空）'}};
const EPIC_LABELS = ['Type: Scaffold', 'Scope: Epic', 'Stage: BasicDesign'];

function epicDoc(mutate: (d: EpicDocV1) => void = () => {}): EpicDocV1 {
  const d = populatedDoc();
  d.stage = 'basic-design'; d.revision = 6; d.dependencyPlan = null; d.wavePlan = null; d.handoff = null;
  d.questions = d.questions.map(q => ({...q, answer: q.answer ?? '回答（架空）', sourceRef: q.sourceRef ?? 'hearing-1'}));
  d.research = d.research.map(r => ({...r, state: 'resolved' as const, claim: null, conclusion: r.conclusion ?? '結論', evidenceRefs: r.evidenceRefs.length ? r.evidenceRefs : ['https://example.com/e']}));
  d.constraints = d.constraints ?? []; d.outOfScope = [];
  mutate(d);
  return d;
}
function world(doc = epicDoc(), labels = EPIC_LABELS) {
  const gh = new FakePiGh().seedLabels(labelDefinitions()).enableProposals();
  gh.add({number: 10, title: '一覧をCSVで保存できるようにする', body: renderEpicBlock(doc), labels: [...labels], state: 'open'});
  return gh;
}
const epicOf = (gh: FakePiGh) => (parseIssueBody(gh.issues.get(10)!.body) as {ok: true; value: {doc: EpicDocV1}}).value.doc;
const binding = (model: string, thinking: string, reason = '架空の理由') => ({model, thinking, reason});
const base = (gh: FakePiGh, extra: Record<string, unknown> = {}) => ({
  repo: 'example/demo', epicIssue: 10, operationId: OP, expectedRevision: epicOf(gh).revision, expectedBodySha256: sha256Text(gh.issues.get(10)!.body),
  featureKey: 'F001', title: 'CSV出力ボタン', purpose: '一覧画面からCSVを保存できるようにする。',
  editScope: ['src/export/'], outOfScope: ['PDF出力'],
  designRef: {path: 'docs/design/export.md', sha256: sha256Text(DESIGN), gitRef: COMMIT},
  criteria: [structuredClone(epicOf(gh).criteria[0]!)],
  bindings: {'coding-manager': binding(MODELS.manager, 'medium'), coder: binding(MODELS.coder, 'high'), tester: binding(MODELS.tester, 'low')},
  ...extra,
});
const scenarioFor = (extra: Scenario = {}): Scenario => ({
  policy, sessionEntries: [profile], availableModels: Object.values(MODELS), blobs: {[`${COMMIT}:docs/design/export.md`]: DESIGN}, ...extra,
});
async function harness(t: {after(fn: () => Promise<void>): void}, gh: FakePiGh, extra: Scenario = {}, approve = true) {
  const {createTool} = await loadToolModule('extensions/tools/feature-create.ts');
  const h = await createHarness(createTool, {scenario: {gh, defaultParams: extra.defaultParams ?? base(gh), ...scenarioFor(extra)}});
  t.after(h.dispose);
  if (approve) await approveSpecification(h.agentDir, epicOf(gh));
  return h;
}
/** The specification approval #9 records in the parent TUI (same workflow, account and profile). */
async function approveSpecification(agentDir: string, doc: EpicDocV1) {
  const root = join(agentDir, 'pi-scaffold');
  const {sha256Text: sha} = await import('../src/core/digests.js');
  const {realpath} = await import('node:fs/promises');
  const {taggedDigest} = await import('../src/core/digests.js');
  const accountBinding = taggedDigest('account-binding', {agentDir: await realpath(agentDir), authMode: 'file-backed'});
  const context: RepoContext = {repo: 'example/demo', repoRoot: '/synthetic/repo', gitCommonDir: '/synthetic/repo/.git', workflowStateRoot: join(root, 'state', repoHash('example/demo'), doc.workflowId), accountBinding, profileId: 'developer', profileInstructionsDigest: sha('開発用（架空）')};
  const {makeScope} = await import('./helpers/scope.js');
  const r = await new ApprovalStore(root).confirmContent('specification', doc.workflowId, specificationApprovalView(doc), context, {interactive: true, confirm: async () => true}, makeScope());
  assert.equal(r.status, 'validated', JSON.stringify(r));
}
type Data = {featureKey: string; number: number; url: string; parentAttached: boolean};
const creates = (gh: FakePiGh) => gh.count('gh_issue_submit');
const attaches = (gh: FakePiGh) => gh.count('gh_subissue_add');
const noSideEffects = (gh: FakePiGh) => { assert.equal(creates(gh), 0); assert.equal(attaches(gh), 0); assert.equal(gh.conditionalChanges.length, 0); };
const featureOf = (gh: FakePiGh, n: number) => (parseIssueBody(gh.issues.get(n)!.body) as {ok: true; value: {doc: FeatureDocV1}}).value.doc;

// ---- validation: blocked with zero create/attach/label changes ------------------------------------

for (const [label, change, path] of [
  ['title blank', {title: '  '}, 'title'], ['title missing', {title: undefined}, 'title'],
  ['purpose blank', {purpose: ' '}, 'purpose'], ['featureKey missing', {featureKey: undefined}, 'featureKey'], ['featureKey blank', {featureKey: ' '}, 'featureKey'],
  ['criteria empty', {criteria: []}, 'criteria'], ['designRef missing', {designRef: undefined}, 'designRef'],
] as const) {
  test(`${label} is blocked with zero side effects`, async t => {
    const gh = world();
    const p: Record<string, unknown> = base(gh, change);
    for (const [k, v] of Object.entries(change)) if (v === undefined) delete p[k];
    const out = await (await harness(t, gh)).invoke(p);
    assert.equal(out.r.status, 'blocked');
    assert.ok(out.r.problems.some(x => x.path === path), JSON.stringify(out.r.problems));
    noSideEffects(gh);
  });
}

test('an AC referencing a REQ the Epic does not have is blocked', async t => {
  const gh = world();
  const out = await (await harness(t, gh)).invoke(base(gh, {criteria: [{id: 'AC101', requirementIds: ['REQ999'], verification: 'x', expectedResult: 'y'}]}));
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(x => x.code === 'UNKNOWN_REFERENCE' && x.path === 'criteria[0].requirementIds[0]'), JSON.stringify(out.r.problems));
  noSideEffects(gh);
});

test('an Epic AC ID reused with a different expected result is blocked; a new AC ID on an Epic REQ is fine', async t => {
  const gh = world();
  const h = await harness(t, gh);
  const ac = epicOf(gh).criteria[0]!;
  const bad = await h.invoke(base(gh, {criteria: [{...ac, expectedResult: '別の合格基準'}]}));
  assert.equal(bad.r.status, 'blocked');
  assert.ok(bad.r.problems.some(x => x.code === 'CRITERION_MISMATCH' && x.path === 'criteria[0]'), JSON.stringify(bad.r.problems));
  noSideEffects(gh);
  const ok = await h.invoke(base(gh, {operationId: OTHER_OP, criteria: [{id: 'AC101', requirementIds: [ac.requirementIds[0]!], verification: '単体テスト', expectedResult: 'ボタンが表示される'}]}));
  assert.equal(ok.r.status, 'applied', JSON.stringify(ok.r.problems));
});

for (const [label, bindings, code] of [
  ['tester missing', {'coding-manager': binding(MODELS.manager, 'medium'), coder: binding(MODELS.coder, 'high')}, 'REQUIRED'],
  ['model outside the policy', {'coding-manager': binding(MODELS.manager, 'medium'), coder: binding('example-provider/other-9', 'high'), tester: binding(MODELS.tester, 'low')}, 'POLICY_MODEL'],
  ['thinking outside the policy', {'coding-manager': binding(MODELS.manager, 'high'), coder: binding(MODELS.coder, 'high'), tester: binding(MODELS.tester, 'low')}, 'POLICY_MODEL'],
  ['upper tier', {'coding-manager': binding(MODELS.manager, 'medium'), coder: binding(MODELS.upper, 'high'), tester: binding(MODELS.tester, 'low')}, 'UPPER_TIER_UNSUPPORTED'],
] as const) {
  test(`bindings: ${label} is blocked (no create, no model change)`, async t => {
    const gh = world();
    const out = await (await harness(t, gh)).invoke(base(gh, {bindings}));
    assert.equal(out.r.status, 'blocked');
    assert.ok(out.r.problems.some(x => x.code === code), JSON.stringify(out.r.problems));
    noSideEffects(gh);
  });
}

for (const [label, ref, code] of [
  ['hash mismatch', {path: 'docs/design/export.md', sha256: SHA_A, gitRef: COMMIT}, 'DESIGN_HASH_MISMATCH'],
  ['file missing at gitRef', {path: 'docs/design/none.md', sha256: SHA_A, gitRef: COMMIT}, 'DESIGN_NOT_FOUND'],
  ['path escaping the repository', {path: '../secret.md', sha256: SHA_A, gitRef: COMMIT}, 'INVALID_FORMAT'],
  ['short gitRef', {path: 'docs/design/export.md', sha256: SHA_A, gitRef: 'abc123'}, 'INVALID_FORMAT'],
] as const) {
  test(`designRef ${label} is blocked`, async t => {
    const gh = world();
    const out = await (await harness(t, gh)).invoke(base(gh, {designRef: ref}));
    assert.equal(out.r.status, 'blocked');
    assert.ok(out.r.problems.some(x => x.code === code), JSON.stringify(out.r.problems));
    noSideEffects(gh);
  });
}

test('without a valid specification approval nothing is created', async t => {
  const gh = world();
  const out = await (await harness(t, gh, {}, false)).invoke();
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(x => x.code === 'SPECIFICATION_NOT_APPROVED'), JSON.stringify(out.r.problems));
  noSideEffects(gh);
});

test('the specification approval survives a design being recorded on the Epic (design is not part of the approved view)', () => {
  const before = epicDoc(d => { d.design = null; });
  const after = epicDoc(d => { d.design = {path: 'docs/design/export.md', sha256: SHA_B, gitRef: COMMIT}; });
  assert.equal(specificationDigest(before), specificationDigest(after));
  assert.deepEqual(specificationApprovalView(before), specificationApprovalView(after));
});

for (const [label, mutate, labels, code] of [
  ['stage specification', (d: EpicDocV1) => { d.stage = 'specification'; }, ['Type: Scaffold', 'Scope: Epic', 'Stage: Specification'], 'STAGE_MISMATCH'],
  ['Blocked', () => {}, [...EPIC_LABELS, 'Blocked'], 'EPIC_BLOCKED'],
] as const) {
  test(`an Epic in ${label} is blocked`, async t => {
    const gh = world(epicDoc(mutate), [...labels]);
    const out = await (await harness(t, gh)).invoke();
    assert.equal(out.r.status, 'blocked');
    assert.ok(out.r.problems.some(x => x.code === code), JSON.stringify(out.r.problems));
    noSideEffects(gh);
  });
}

test('stale Epic body or revision is blocked', async t => {
  for (const extra of [{expectedBodySha256: 'f'.repeat(64)}, {expectedRevision: 2}]) {
    const gh = world();
    const out = await (await harness(t, gh)).invoke(base(gh, extra));
    assert.equal(out.r.status, 'blocked'); noSideEffects(gh);
  }
});

// ---- the native Feature set ---------------------------------------------------------------------

function addFeature(gh: FakePiGh, number: number, mutate: (f: FeatureDocV1) => void = () => {}, state: 'open' | 'closed' = 'open') {
  const f = featureDoc(); f.workflowId = epicOf(gh).workflowId; f.featureKey = `F${String(number).padStart(3, '0')}`; f.createOperationId = `cccccccc-cccc-4ccc-8ccc-${String(number).padStart(12, '0')}`; mutate(f);
  gh.add({number, title: `Feature ${number}`, body: renderFeatureBlock(f), labels: ['Type: Scaffold', 'Scope: Feature', 'Stage: BasicDesign'], state});
  const epic = gh.issues.get(10)!; epic.subIssues = [...(epic.subIssues ?? []), number];
}

test('50 existing Features (closed included) block the 51st', async t => {
  const gh = world();
  for (let i = 0; i < 50; i++) addFeature(gh, 100 + i, () => {}, i % 2 ? 'closed' : 'open');
  const out = await (await harness(t, gh)).invoke(base(gh, {featureKey: 'F999'}));
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(x => x.code === 'LIMIT_EXCEEDED'), JSON.stringify(out.r.problems));
  noSideEffects(gh);
});

test('an incomplete native child list or a child of another workflow/parent blocks creation', async t => {
  const gh = world();
  gh.overrides.set('gh_subissues_list', () => FakePiGh.err('unknown', 'GITHUB_READ'));
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'blocked'); assert.ok(out.r.problems.some(x => x.code === 'FEATURE_SET_INCOMPLETE'));
  noSideEffects(gh);
  const g = world(); addFeature(g, 100, f => { f.workflowId = '99999999-9999-4999-8999-999999999999'; });
  const o2 = await (await harness(t, g)).invoke();
  assert.equal(o2.r.status, 'blocked'); assert.ok(o2.r.problems.some(x => x.code === 'WORKFLOW_MISMATCH'), JSON.stringify(o2.r.problems));
  noSideEffects(g);
});

test('a featureKey already used by another Feature is blocked, not adopted', async t => {
  const gh = world(); addFeature(gh, 100, f => { f.featureKey = 'F001'; });
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(x => x.code === 'DUPLICATE_FEATURE_KEY'), JSON.stringify(out.r.problems));
  noSideEffects(gh);
});

// ---- creating ---------------------------------------------------------------------------------------

test('a valid Feature is created as a task-kind Issue under the real Epic, attached natively and read back', async t => {
  const gh = world();
  const epicBefore = gh.issues.get(10)!.body;
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  const data = out.r.data as Data;
  assert.equal(data.featureKey, 'F001'); assert.equal(data.parentAttached, true);
  assert.equal(data.url, `https://github.com/example/demo/issues/${data.number}`);
  const submitted = gh.submitted[0]!;
  assert.equal(submitted.number, data.number, 'the number comes from the real create result');
  assert.equal(submitted.draft.template, 'scaffold-feature-v1');
  assert.equal(submitted.draft.parentIssue, 10);
  assert.deepEqual((submitted.draft.labels as string[]).sort(), ['Scope: Feature', 'Stage: BasicDesign', 'Type: Scaffold']);
  assert.deepEqual(gh.issues.get(10)!.subIssues, [data.number]);
  const f = featureOf(gh, data.number);
  assert.deepEqual([f.kind, f.parentEpic, f.featureKey, f.stage, f.workflowId, f.createOperationId], ['feature', 10, 'F001', 'basic-design', epicOf(gh).workflowId, OP]);
  assert.deepEqual(f.bindings.coder, binding(MODELS.coder, 'high'));
  assert.equal(gh.issues.get(10)!.body, epicBefore, 'the Epic body is not changed (no Feature list in the Epic)');
  assert.ok(!gh.issues.get(data.number)!.labels.some(l => l === 'Blocked' || l.startsWith('Wave') || l === 'Scope: Epic'));
});

test('the Feature body is checked like the Epic: a direct visible edit is detected', () => {
  const f = featureDoc();
  const body = renderFeatureBlock(f);
  assert.ok(parseIssueBody(body).ok);
  const edited = body.replace(renderFeatureVisible(f).split('\n')[1]!, '手で書き換えた');
  const r = parseIssueBody(edited);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.problems.some(p => p.code === 'DOC_PROJECTION_MISMATCH'));
});

test('attach failure after a successful create is partial with the number; resume attaches without posting again', async t => {
  const gh = world();
  let fail = true;
  gh.overrides.set('gh_subissue_add', () => fail ? (fail = false, FakePiGh.err('rejected', 'GITHUB_WRITE')) : undefined);
  const h = await harness(t, gh);
  const first = await h.invoke();
  assert.equal(first.r.status, 'partial', JSON.stringify(first.r));
  const n = (first.r.data as Data).number;
  assert.ok(n > 10); assert.equal((first.r.data as Data).parentAttached, false);
  assert.equal(first.r.resumeToken, OP);
  const resumed = await h.invoke();
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.equal(creates(gh), 1, 'no second post');
  assert.deepEqual(gh.issues.get(10)!.subIssues, [n]);
});

test('an unknown create result is reconciled by createOperationId; a second post never happens', async t => {
  const gh = world();
  const real = gh.execute;
  gh.overrides.set('gh_issue_submit', async args => { gh.overrides.delete('gh_issue_submit'); await real('gh_issue_submit', args); return {result: {content: [], structuredContent: {status: 'unknown'}}, isError: true}; });
  const h = await harness(t, gh);
  const first = await h.invoke();
  assert.equal(first.r.status, 'unknown');
  const resumed = await h.invoke();
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.equal(gh.submitted.length, 1, 'one Issue exists');
});

test('re-running the same operation is a noop; another operation reusing the featureKey is blocked', async t => {
  const gh = world();
  const h = await harness(t, gh);
  assert.equal((await h.invoke()).r.status, 'applied');
  const again = await h.invoke();
  assert.equal(again.r.status, 'noop'); assert.equal(again.ghWrites, 0);
  const other = await h.invoke(base(gh, {operationId: OTHER_OP}));
  assert.equal(other.r.status, 'blocked');
  assert.ok(other.r.problems.some(x => x.code === 'DUPLICATE_FEATURE_KEY'));
  assert.equal(creates(gh), 1);
});

test('the same operation with different content is blocked', async t => {
  const gh = world();
  const h = await harness(t, gh);
  assert.equal((await h.invoke()).r.status, 'applied');
  const changed = await h.invoke(base(gh, {purpose: '別の目的'}));
  assert.equal(changed.r.status, 'blocked'); assert.equal(creates(gh), 1);
});

test('no credential or full model descriptor is written into the Feature', async t => {
  const gh = world();
  const out = await (await harness(t, gh)).invoke();
  const body = gh.issues.get((out.r.data as Data).number)!.body;
  assert.ok(!/apiKey|FAKE_LOCAL_KEY|baseUrl|auth\.json/.test(body));
});
