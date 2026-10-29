import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
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
function world(opts: {epic?: EpicDocV1; epicLabels?: string[]; state?: 'open' | 'closed'; stateReason?: 'completed' | 'not_planned'; features?: Record<number, FeatureDocV1>; openIssues?: number[]} = {}) {
  const gh = new FakePiGh().seedLabels(labelDefinitions()).enableProposals();
  const epic = opts.epic ?? epicDoc();
  gh.add({number: 10, title: 'Epic', body: 'メモ（管理外）\n\n' + renderEpicBlock(epic), labels: opts.epicLabels ?? ['Type: Scaffold', 'Scope: Epic', 'Stage: Verification'], state: opts.state ?? 'open', ...(opts.stateReason ? {stateReason: opts.stateReason} : {}), subIssues: [...ISSUES]});
  for (const n of ISSUES) gh.add({number: n, title: `F${n}`, body: renderFeatureBlock(opts.features?.[n] ?? feature(epic, n)), labels: ['Type: Scaffold', 'Scope: Feature', 'Stage: Implementation', 'Wave: 1'], state: opts.openIssues?.includes(n) ? 'open' : 'closed'});
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
  assert.equal(closes(gh), 1, 'only the Epic is closed by this tool');
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

// ---- review follow-ups --------------------------------------------------------------------------

test('a close left uncertain is resumed only through the full gate: a requirement added meanwhile stops it', async t => {
  const gh = world();
  gh.overrides.set('gh_issue_close_if_current', () => ({result: {content: [], structuredContent: {status: 'unknown'}}, isError: true}));
  const h = await harness(t, gh);
  const input = params(gh, await writeEvidence(h.agentDir));
  assert.equal((await h.invoke(input)).r.status, 'unknown');
  gh.overrides.delete('gh_issue_close_if_current');
  const d = docOf(gh); d.requirements.push({id: 'REQ009', description: '後から追加された要件'});
  gh.issues.get(10)!.body = 'メモ（管理外）\n\n' + renderEpicBlock(d);
  const before = closes(gh);
  const resumed = await h.invoke(input);
  assert.notEqual(resumed.r.status, 'applied', JSON.stringify(resumed.r));
  assert.equal(gh.issues.get(10)!.state, 'open'); assert.equal(closes(gh), before, 'no close over the changed requirements');
});

test('Blocked always stops: also with a Completed label (no stage transition) and on resume', async t => {
  await expectBlocked(t, 'BLOCKED', {gh: world({epicLabels: ['Type: Scaffold', 'Scope: Epic', 'Stage: Completed', 'Blocked']})});
  const gh = world();
  let fail = true;
  gh.overrides.set('gh_issue_close_if_current', () => fail ? (fail = false, FakePiGh.err('rejected', 'GITHUB_WRITE')) : undefined);
  const h = await harness(t, gh);
  const input = params(gh, await writeEvidence(h.agentDir));
  assert.notEqual((await h.invoke(input)).r.status, 'applied');
  gh.issues.get(10)!.labels.push('Blocked');
  const resumed = await h.invoke(input);
  assert.equal(resumed.r.status, 'blocked'); assert.ok(resumed.r.problems.some(p => p.code === 'BLOCKED'), JSON.stringify(resumed.r.problems));
  assert.equal(gh.issues.get(10)!.state, 'open');
});

test('a Stage label that disagrees with the body stage stops before any change', async t => {
  await expectBlocked(t, 'STAGE_LABEL_MISMATCH', {gh: world({epicLabels: ['Type: Scaffold', 'Scope: Epic', 'Stage: Completed']})});
});

test('an Epic closed by hand as "not planned" is not completed', async t => {
  await expectBlocked(t, 'CLOSED_NOT_COMPLETED', {gh: world({state: 'closed', stateReason: 'not_planned'})});
});

test('the Project item of another Issue in the same Project is refused', async t => {
  const gh = world(); gh.projects.set(PROJECT.projectId, [10, 11]);
  const before = gh.issues.get(10)!.body;
  const h = await harness(t, gh);
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir), {project: {...PROJECT, itemId: 'PVTI_11'}}));
  assert.equal(out.r.status, 'blocked'); assert.ok(out.r.problems.some(p => p.code === 'PROJECT_TARGET_INVALID')); nothingChanged(gh, before);
});

test('a hand-closed Epic whose Project update fails reports issueClosed=true and pending project', async t => {
  const gh = world({state: 'closed'});
  gh.overrides.set('gh_project_field_update', () => FakePiGh.err('rejected', 'GITHUB_WRITE'));
  const h = await harness(t, gh);
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir), {project: PROJECT}));
  assert.equal(out.r.status, 'partial', JSON.stringify(out.r));
  assert.deepEqual([(out.r.data as Data).issueClosed, (out.r.data as Data).pendingStep], [true, 'project']);
});

test('without a project, a failure never reports a pending Project step', async t => {
  const gh = world();
  gh.overrides.set('gh_issue_close_if_current', () => FakePiGh.err('rejected', 'GITHUB_WRITE'));
  const h = await harness(t, gh);
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir)));
  assert.notEqual(out.r.status, 'applied');
  assert.notEqual((out.r.data as Partial<Data> | undefined)?.pendingStep, 'project');
});

test('the acceptance shows the Features, evidence and Project target, and binds the Project target', async t => {
  const gh = world();
  const shown: string[] = [];
  const h = await harness(t, gh, {confirm: () => true});
  (h as unknown as {tool: unknown});
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir), {project: PROJECT}));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  void shown;
  const {completionApprovalView} = await import('../src/core/completion-gate.js');
  const base = {status: 'validated' as const, problems: [], artifactDigests: {}, verifiedRef: VERIFIED, remoteMainRef: MAIN, defaultBranch: 'main'};
  const features = ISSUES.map(n => ({number: n, doc: feature(epicDoc(), n)})) as never;
  const refs = [{relativePath: 'final/11.json', sha256: 'a'.repeat(64)}];
  const v1 = completionApprovalView(epicDoc(), 'f'.repeat(64), refs, base, features, PROJECT);
  const v2 = completionApprovalView(epicDoc(), 'f'.repeat(64), refs, base, features, {...PROJECT, doneOptionId: 'opt_other'});
  assert.notEqual(v1.contentDigest, v2.contentDigest);
  assert.match(v1.text, /#11 F001/); assert.match(v1.text, /final\/11\.json/); assert.match(v1.text, /PVTI_10/);
});

test('an open Feature or Task blocks before any change with TREE_ISSUES_OPEN', async t => {
  await expectBlocked(t, 'TREE_ISSUES_OPEN', {gh: world({openIssues: [12]})});
  const task = world({epic: epicDoc(d => { d.projectIds = [PROJECT.projectId]; })});
  task.issues.get(11)!.subIssues = [13]; task.add({number: 13, title: 'T13', body: '', labels: [], state: 'open'});
  const before = task.issues.get(10)!.body; const h = await harness(t, task);
  const out = await h.invoke(params(task, await writeEvidence(h.agentDir)));
  assert.equal(out.r.status, 'blocked'); assert.equal(out.confirmCalls, 0); nothingChanged(task, before); assert.equal(task.count('gh_project_close'), 0);
  const p = out.r.problems.find(x => x.code === 'TREE_ISSUES_OPEN'); assert.ok(p, JSON.stringify(out.r.problems)); assert.match(p.message, /#13/);
});
test('an unreadable recorded Project blocks before any change', async t => {
  await expectBlocked(t, 'PROJECT_UNREADABLE', {gh: world({epic: epicDoc(d => { d.projectIds = ['PVT_missing']; })})});
});
test('the acceptance shows the Projects to close and the skipped ones', async t => {
  const recorded = (ids: string[]) => { const gh = world({epic: epicDoc(d => { d.projectIds = ids; })}); gh.projects.set('PVT_other', [10, 99]); gh.projectFields.set('PVT_other', []); return gh; };
  const gh = recorded([PROJECT.projectId, 'PVT_other']);
  const shown: string[] = [];
  const h = await harness(t, gh, {confirm: (_title, message) => { shown.push(message); return false; }});
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir)));
  assert.equal(out.r.status, 'cancelled', JSON.stringify(out.r)); assert.equal(shown.length, 1);
  assert.match(shown[0]!, /Project を閉じる: PVT_fixture1/); assert.match(shown[0]!, /閉じない: PVT_other（別の Issue が混ざっている）/);
  const none = world(); const shownNone: string[] = [];
  const h2 = await harness(t, none, {confirm: (_title, message) => { shownNone.push(message); return false; }});
  await h2.invoke(params(none, await writeEvidence(h2.agentDir)));
  assert.match(shownNone[0]!, /Project の記録なし/);
  assert.equal(gh.count('gh_project_close'), 0);
  const {completionApprovalView} = await import('../src/core/completion-gate.js');
  const base = {status: 'validated' as const, problems: [], artifactDigests: {}, verifiedRef: VERIFIED, remoteMainRef: MAIN, defaultBranch: 'main'};
  const features = ISSUES.map(n => ({number: n, doc: feature(epicDoc(), n)})) as never;
  const refs = [{relativePath: 'final/11.json', sha256: 'a'.repeat(64)}];
  const v1 = completionApprovalView(epicDoc(), 'f'.repeat(64), refs, base, features, undefined, {close: ['PVT_a'], alreadyClosed: [], skipped: []});
  const v2 = completionApprovalView(epicDoc(), 'f'.repeat(64), refs, base, features, undefined, {close: [], alreadyClosed: [], skipped: [{projectId: 'PVT_a', reason: 'foreign-items'}]});
  assert.notEqual(v1.contentDigest, v2.contentDigest);
});

// ---- agent decision stages ------------------------------------------------------------------------

const agentPolicy = (stages: ('implementation' | 'verification')[], key = 'example/demo'): OwnerPolicy => ({version: 1, repos: {[key]: {authMode: 'file-backed', models: [], agentDecisionStages: stages}}});
const accepted = (targetStage: 'specification' | 'basic-design' | 'implementation' | 'verification', extra: Record<string, string> = {}) => ({sessionId: 'session-harness', repo: 'example/demo', workflowId: epicDoc().workflowId, targetStage, ...extra});

test('in a Verification session listed in agentDecisionStages the parent records the final acceptance itself (no dialog, headless ok)', async t => {
  for (const interactive of [true, false]) {
    const gh = world();
    const h = await harness(t, gh, {interactive, policy: agentPolicy(['verification']), handoff: accepted('verification')});
    const out = await h.invoke(params(gh, await writeEvidence(h.agentDir)));
    assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
    assert.equal(out.confirmCalls, 0, 'the human is not asked');
    const d = out.r.data as Data & {agentApproval?: {kind: string; stage: string; viewDigest: string}};
    assert.deepEqual([d.agentApproval?.kind, d.agentApproval?.stage], ['epic-completion', 'verification']);
    assert.match(d.agentApproval!.viewDigest, /^[0-9a-f]{64}$/);
    assert.equal(gh.issues.get(10)!.state, 'closed');
  }
});

test('the final acceptance still needs the human when the stage is not listed, the packet is another stage/repo, or there is none', async t => {
  for (const scenario of [
    {policy: agentPolicy(['implementation']), handoff: accepted('verification')},
    {policy: agentPolicy(['implementation', 'verification']), handoff: accepted('basic-design')},
    {policy: agentPolicy(['implementation', 'verification']), handoff: accepted('specification')},
    {policy: agentPolicy(['verification'], 'example/*'), handoff: accepted('verification', {repo: 'example/other'})},
    {policy: agentPolicy(['verification'])},
    {policy, handoff: accepted('verification')},
  ] as Scenario[]) {
    const gh = world(), before = gh.issues.get(10)!.body;
    const headless = await harness(t, gh, {...scenario, interactive: false});
    const blocked = await headless.invoke(params(gh, await writeEvidence(headless.agentDir)));
    assert.equal(blocked.r.status, 'blocked', JSON.stringify(scenario));
    assert.ok(blocked.r.problems.some(p => p.code === 'APPROVAL_UI_REQUIRED'), JSON.stringify(blocked.r.problems));
    nothingChanged(gh, before);
    const parent = await harness(t, gh, {...scenario});
    const out = await parent.invoke(params(gh, await writeEvidence(parent.agentDir)));
    assert.equal(out.confirmCalls, 1, JSON.stringify(scenario));
    assert.equal(out.r.status, 'applied');
    assert.equal((out.r.data as {agentApproval?: unknown}).agentApproval, undefined);
  }
});

test('a subagent child in a listed Verification session still cannot give the final acceptance', async t => {
  const gh = world(), before = gh.issues.get(10)!.body;
  const h = await harness(t, gh, {child: true, policy: agentPolicy(['verification']), handoff: accepted('verification')});
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir)));
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(p => p.code === 'APPROVAL_UI_REQUIRED'));
  assert.equal(out.confirmCalls, 0);
  nothingChanged(gh, before);
});

const approvalFiles = async (agentDir: string) => ((await readdir(join(agentDir, 'pi-scaffold'), {recursive: true})) as string[]).filter(f => /approvals[\\/].+\.json$/.test(f)).map(f => join(agentDir, 'pi-scaffold', f));
const otherProfile = {type: 'custom', customType: 'startup-profile-state', data: {version: 1, id: 'developer', label: 'developer', instructions: '別の指示文（架空）'}};

test('a final acceptance recorded under another profile is asked again; Yes overwrites it, No keeps it and closes nothing', async t => {
  const gh = world();
  gh.overrides.set('gh_issue_edit_if_current', () => FakePiGh.err('rejected', 'PRECONDITION_FAILED'));
  const parent = await harness(t, gh);
  const refs = await writeEvidence(parent.agentDir);
  assert.equal((await parent.invoke(params(gh, refs))).confirmCalls, 1);
  gh.overrides.delete('gh_issue_edit_if_current');
  const files = (await approvalFiles(parent.agentDir)).filter(f => f.includes('epic-completion')); assert.equal(files.length, 1);
  const file = files[0]!; const before = await readFile(file, 'utf8');
  const no = await harness(t, gh, {agentDir: parent.agentDir, sessionEntries: [otherProfile], confirm: false});
  const declined = await no.invoke(params(gh, refs));
  assert.equal(declined.r.status, 'cancelled'); assert.ok(declined.r.problems.some(p => p.code === 'DECLINED'));
  assert.equal(declined.confirmCalls, 1); assert.equal(await readFile(file, 'utf8'), before); assert.equal(closes(gh), 0);
  const yes = await harness(t, gh, {agentDir: parent.agentDir, sessionEntries: [otherProfile]});
  const out = await yes.invoke(params(gh, refs));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems)); assert.equal(out.confirmCalls, 1);
  assert.notEqual(JSON.parse(await readFile(file, 'utf8')).profileInstructionsDigest, JSON.parse(before).profileInstructionsDigest);
});

test('a corrupt final acceptance record stays blocked without asking', async t => {
  const gh = world();
  gh.overrides.set('gh_issue_edit_if_current', () => FakePiGh.err('rejected', 'PRECONDITION_FAILED'));
  const parent = await harness(t, gh);
  const refs = await writeEvidence(parent.agentDir);
  await parent.invoke(params(gh, refs));
  gh.overrides.delete('gh_issue_edit_if_current');
  const file = (await approvalFiles(parent.agentDir)).find(f => f.includes('epic-completion')); assert.ok(file);
  await writeFile(file, '{not json');
  const h = await harness(t, gh, {agentDir: parent.agentDir, sessionEntries: [otherProfile]});
  const out = await h.invoke(params(gh, refs));
  assert.equal(out.r.status, 'blocked'); assert.ok(out.r.problems.some(p => p.code === 'INVALID_JSON'), JSON.stringify(out.r.problems));
  assert.equal(out.confirmCalls, 0); assert.equal(closes(gh), 0);
});

test('with agentApprovals epic-completion the parent gives the final acceptance itself without any packet (no dialog, headless ok)', async t => {
  const gh = world();
  const aiPolicy: OwnerPolicy = {version: 1, repos: {'example/demo': {authMode: 'file-backed', models: [], agentApprovals: ['epic-completion']}}};
  const h = await harness(t, gh, {interactive: false, policy: aiPolicy});
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir)));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.equal(out.confirmCalls, 0);
  const d = out.r.data as {agentApproval?: {kind: string; basis?: string}};
  assert.deepEqual([d.agentApproval?.kind, d.agentApproval?.basis], ['epic-completion', 'policy']);
});

for (const [step, op, count] of [
  ['epic-body', 'gh_issue_edit_if_current', (gh: FakePiGh) => gh.count('gh_issue_edit_if_current')],
  ['epic-labels', 'gh_issue_labels_if_current', (gh: FakePiGh) => gh.count('gh_issue_labels_if_current')],
  ['project', 'gh_project_field_update', projectWrites],
] as const) test(`an ${step} change that landed but returned unknown is reconciled on resume and not resent`, async t => {
  const gh = world();
  const real = gh.execute;
  gh.overrides.set(op, args => { gh.overrides.delete(op); return real(op, args).then(() => ({result: {content: [], structuredContent: {status: 'unknown'}}, isError: true})); });
  const h = await harness(t, gh);
  const input = params(gh, await writeEvidence(h.agentDir), {project: PROJECT});
  assert.equal((await h.invoke(input)).r.status, 'unknown');
  const before = count(gh);
  const resumed = await h.invoke(input);
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.equal(count(gh), before, `${op} is not sent again`);
  assert.equal(gh.issues.get(10)!.state, 'closed');
});

// ---- recorded Projects are closed after the Epic ----------------------------------------------------

type CloseData = Data & {projectsClosed: string[]; projectsSkipped: {projectId: string | null; reason: string}[]};
const PB = 'PVT_fixture2';
/** An Epic whose recorded Projects hold only Issues of its tree (Epic and Features). */
function recordedWorld(ids: string[] = [PROJECT.projectId], opts: Parameters<typeof world>[0] = {}) {
  const gh = world({...opts, epic: epicDoc(d => { d.projectIds = ids; })});
  for (const id of ids) { gh.projects.set(id, [10, 11, 12]); if (!gh.projectFields.has(id)) gh.projectFields.set(id, []); }
  return gh;
}

test('a recorded Project whose items are all closed tree issues is closed and read back', async t => {
  const gh = recordedWorld(); const h = await harness(t, gh);
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir)));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  const d = out.r.data as CloseData;
  assert.ok(gh.closedProjects.has(PROJECT.projectId));
  assert.deepEqual(d.projectsClosed, [PROJECT.projectId]); assert.deepEqual(d.projectsSkipped, []); assert.equal(d.pendingStep, null);
  assert.equal(gh.count('gh_project_close'), 1);
  const order = gh.calls.map(c => c.name).filter(n => /close/.test(n));
  assert.deepEqual(order, ['gh_issue_close_if_current', 'gh_project_close'], 'the Epic is closed before the Project');
});
test('an already closed Project is reported closed without a write', async t => {
  const gh = recordedWorld(); gh.closedProjects.add(PROJECT.projectId); const h = await harness(t, gh);
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir)));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.deepEqual((out.r.data as CloseData).projectsClosed, [PROJECT.projectId]);
  assert.equal(gh.count('gh_project_close'), 0);
});
test('a Project with another Issue is skipped as foreign-items and the completion is applied', async t => {
  const gh = recordedWorld([PROJECT.projectId, PB]); gh.projects.set(PB, [10, 99]); const h = await harness(t, gh);
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir)));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  const d = out.r.data as CloseData;
  assert.deepEqual(d.projectsClosed, [PROJECT.projectId]); assert.deepEqual(d.projectsSkipped, [{projectId: PB, reason: 'foreign-items'}]);
  assert.ok(!gh.closedProjects.has(PB)); assert.equal(gh.count('gh_project_close'), 1);
});
test('an Epic without projectIds completes with a not-recorded skip and no Project call', async t => {
  const gh = world(); const h = await harness(t, gh);
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir)));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  const d = out.r.data as CloseData;
  assert.deepEqual(d.projectsClosed, []); assert.deepEqual(d.projectsSkipped, [{projectId: null, reason: 'not-recorded'}]);
  assert.equal(gh.calls.filter(c => c.name.startsWith('gh_project_')).length, 0);
});
test('a failed Project close blocks with pendingStep project-close and issueClosed true', async t => {
  const gh = recordedWorld();
  gh.overrides.set('gh_project_close', () => FakePiGh.err('rejected', 'GITHUB_WRITE'));
  const h = await harness(t, gh);
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir)));
  assert.equal(out.r.status, 'partial', JSON.stringify(out.r));
  const d = out.r.data as CloseData;
  assert.deepEqual([d.issueClosed, d.pendingStep], [true, 'project-close']);
  assert.deepEqual(d.projectsClosed, []);
  assert.ok(!gh.closedProjects.has(PROJECT.projectId));
});
test('a resume after a failed Project close closes only the remaining Projects without a second Issue close', async t => {
  const gh = recordedWorld([PROJECT.projectId, PB]);
  let fail = true;
  gh.overrides.set('gh_project_close', args => { const c = JSON.parse(readFileSync((args as {changePath: string}).changePath, 'utf8')) as {projectId: string}; return c.projectId === PB && fail ? (fail = false, FakePiGh.err('rejected', 'GITHUB_WRITE')) : undefined; });
  const h = await harness(t, gh);
  const input = params(gh, await writeEvidence(h.agentDir));
  const first = await h.invoke(input);
  assert.equal(first.r.status, 'partial', JSON.stringify(first.r));
  assert.deepEqual((first.r.data as CloseData).projectsClosed, [PROJECT.projectId]);
  assert.ok(gh.closedProjects.has(PROJECT.projectId)); assert.ok(!gh.closedProjects.has(PB));
  const resumed = await h.invoke(input);
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.equal(resumed.confirmCalls, 0);
  assert.equal(closes(gh), 1, 'the Issue is closed once');
  assert.ok(gh.closedProjects.has(PB));
  const projectCloses = gh.calls.filter(c => c.name === 'gh_project_close').map(c => (JSON.parse(readFileSync((c.args as {changePath: string}).changePath, 'utf8')) as {projectId: string}).projectId);
  assert.equal(projectCloses.filter(id => id === PROJECT.projectId).length, 1, 'a closed Project is not sent again');
  assert.deepEqual((resumed.r.data as CloseData).projectsClosed, [PROJECT.projectId, PB]);
  assert.equal((resumed.r.data as CloseData).pendingStep, null);
});
test('an item added after the acceptance makes the Project skipped, not closed', async t => {
  const gh = recordedWorld();
  const h = await harness(t, gh, {confirm: () => { gh.projects.get(PROJECT.projectId)!.push(99); return true; }});
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir)));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  const d = out.r.data as CloseData;
  assert.deepEqual(d.projectsClosed, []); assert.deepEqual(d.projectsSkipped, [{projectId: PROJECT.projectId, reason: 'foreign-items'}]);
  assert.equal(gh.count('gh_project_close'), 0);
});
test('a tree issue reopened after the acceptance blocks with PROJECT_ITEMS_OPEN', async t => {
  const gh = recordedWorld();
  const h = await harness(t, gh, {confirm: () => { gh.issues.get(11)!.state = 'open'; return true; }});
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir)));
  assert.equal(out.r.status, 'partial', JSON.stringify(out.r));
  assert.ok(out.r.problems.some(p => p.code === 'PROJECT_ITEMS_OPEN'), JSON.stringify(out.r.problems));
  assert.equal(gh.count('gh_project_close'), 0);
  assert.deepEqual([(out.r.data as CloseData).issueClosed, (out.r.data as CloseData).pendingStep], [true, 'project-close']);
});
test('a close reported applied but not visible is caught by the read-back', async t => {
  const gh = recordedWorld();
  gh.overrides.set('gh_project_close', () => FakePiGh.ok({projectId: PROJECT.projectId}, 'applied'));
  const h = await harness(t, gh);
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir)));
  assert.notEqual(out.r.status, 'applied');
  assert.ok(out.r.problems.some(p => p.code === 'PROJECT_NOT_CLOSED'), JSON.stringify(out.r.problems));
  assert.deepEqual([(out.r.data as CloseData).issueClosed, (out.r.data as CloseData).pendingStep], [true, 'project-close']);
});
test('the optional project Done step still runs before the Projects are closed', async t => {
  const gh = recordedWorld(); const h = await harness(t, gh);
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir), {project: PROJECT}));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  const d = out.r.data as CloseData;
  assert.equal(d.projectUpdated, true); assert.deepEqual(d.projectsClosed, [PROJECT.projectId]);
  const order = gh.calls.map(c => c.name).filter(n => /close_if_current|field_update|project_close/.test(n));
  assert.deepEqual(order, ['gh_issue_close_if_current', 'gh_project_field_update', 'gh_project_close']);
});

// ---- final review fixes: link check, report read-back, foreign-repo sub-issues ------------------------

test('a Project not linked to the repo is skipped as not-linked at the acceptance and the completion is applied', async t => {
  const gh = recordedWorld([PROJECT.projectId, PB]); gh.projectRepos.set(PB, ['other/repo']);
  const shown: string[] = [];
  const h = await harness(t, gh, {confirm: (_title, message) => { shown.push(message); return true; }});
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir)));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  const d = out.r.data as CloseData;
  assert.deepEqual(d.projectsClosed, [PROJECT.projectId]); assert.deepEqual(d.projectsSkipped, [{projectId: PB, reason: 'not-linked'}]); assert.equal(d.pendingStep, null);
  assert.match(shown[0]!, /閉じない: PVT_fixture2（repo に紐付いていない。手で閉じる）/);
  assert.ok(!gh.closedProjects.has(PB)); assert.equal(gh.count('gh_project_close'), 1);
});
test('a link removed after the acceptance makes the Project skipped as not-linked, not failed', async t => {
  const gh = recordedWorld();
  const h = await harness(t, gh, {confirm: () => { gh.projectRepos.set(PROJECT.projectId, []); return true; }});
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir)));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  const d = out.r.data as CloseData;
  assert.deepEqual(d.projectsClosed, []); assert.deepEqual(d.projectsSkipped, [{projectId: PROJECT.projectId, reason: 'not-linked'}]); assert.equal(d.pendingStep, null);
  assert.equal(gh.count('gh_project_close'), 0);
});
test('an already closed Project reopened after the acceptance is not reported closed', async t => {
  const gh = recordedWorld(); gh.closedProjects.add(PROJECT.projectId);
  const h = await harness(t, gh, {confirm: () => { gh.closedProjects.delete(PROJECT.projectId); return true; }});
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir)));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.deepEqual((out.r.data as CloseData).projectsClosed, []);
});
test('a partial result reports an already closed Project only when it still reads back closed', async t => {
  const gh = recordedWorld([PROJECT.projectId, PB]); gh.closedProjects.add(PROJECT.projectId);
  gh.overrides.set('gh_project_close', () => FakePiGh.err('rejected', 'GITHUB_WRITE'));
  const h = await harness(t, gh, {confirm: () => { gh.closedProjects.delete(PROJECT.projectId); return true; }});
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir)));
  assert.equal(out.r.status, 'partial', JSON.stringify(out.r));
  const d = out.r.data as CloseData;
  assert.deepEqual([d.issueClosed, d.pendingStep], [true, 'project-close']);
  assert.deepEqual(d.projectsClosed, []);
});
test('an open sub-issue in another repository does not block; a Project holding it is foreign-items', async t => {
  const gh = recordedWorld([PROJECT.projectId, PB]);
  gh.projectExtraItems.set(PB, [{id: 'PVTI_x5', content: {__typename: 'Issue', id: 'I_x5', number: 5, state: 'OPEN', repository: {nameWithOwner: 'other/repo'}}}]);
  gh.overrides.set('gh_subissues_list', args => (args as {issue: number}).issue === 11 ? FakePiGh.ok([{number: 5, title: 'X', body: '', state: 'open', labels: [], html_url: 'https://github.com/other/repo/issues/5'}]) : undefined);
  const h = await harness(t, gh);
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir)));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  const d = out.r.data as CloseData;
  assert.deepEqual(d.projectsClosed, [PROJECT.projectId]); assert.deepEqual(d.projectsSkipped, [{projectId: PB, reason: 'foreign-items'}]);
  assert.ok(!gh.closedProjects.has(PB));
});
