import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {createHarness, loadToolModule, type Scenario} from './helpers/harness.js';
import {FakePiGh} from './helpers/fake-pi-gh.js';
import {renderEpicBlock, renderFeatureBlock} from '../src/core/epic-render.js';
import {parseIssueBody} from '../src/core/body-codec.js';
import {sha256Text} from '../src/core/digests.js';
import {labelDefinitions} from '../src/core/label-definitions.js';
import {repoHash} from '../src/core/repo-context.js';
import type {EpicDocV1, FeatureDocV1} from '../src/core/contracts.js';
import type {OwnerPolicy} from '../src/core/model-bindings.js';
import {populatedDoc, featureDoc, OPERATION_ID} from './helpers/docs.js';

const VERIFIED = 'a1'.repeat(20), MAIN = 'b2'.repeat(20), OLD = 'c3'.repeat(20), REMOTE_ONLY = 'd4'.repeat(20);
const commits = {exists: [VERIFIED, MAIN, OLD], ancestors: [[VERIFIED, MAIN], [OLD, VERIFIED], [OLD, MAIN]] as [string, string][]};
const policy: OwnerPolicy = {version: 1, repos: {'example/demo': {authMode: 'file-backed', models: []}}};
const profile = {type: 'custom', customType: 'startup-profile-state', data: {version: 1, id: 'developer', label: 'developer', instructions: '開発用（架空）'}};
const ISSUES = [11, 12];
const PROJECT = {projectId: 'PVT_fixture1', itemId: 'PVTI_10', statusFieldId: 'PVTSSF_status', doneOptionId: 'opt_done'};

function epicDoc(mutate: (d: EpicDocV1) => void = () => {}): EpicDocV1 {
  const d = populatedDoc();
  d.stage = 'verification'; d.revision = 14; d.handoff = null;
  d.questions = d.questions.map(q => ({...q, answer: q.answer ?? '回答', sourceRef: q.sourceRef ?? 'hearing-1'}));
  d.research = d.research.map(r => ({...r, state: 'resolved' as const, claim: null, conclusion: r.conclusion ?? '結論', evidenceRefs: r.evidenceRefs.length ? r.evidenceRefs : ['https://example.com/e']}));
  mutate(d);
  return d;
}
function feature(epic: EpicDocV1, n: number): FeatureDocV1 {
  return {...featureDoc(), workflowId: epic.workflowId, featureKey: `F00${n - 10}`, parentEpic: 10, stage: 'implementation', editScope: [`src/f${n}/`],
    criteria: [{id: `AC10${n - 10}`, requirementIds: [n === 11 ? 'REQ001' : 'REQ002'], verification: 'v', expectedResult: 'e'}], createOperationId: `eeeeeeee-eeee-4eee-8eee-${String(n).padStart(12, '0')}`};
}
function world(opts: {epic?: EpicDocV1; epicLabels?: string[]; state?: 'open' | 'closed'; features?: Record<number, FeatureDocV1>} = {}) {
  const gh = new FakePiGh().seedLabels(labelDefinitions()).enableProposals();
  const epic = opts.epic ?? epicDoc();
  gh.add({number: 10, title: 'Epic', body: 'メモ（管理外）\n\n' + renderEpicBlock(epic), labels: opts.epicLabels ?? ['Type: Scaffold', 'Scope: Epic', 'Stage: Verification'], state: opts.state ?? 'open', subIssues: [...ISSUES]});
  for (const n of ISSUES) gh.add({number: n, title: `F${n}`, body: renderFeatureBlock(opts.features?.[n] ?? feature(epic, n)), labels: ['Type: Scaffold', 'Scope: Feature', 'Stage: Implementation', 'Wave: 1'], state: 'open'});
  gh.projects.set(PROJECT.projectId, [10]);
  gh.projectFields.set(PROJECT.projectId, [{id: PROJECT.statusFieldId, name: 'Status', dataType: 'SINGLE_SELECT', options: [{id: 'opt_todo', name: 'Todo'}, {id: PROJECT.doneOptionId, name: 'Done'}]}]);
  return gh;
}
const docOf = (gh: FakePiGh) => (parseIssueBody(gh.issues.get(10)!.body) as {ok: true; value: {doc: EpicDocV1}}).value.doc;
type Report = {version: 1; workflowId: string; featureIssue: number; productRef: string; suiteRef: string; criteria: {id: string; status: string; command: string; exitCode: number | null; logPath: string; logSha256: string}[]};
async function owned(path: string, text: string) { await mkdir(dirname(path), {recursive: true, mode: 0o700}); await writeFile(path, text, {mode: 0o600}); }
async function writeEvidence(agentDir: string, mutate: (r: Report[]) => void = () => {}) {
  const root = join(agentDir, 'pi-scaffold', 'state', repoHash('example/demo'), epicDoc().workflowId, 'evidence');
  const reports: Report[] = ISSUES.map(n => ({version: 1, workflowId: epicDoc().workflowId, featureIssue: n, productRef: VERIFIED, suiteRef: VERIFIED,
    criteria: feature(epicDoc(), n).criteria.map(c => ({id: c.id, status: 'pass', command: 'npm test', exitCode: 0, logPath: `final/${n}.log`, logSha256: sha256Text(`final ${n}\n`)}))}));
  mutate(reports);
  for (const r of reports) for (const c of r.criteria) await owned(join(root, c.logPath), `final ${r.featureIssue}\n`);
  const refs: {relativePath: string; sha256: string}[] = [];
  for (const r of reports) { const text = JSON.stringify(r); await owned(join(root, `final/${r.featureIssue}.json`), text); refs.push({relativePath: `final/${r.featureIssue}.json`, sha256: sha256Text(text)}); }
  return refs;
}
async function harness(t: {after(fn: () => Promise<void>): void}, gh: FakePiGh, scenario: Scenario = {}) {
  const {createTool} = await loadToolModule('extensions/tools/epic-complete.ts');
  const h = await createHarness(createTool, {scenario: {gh, policy, sessionEntries: [profile], commits, remote: {branch: 'main', sha: MAIN}, ...scenario}});
  t.after(h.dispose);
  return h;
}
const params = (gh: FakePiGh, finalEvidenceRefs: unknown, extra: Record<string, unknown> = {}) => ({
  repo: 'example/demo', epicIssue: 10, operationId: OPERATION_ID, expectedRevision: docOf(gh).revision, expectedBodySha256: sha256Text(gh.issues.get(10)!.body),
  verifiedRef: VERIFIED, finalEvidenceRefs, ...extra,
});
type Data = {issueClosed: boolean; projectUpdated: boolean; verifiedRef: string; remoteMainRef: string; pendingStep: string | null};
const closes = (gh: FakePiGh) => gh.count('gh_issue_close_if_current') + gh.count('gh_issue_close');
const projectWrites = (gh: FakePiGh) => gh.count('gh_project_field_update');
const nothingChanged = (gh: FakePiGh, before: string) => { assert.equal(closes(gh), 0); assert.equal(projectWrites(gh), 0); assert.equal(gh.issues.get(10)!.body, before); assert.equal(gh.conditionalChanges.length, 0); };
async function expectBlocked(t: {after(fn: () => Promise<void>): void}, code: string, opts: {gh?: FakePiGh; scenario?: Scenario; mutate?: (r: Report[]) => void; extra?: Record<string, unknown>} = {}) {
  const gh = opts.gh ?? world(); const before = gh.issues.get(10)!.body;
  const h = await harness(t, gh, opts.scenario);
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir, opts.mutate), opts.extra));
  assert.equal(out.r.status, 'blocked', JSON.stringify(out.r));
  assert.ok(out.r.problems.some(p => p.code === code), JSON.stringify(out.r.problems));
  assert.equal(out.confirmCalls, 0, 'the final acceptance is not asked for an incomplete state');
  nothingChanged(gh, before);
}

// ---- completion gate ------------------------------------------------------------------------------

test('an uncovered requirement blocks', async t => {
  const epic = epicDoc();
  const f12 = feature(epic, 12); f12.criteria = [{id: 'AC102', requirementIds: ['REQ001'], verification: 'v', expectedResult: 'e'}];
  await expectBlocked(t, 'REQUIREMENT_UNCOVERED', {gh: world({features: {12: f12}})});
});
for (const [label, mutate, code] of [
  ['an unverified AC', (r: Report[]) => { r[0]!.criteria[0]!.status = 'unverified'; }, 'CRITERION_NOT_PASSED'],
  ['a failed AC', (r: Report[]) => { r[0]!.criteria[0]!.status = 'fail'; }, 'CRITERION_NOT_PASSED'],
  ['missing evidence', (r: Report[]) => { r[1]!.criteria = []; }, 'CRITERION_EVIDENCE_MISSING'],
] as const) test(`${label} blocks`, async t => { await expectBlocked(t, code, {mutate}); });
test('an unanswered required question, an open conflict or unresolved research blocks', async t => {
  await expectBlocked(t, 'UNANSWERED', {gh: world({epic: epicDoc(d => { d.questions[0] = {...d.questions[0]!, kind: 'question', required: true, answer: null, sourceRef: null}; })})});
  await expectBlocked(t, 'RESEARCH_OPEN', {gh: world({epic: epicDoc(d => { d.research[0] = {...d.research[0]!, state: 'pending', claim: null}; })})});
});
test('Blocked and a direct visible edit block', async t => {
  await expectBlocked(t, 'BLOCKED', {gh: world({epicLabels: ['Type: Scaffold', 'Scope: Epic', 'Stage: Verification', 'Blocked']})});
  const gh = world();
  const h = await harness(t, gh);
  const p = params(gh, await writeEvidence(h.agentDir));
  gh.issues.get(10)!.body = gh.issues.get(10)!.body.replace('## 目的', '## 目的（手で編集）');
  const out = await h.invoke({...p, expectedBodySha256: sha256Text(gh.issues.get(10)!.body)});
  assert.equal(out.r.status, 'blocked'); assert.ok(out.r.problems.some(p => p.code === 'DOC_PROJECTION_MISMATCH')); assert.equal(closes(gh), 0);
});
test('a foreign origin blocks', async t => { await expectBlocked(t, 'ORIGIN_MISMATCH', {scenario: {origin: 'https://github.com/other/repo.git'}}); });
test('verifiedRef missing, abbreviated or HEAD blocks', async t => {
  await expectBlocked(t, 'REF_NOT_FOUND', {extra: {verifiedRef: 'e5'.repeat(20)}});
  const gh = world(); const h = await harness(t, gh);
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir), {verifiedRef: 'HEAD'}));
  assert.equal(out.r.status, 'blocked'); assert.ok(out.r.problems.some(p => p.path === 'verifiedRef')); assert.equal(closes(gh), 0);
});
test('verifiedRef not contained in origin\'s default branch blocks', async t => {
  await expectBlocked(t, 'NOT_IN_DEFAULT_BRANCH', {scenario: {remote: {branch: 'main', sha: OLD}}});
});
test('a remote default-branch commit missing locally stops and asks for a fetch (no fetch/merge/push)', async t => {
  await expectBlocked(t, 'REMOTE_REF_NOT_LOCAL', {scenario: {remote: {branch: 'main', sha: REMOTE_ONLY}}});
});
test('the default branch is read from origin (master works the same)', async t => {
  const gh = world(); const h = await harness(t, gh, {remote: {branch: 'master', sha: MAIN}});
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir)));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
});
test('an unreadable remote blocks', async t => { await expectBlocked(t, 'REMOTE_UNREADABLE', {scenario: {remote: undefined}}); });

// ---- acceptance -----------------------------------------------------------------------------------

test('without the parent\'s final acceptance (headless) nothing is closed; approved flags or D records do not count', async t => {
  const gh = world({epic: epicDoc(d => { d.decisions.push({id: 'D009', topic: '最終受け入れ', decision: '承認済み', reason: '親', sourceRefs: []}); })});
  const before = gh.issues.get(10)!.body;
  const h = await harness(t, gh, {interactive: false});
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir)));
  assert.equal(out.r.status, 'blocked'); assert.ok(out.r.problems.some(p => p.code === 'APPROVAL_UI_REQUIRED'));
  nothingChanged(gh, before);
  const g2 = world(); const h2 = await harness(t, g2);
  const bad = await h2.invoke(params(g2, await writeEvidence(h2.agentDir), {approved: true}));
  assert.equal(bad.inputSchemaValid, false); assert.equal(bad.r.status, 'blocked'); assert.equal(closes(g2), 0);
});
test('declining the final acceptance cancels with zero changes', async t => {
  const gh = world(); const before = gh.issues.get(10)!.body;
  const h = await harness(t, gh, {confirm: false});
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir)));
  assert.equal(out.r.status, 'cancelled'); nothingChanged(gh, before);
});
test('an acceptance recorded for an older remote default branch is not reused', async t => {
  const gh = world();
  gh.overrides.set('gh_issue_edit_if_current', () => FakePiGh.err('rejected', 'PRECONDITION_FAILED'));
  const parent = await harness(t, gh);
  const refs = await writeEvidence(parent.agentDir);
  const first = await parent.invoke(params(gh, refs));
  assert.equal(first.confirmCalls, 1, 'the acceptance was recorded'); assert.notEqual(first.r.status, 'applied');
  gh.overrides.delete('gh_issue_edit_if_current');
  // origin's default branch moved on (still containing verifiedRef): the old acceptance named another main.
  const later = await harness(t, gh, {agentDir: parent.agentDir, interactive: false, commits: {exists: [...commits.exists, 'e5'.repeat(20)], ancestors: [...commits.ancestors, [VERIFIED, 'e5'.repeat(20)]]}, remote: {branch: 'main', sha: 'e5'.repeat(20)}});
  const out = await later.invoke(params(gh, refs, {operationId: 'abababab-abab-4bab-8bab-abababababab'}));
  assert.equal(out.r.status, 'blocked'); assert.ok(out.r.problems.some(p => p.code === 'APPROVAL_UI_REQUIRED'), JSON.stringify(out.r.problems));
  assert.equal(closes(gh), 0);
});

// ---- applying -------------------------------------------------------------------------------------

test('all gates and the acceptance: body/Stage, close, read back, Project Done, read back', async t => {
  const gh = world();
  const h = await harness(t, gh);
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir), {project: PROJECT}));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.equal(out.confirmCalls, 1);
  const d = out.r.data as Data;
  assert.deepEqual([d.issueClosed, d.projectUpdated, d.verifiedRef, d.remoteMainRef, d.pendingStep], [true, true, VERIFIED, MAIN, null]);
  assert.equal(gh.issues.get(10)!.state, 'closed');
  assert.equal(docOf(gh).stage, 'completed');
  assert.deepEqual(gh.issues.get(10)!.labels.sort(), ['Scope: Epic', 'Stage: Completed', 'Type: Scaffold']);
  assert.ok(gh.issues.get(10)!.body.startsWith('メモ（管理外）'));
  assert.equal(gh.itemValues.get('PVTI_10')?.[PROJECT.statusFieldId], PROJECT.doneOptionId);
  const order = gh.calls.map(c => c.name).filter(n => /if_current|field_update/.test(n));
  assert.deepEqual(order, ['gh_issue_edit_if_current', 'gh_issue_labels_if_current', 'gh_issue_close_if_current', 'gh_project_field_update']);
  for (const n of ISSUES) assert.equal(gh.issues.get(n)!.state, 'open', 'Features are not closed by this tool');
});
test('without a project there is no Project call at all', async t => {
  const gh = world(); const h = await harness(t, gh);
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir)));
  assert.equal(out.r.status, 'applied'); assert.equal(gh.calls.filter(c => c.name.startsWith('gh_project_')).length, 0);
  assert.equal((out.r.data as Data).projectUpdated, false);
});
for (const [label, project] of [
  ['another item', {...PROJECT, itemId: 'PVTI_99'}], ['another field', {...PROJECT, statusFieldId: 'PVTSSF_other'}], ['a missing Done option', {...PROJECT, doneOptionId: 'opt_missing'}],
] as const) test(`a Project with ${label} is refused up front`, async t => { await expectBlocked(t, 'PROJECT_TARGET_INVALID', {extra: {project}}); });

test('close succeeded but Project failed: partial with issueClosed; resume only updates the Project', async t => {
  const gh = world();
  let fail = true;
  gh.overrides.set('gh_project_field_update', () => fail ? (fail = false, FakePiGh.err('rejected', 'GITHUB_WRITE')) : undefined);
  const h = await harness(t, gh);
  const input = params(gh, await writeEvidence(h.agentDir), {project: PROJECT});
  const first = await h.invoke(input);
  assert.equal(first.r.status, 'partial', JSON.stringify(first.r));
  assert.deepEqual([(first.r.data as Data).issueClosed, (first.r.data as Data).projectUpdated, (first.r.data as Data).pendingStep], [true, false, 'project']);
  const closesBefore = closes(gh);
  const resumed = await h.invoke(input);
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.equal(closes(gh), closesBefore, 'no second close');
  assert.equal(resumed.confirmCalls, 0, 'the accepted completion is not asked again');
});
test('an unknown close is reconciled from the Issue, never re-sent blindly', async t => {
  const gh = world();
  const real = gh.execute;
  gh.overrides.set('gh_issue_close_if_current', args => { gh.overrides.delete('gh_issue_close_if_current'); return real('gh_issue_close_if_current', args).then(() => ({result: {content: [], structuredContent: {status: 'unknown'}}, isError: true})); });
  const h = await harness(t, gh);
  const input = params(gh, await writeEvidence(h.agentDir));
  assert.equal((await h.invoke(input)).r.status, 'unknown');
  const before = closes(gh);
  const resumed = await h.invoke(input);
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.equal(closes(gh), before);
});
test('an Epic that is already closed is not a success by itself: everything is checked again', async t => {
  const gh = world({state: 'closed'}); const before = gh.issues.get(10)!.body;
  const h = await harness(t, gh, {interactive: false});
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir)));
  assert.notEqual(out.r.status, 'noop'); assert.notEqual(out.r.status, 'applied');
  nothingChanged(gh, before);
});
test('no reopen, rollback or notification on failure', async t => {
  const gh = world();
  gh.overrides.set('gh_issue_close_if_current', () => FakePiGh.err('rejected', 'PRECONDITION_FAILED'));
  const h = await harness(t, gh);
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir)));
  assert.notEqual(out.r.status, 'applied');
  assert.equal(docOf(gh).stage, 'completed', 'the Stage change is kept (no rollback)');
  assert.equal(gh.calls.filter(c => /reopen|comment|notify/.test(c.name)).length, 0);
});

// ---- guards proven one by one ---------------------------------------------------------------------

test('an Epic someone closed by hand can still be completed, but only with the full check and the parent\'s acceptance', async t => {
  const gh = world({state: 'closed'});
  const h = await harness(t, gh);
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir)));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.equal(out.confirmCalls, 1, 'acceptance is still required');
  assert.equal(docOf(gh).stage, 'completed');
  assert.equal(closes(gh), 0, 'no second close');
});

test('after this operation closed the Issue, a resume only finishes the Project even if origin moved meanwhile', async t => {
  const gh = world();
  let fail = true;
  gh.overrides.set('gh_project_field_update', () => fail ? (fail = false, FakePiGh.err('rejected', 'GITHUB_WRITE')) : undefined);
  const h = await harness(t, gh);
  const input = params(gh, await writeEvidence(h.agentDir), {project: PROJECT});
  assert.equal((await h.invoke(input)).r.status, 'partial');
  const later = await harness(t, gh, {agentDir: h.agentDir, interactive: false, remote: {branch: 'main', sha: OLD}});
  const resumed = await later.invoke(input);
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.equal(gh.itemValues.get('PVTI_10')?.[PROJECT.statusFieldId], PROJECT.doneOptionId);
});

test('a Project update reported as applied but not visible is caught by the read-back', async t => {
  const gh = world();
  gh.overrides.set('gh_project_field_update', () => FakePiGh.ok({projectId: PROJECT.projectId}, 'applied'));
  const h = await harness(t, gh);
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir), {project: PROJECT}));
  assert.notEqual(out.r.status, 'applied');
  assert.ok(out.r.problems.some(p => p.code === 'PROJECT_NOT_DONE'), JSON.stringify(out.r.problems));
  assert.equal((out.r.data as Data).issueClosed, true);
});
