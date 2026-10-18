import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness, loadToolModule, type Scenario} from './helpers/harness.js';
import {FakePiGh} from './helpers/fake-pi-gh.js';
import {renderEpicBlock, renderFeatureBlock} from '../src/core/epic-render.js';
import {parseIssueBody} from '../src/core/body-codec.js';
import {sha256Text} from '../src/core/digests.js';
import {labelDefinitions} from '../src/core/label-definitions.js';
import type {EpicDocV1, FeatureDocV1} from '../src/core/contracts.js';
import type {OwnerPolicy} from '../src/core/model-bindings.js';
import {populatedDoc, featureDoc, OPERATION_ID} from './helpers/docs.js';

const COMMIT = '2'.repeat(40), DESIGN = '# 基本設計（架空）\n';
const OP2 = '77777777-7777-4777-8777-777777777777';
const ISSUES = [11, 12];
const policy: OwnerPolicy = {version: 1, repos: {'example/demo': {authMode: 'file-backed', models: []}}};
const aiPolicy: OwnerPolicy = {version: 1, repos: {'example/demo': {authMode: 'file-backed', models: [], agentApprovals: ['specification-revision']}}};
const profile = {type: 'custom', customType: 'startup-profile-state', data: {version: 1, id: 'developer', label: 'developer', instructions: '開発用（架空）'}};
const STAGE_LABEL = {'basic-design': 'Stage: BasicDesign', implementation: 'Stage: Implementation', verification: 'Stage: Verification', specification: 'Stage: Specification'} as const;

function epicDoc(mutate: (d: EpicDocV1) => void = () => {}): EpicDocV1 {
  const d = populatedDoc();
  d.stage = 'implementation'; d.revision = 9; d.handoff = null; d.dependencyPlan = null; d.wavePlan = null;
  d.questions = d.questions.map(q => ({...q, answer: q.answer ?? '回答', sourceRef: q.sourceRef ?? 'hearing-1'}));
  d.research = d.research.map(r => ({...r, state: 'resolved' as const, claim: null, conclusion: r.conclusion ?? '結論', evidenceRefs: r.evidenceRefs.length ? r.evidenceRefs : ['https://example.com/e']}));
  d.constraints = d.constraints ?? []; d.outOfScope = [];
  d.design = {path: 'docs/design.md', sha256: sha256Text(DESIGN), gitRef: COMMIT};
  mutate(d);
  return d;
}
function feature(epic: EpicDocV1, n: number): FeatureDocV1 {
  return {...featureDoc(), workflowId: epic.workflowId, featureKey: `F00${n - 10}`, parentEpic: 10, editScope: [`src/f${n}/`],
    designRef: {path: 'docs/design.md', sha256: sha256Text(DESIGN), gitRef: COMMIT},
    criteria: [{id: `AC10${n - 10}`, requirementIds: [n === 11 ? 'REQ001' : 'REQ002'], verification: '単体テスト', expectedResult: '期待どおり'}],
    createOperationId: `eeeeeeee-eeee-4eee-8eee-${String(n).padStart(12, '0')}`};
}
function world(epic = epicDoc(), extraFeatureLabels: Record<number, string[]> = {}) {
  const gh = new FakePiGh().seedLabels(labelDefinitions()).enableProposals();
  gh.add({number: 10, title: 'Epic', body: renderEpicBlock(epic), labels: ['Type: Scaffold', 'Scope: Epic', STAGE_LABEL[epic.stage as keyof typeof STAGE_LABEL]], state: 'open', subIssues: [...ISSUES]});
  for (const n of ISSUES) gh.add({number: n, title: `F${n}`, body: renderFeatureBlock(feature(epic, n)), labels: ['Type: Scaffold', 'Scope: Feature', 'Stage: BasicDesign', `Wave: ${n - 10}`, ...(extraFeatureLabels[n] ?? [])], state: 'open'});
  return gh;
}
const docOf = <T>(gh: FakePiGh, n: number) => (parseIssueBody(gh.issues.get(n)!.body) as unknown as {ok: true; value: {doc: T}}).value.doc;
const epicOf = (gh: FakePiGh) => docOf<EpicDocV1>(gh, 10);
const reviseParams = (gh: FakePiGh, extra: Record<string, unknown> = {}) => ({
  repo: 'example/demo', epicIssue: 10, operationId: OPERATION_ID, expectedRevision: epicOf(gh).revision, expectedBodySha256: sha256Text(gh.issues.get(10)!.body),
  reason: '実装中に、注文一覧は月単位でしか出せないと分かったため', facts: [], criteria: [], decisions: [],
  requirements: [{id: 'REQ002', description: '注文一覧を月単位でCSVに保存できる'}], ...extra,
});
async function harness(t: {after(fn: () => Promise<void>): void}, gh: FakePiGh, tool: string, scenario: Scenario = {}) {
  const {createTool} = await loadToolModule(`extensions/tools/${tool}.ts`);
  const h = await createHarness(createTool, {scenario: {gh, policy, sessionEntries: [profile], blobs: {[`${COMMIT}:docs/design.md`]: DESIGN}, ...scenario}});
  t.after(h.dispose);
  return h;
}
const noWrites = (gh: FakePiGh) => assert.equal(gh.conditionalChanges.length, 0);

test('with agentApprovals the parent revises the approved specification itself; only the Feature using the changed REQ is Blocked', async t => {
  const gh = world();
  const before = epicOf(gh);
  const h = await harness(t, gh, 'specification-revise', {policy: aiPolicy, interactive: false});
  const out = await h.invoke(reviseParams(gh));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.equal(out.confirmCalls, 0);
  const d = out.r.data as {affectedFeatures: number[]; changedIds: string[]; agentApproval?: {kind: string; basis?: string}};
  assert.deepEqual(d.affectedFeatures, [12]);
  assert.deepEqual(d.changedIds, ['REQ002']);
  assert.deepEqual([d.agentApproval?.kind, d.agentApproval?.basis], ['specification-revision', 'policy']);
  const after = epicOf(gh);
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.stage, 'implementation', 'the stage does not move');
  assert.equal(after.requirements.find(r => r.id === 'REQ002')!.description, '注文一覧を月単位でCSVに保存できる');
  assert.deepEqual(after.research, before.research, 'research is not reset');
  assert.equal(after.specRevisions?.length, 1);
  assert.deepEqual({...after.specRevisions![0]!, approvalViewDigest: 'x'}, {revision: before.revision + 1, operationId: OPERATION_ID, stage: 'implementation', reason: '実装中に、注文一覧は月単位でしか出せないと分かったため', changedIds: ['REQ002'], affectedFeatures: [12], approvalViewDigest: 'x'});
  assert.ok(gh.issues.get(12)!.labels.includes('Blocked'));
  assert.ok(!gh.issues.get(11)!.labels.includes('Blocked'));
  // A second revision appends to the log.
  const again = await h.invoke(reviseParams(gh, {operationId: OP2, reason: '月単位に加えて週単位も要る', requirements: [{id: 'REQ001', description: '顧客一覧を週単位でもCSVに保存できる'}]}));
  assert.equal(again.r.status, 'applied', JSON.stringify(again.r.problems));
  assert.equal(epicOf(gh).specRevisions?.length, 2);
  assert.ok(gh.issues.get(11)!.labels.includes('Blocked'));
});

test('a changed AC ID blocks the Features whose criteria use it (also through the Epic AC)', async t => {
  const gh = world();
  const h = await harness(t, gh, 'specification-revise', {policy: aiPolicy});
  const ac = {...epicOf(gh).criteria.find(c => c.id === 'AC002')!, expectedResult: '日本語が正しく表示され、BOMが付く'};
  const out = await h.invoke(reviseParams(gh, {requirements: [], criteria: [ac]}));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  // AC002 covers REQ001 and REQ002, but only the AC ID changed: no Feature criterion uses AC002 itself.
  assert.deepEqual((out.r.data as {affectedFeatures: number[]}).affectedFeatures, []);
});

test('without the policy the parent TUI approves the revision; headless is refused with zero writes', async t => {
  const gh = world();
  const tui = await harness(t, gh, 'specification-revise');
  const asked = await tui.invoke(reviseParams(gh));
  assert.equal(asked.r.status, 'applied', JSON.stringify(asked.r.problems));
  assert.equal(asked.confirmCalls, 1);
  const g2 = world();
  const headless = await harness(t, g2, 'specification-revise', {interactive: false});
  const out = await headless.invoke(reviseParams(g2));
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(p => p.code === 'APPROVAL_UI_REQUIRED'));
  noWrites(g2);
});

test('only basic-design, implementation and verification Epics are revised here', async t => {
  for (const stage of ['specification', 'basic-design', 'verification'] as const) {
    const gh = world(epicDoc(d => { d.stage = stage; }));
    const out = await (await harness(t, gh, 'specification-revise', {policy: aiPolicy})).invoke(reviseParams(gh));
    if (stage === 'specification') {
      assert.equal(out.r.status, 'blocked');
      assert.ok(out.r.problems.some(p => p.code === 'STAGE_MISMATCH' && /scaffold_specification_update/.test(p.message)));
      noWrites(gh);
    } else assert.equal(out.r.status, 'applied', `${stage} ${JSON.stringify(out.r.problems)}`);
  }
});

test('a revision that leaves the specification incomplete, changes nothing, or comes from a child writes nothing', async t => {
  const gh = world();
  const incomplete = await (await harness(t, gh, 'specification-revise', {policy: aiPolicy})).invoke(reviseParams(gh, {requirements: [{id: 'REQ003', description: '件数も表示する'}]}));
  assert.equal(incomplete.r.status, 'blocked');
  assert.ok(incomplete.r.problems.some(p => p.code === 'UNCOVERED_REQUIREMENT'), JSON.stringify(incomplete.r.problems));
  noWrites(gh);
  const same = await (await harness(t, gh, 'specification-revise', {policy: aiPolicy})).invoke(reviseParams(gh, {requirements: [structuredClone(epicOf(gh).requirements[0]!)]}));
  assert.equal(same.r.status, 'noop');
  noWrites(gh);
  const child = await (await harness(t, gh, 'specification-revise', {policy: aiPolicy, child: true})).invoke(reviseParams(gh));
  assert.equal(child.r.status, 'blocked');
  noWrites(gh);
  const noReason = await (await harness(t, gh, 'specification-revise', {policy: aiPolicy})).invoke(reviseParams(gh, {reason: ' '}));
  assert.equal(noReason.r.status, 'blocked');
  noWrites(gh);
});

test('a stale Epic body or revision is refused', async t => {
  const gh = world();
  const h = await harness(t, gh, 'specification-revise', {policy: aiPolicy});
  const out = await h.invoke(reviseParams(gh, {expectedRevision: 3}));
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(p => p.code === 'STALE_REVISION'));
  noWrites(gh);
});

// ---- scaffold_feature_revise -----------------------------------------------------------------------

const featureParams = (gh: FakePiGh, n: number, extra: Record<string, unknown> = {}) => ({
  repo: 'example/demo', epicIssue: 10, featureIssue: n, operationId: OP2, expectedRevision: docOf<FeatureDocV1>(gh, n).revision, expectedBodySha256: sha256Text(gh.issues.get(n)!.body),
  criteria: [{id: `AC10${n - 10}`, requirementIds: [n === 11 ? 'REQ001' : 'REQ002'], verification: '月単位で出力する単体テスト', expectedResult: '月の境界で分かれる'}], ...extra,
});

test('after a revision, feature_revise updates the blocked Feature\'s criteria and releases Blocked', async t => {
  const gh = world();
  assert.equal((await (await harness(t, gh, 'specification-revise', {policy: aiPolicy})).invoke(reviseParams(gh))).r.status, 'applied');
  const h = await harness(t, gh, 'feature-revise');
  const before = docOf<FeatureDocV1>(gh, 12);
  const out = await h.invoke(featureParams(gh, 12));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  const after = docOf<FeatureDocV1>(gh, 12);
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.criteria[0]!.verification, '月単位で出力する単体テスト');
  assert.ok(!gh.issues.get(12)!.labels.includes('Blocked'));
  assert.equal((out.r.data as {blockedReleased: boolean}).blockedReleased, true);
  assert.ok(gh.issues.get(12)!.labels.includes('Wave: 2'), 'other labels are kept');
});

test('feature_revise keeps a Blocked label that no specification revision set', async t => {
  const gh = world(epicDoc(), {11: ['Blocked']});
  const out = await (await harness(t, gh, 'feature-revise')).invoke(featureParams(gh, 11));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.ok(gh.issues.get(11)!.labels.includes('Blocked'));
  assert.equal((out.r.data as {blockedReleased: boolean}).blockedReleased, false);
});

test('feature_revise refuses criteria outside the Epic, an Epic in specification, and a stale Feature body', async t => {
  const gh = world();
  const h = await harness(t, gh, 'feature-revise');
  const unknown = await h.invoke(featureParams(gh, 11, {criteria: [{id: 'AC101', requirementIds: ['REQ404'], verification: 'v', expectedResult: 'e'}]}));
  assert.equal(unknown.r.status, 'blocked');
  assert.ok(unknown.r.problems.some(p => p.code === 'UNKNOWN_REFERENCE'));
  const mismatch = await h.invoke(featureParams(gh, 11, {criteria: [{...epicOf(gh).criteria[0]!, expectedResult: '別の結果'}]}));
  assert.ok(mismatch.r.problems.some(p => p.code === 'CRITERION_MISMATCH'));
  const stale = await h.invoke(featureParams(gh, 11, {expectedRevision: 99}));
  assert.ok(stale.r.problems.some(p => p.code === 'STALE_REVISION'));
  noWrites(gh);
  const g2 = world(epicDoc(d => { d.stage = 'specification'; }));
  const early = await (await harness(t, g2, 'feature-revise')).invoke(featureParams(g2, 11));
  assert.ok(early.r.problems.some(p => p.code === 'STAGE_MISMATCH'));
  noWrites(g2);
});

test('a revision interrupted after the Epic body is resumed with the same operationId without re-checking the changed body', async t => {
  const gh = world();
  const h = await harness(t, gh, 'specification-revise', {policy: aiPolicy});
  const p = reviseParams(gh);
  gh.overrides.set('gh_issue_labels_if_current', () => FakePiGh.err('rejected', 'PRECONDITION_FAILED'));
  const first = await h.invoke(p);
  assert.equal(first.r.status, 'partial', JSON.stringify(first.r));
  assert.equal(epicOf(gh).specRevisions?.length, 1, 'the Epic body was written');
  assert.ok(!gh.issues.get(12)!.labels.includes('Blocked'));
  gh.overrides.delete('gh_issue_labels_if_current');
  const resumed = await h.invoke(p);
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.ok(gh.issues.get(12)!.labels.includes('Blocked'));
  assert.equal(epicOf(gh).specRevisions?.length, 1, 'written once');
});
