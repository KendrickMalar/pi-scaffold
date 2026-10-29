import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness, loadToolModule} from './helpers/harness.js';
import {FakePiGh} from './helpers/fake-pi-gh.js';
import {renderEpicBlock, renderFeatureBlock} from '../src/core/epic-render.js';
import {populatedDoc, featureDoc} from './helpers/docs.js';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {setActiveWorktree} from '../src/core/active-worktree.js';
import {gitRepoWithWorktree} from './helpers/git-worktree.js';

// Plan mode keeps only the gh reads.
const READ = ['gh_capabilities', 'gh_issue_get'];
const WRITE = ['scaffold_feature_create', 'scaffold_dependencies_apply', 'scaffold_waves_apply', 'scaffold_handoff_implementation'];

async function run(tools: string[], opts: {activeTools?: string[]; pin?: boolean; feature?: boolean; pinRef?: string; cwd?: string} = {}) {
  const d = populatedDoc(); d.stage = 'basic-design';
  if (opts.pin) d.originalRequest.sourceRefs = [opts.pinRef ?? `docs/missing.md@sha256:${'a'.repeat(64)}`];
  const gh = new FakePiGh(); gh.add({number: 10, title: 'Epic', body: renderEpicBlock(d), labels: ['Type: Scaffold', 'Scope: Epic', 'Stage: BasicDesign'], state: 'open'});
  if (opts.feature) gh.add({number: 10, title: 'Feature', body: renderFeatureBlock(featureDoc()), labels: ['Type: Scaffold', 'Scope: Feature'], state: 'open'});
  const {createTool} = await loadToolModule('extensions/tools/stage-check.ts');
  const h = await createHarness(createTool, {scenario: {gh, tools, ...(opts.activeTools ? {activeTools: opts.activeTools} : {}), ...(opts.cwd ? {cwd: opts.cwd} : {})}});
  return (await h.invoke({repo: 'example/demo', epicIssue: 10})).r;
}

test('passes with read tools present even when plan mode removed write tools', async () => {
  const r = await run(READ);
  assert.equal(r.status, 'validated');
  assert.deepEqual((r.data as {missingStageTools: string[]}).missingStageTools, WRITE);
});

test('fails naming the missing read tool (the gh_issue_get-under-plan-mode case)', async () => {
  const r = await run(READ.filter(t => t !== 'gh_issue_get'));
  assert.equal(r.status, 'blocked');
  assert.deepEqual((r.data as {missingReadTools: string[]}).missingReadTools, ['gh_issue_get']);
});

test('runtime.activeToolNames (production path) wins over ctx.tools', async () => {
  const r = await run([...READ, ...WRITE], {activeTools: READ.filter(t => t !== 'gh_issue_get')});
  assert.equal(r.status, 'blocked');
  assert.deepEqual((r.data as {missingReadTools: string[]}).missingReadTools, ['gh_issue_get']);
});

test('a pinned doc missing in cwd blocks and names the path', async () => {
  const r = await run(READ, {pin: true});
  const data = r.data as {passed: boolean; docProblems: {path: string}[]};
  assert.equal(r.status, 'blocked');
  assert.equal(data.passed, false);
  assert.ok(data.docProblems.some(p => p.path.includes('docs/missing.md')), JSON.stringify(data.docProblems));
});

test('a non-Epic issue is blocked as NOT_AN_EPIC', async () => {
  const r = await run(READ, {feature: true});
  assert.equal(r.status, 'blocked');
  assert.ok(r.problems.some(p => p.code === 'NOT_AN_EPIC'), JSON.stringify(r.problems));
});

test('after worktree_switch, a pinned doc that exists only in the active linked worktree passes', async t => {
  const {repo} = await gitRepoWithWorktree(t);
  await mkdir(join(repo.linked, 'docs/spec'), {recursive: true});
  await writeFile(join(repo.linked, 'docs/spec/spec.md'), 'spec');
  const pinRef = `docs/spec/spec.md@sha256:${createHash('sha256').update('spec').digest('hex')}`;
  t.after(() => setActiveWorktree(null));
  setActiveWorktree(null);
  assert.equal((await run(READ, {pin: true, pinRef, cwd: repo.main})).status, 'blocked', 'without the announcement it checks the main worktree');
  setActiveWorktree({path: repo.linked, mainRoot: repo.main});
  const r = await run(READ, {pin: true, pinRef, cwd: repo.main});
  assert.equal(r.status, 'validated', JSON.stringify(r.problems));
});

// ---- specificationReady and waiting (read by scaffold-orchestrator) --------------------------------------------

type WaitData = {passed: boolean; specificationReady: boolean | null; waiting: {planPending: boolean; openBlockers: number[]}};
function specDoc(ready: boolean) {
  const d = populatedDoc();
  d.stage = 'specification'; d.design = null; d.dependencyPlan = null; d.wavePlan = null; d.handoff = null;
  d.questions = d.questions.map(q => ({...q, answer: q.answer ?? '回答済み（架空）', sourceRef: q.sourceRef ?? 'hearing-1'}));
  d.research = d.research.map(r => ({...r, state: 'resolved' as const, claim: null, conclusion: r.conclusion ?? '結論（架空）', evidenceRefs: r.evidenceRefs.length ? r.evidenceRefs : ['https://example.com/evidence'], limitations: r.limitations}));
  d.constraints = d.constraints ?? []; d.outOfScope = [];
  if (!ready) d.criteria = [];
  return d;
}
async function check(doc: ReturnType<typeof populatedDoc>, opts: {labels?: string[]; blockedBy?: number[]; extra?: (gh: FakePiGh) => void} = {}) {
  const gh = new FakePiGh();
  gh.add({number: 10, title: 'Epic', body: renderEpicBlock(doc), labels: opts.labels ?? ['Type: Scaffold', 'Scope: Epic', 'Stage: Specification'], state: 'open', blockedBy: opts.blockedBy ?? []});
  opts.extra?.(gh);
  const {createTool} = await loadToolModule('extensions/tools/stage-check.ts');
  const h = await createHarness(createTool, {scenario: {gh, tools: READ}});
  const r = (await h.invoke({repo: 'example/demo', epicIssue: 10})).r;
  return {r, data: r.data as WaitData, gh};
}

test('stage check reports specificationReady true for a complete specification Epic and false for a draft', async () => {
  const ready = await check(specDoc(true));
  assert.equal(ready.data.specificationReady, true, JSON.stringify(ready.r));
  const draft = await check(specDoc(false));
  assert.equal(draft.data.specificationReady, false, JSON.stringify(draft.r));
  assert.equal(draft.r.status, 'validated', 'an incomplete specification does not fail the check');
});

test('stage check reports null specificationReady outside the specification stage', async () => {
  const d = populatedDoc(); d.stage = 'basic-design';
  const {data} = await check(d, {labels: ['Type: Scaffold', 'Scope: Epic', 'Stage: BasicDesign']});
  assert.equal(data.specificationReady, null);
  assert.deepEqual(data.waiting, {planPending: false, openBlockers: []});
});

test('stage check reports planPending and open Epic blockers', async () => {
  const {r, data} = await check(specDoc(true), {
    labels: ['Type: Scaffold', 'Scope: Epic', 'Stage: Specification', 'scaffold:plan-pending'], blockedBy: [21, 20, 22, 23],
    extra: gh => {
      gh.add({number: 20, title: 'E', body: '', labels: ['Type: Scaffold', 'Scope: Epic'], state: 'open'});
      gh.add({number: 21, title: 'E', body: '', labels: ['Type: Scaffold', 'Scope: Epic'], state: 'open'});
      gh.add({number: 22, title: 'E', body: '', labels: ['Type: Scaffold', 'Scope: Epic'], state: 'closed'});
      gh.add({number: 23, title: 'F', body: '', labels: ['Type: Scaffold', 'Scope: Feature'], state: 'open'});
    },
  });
  assert.equal(r.status, 'validated', JSON.stringify(r.problems));
  assert.deepEqual(data.waiting, {planPending: true, openBlockers: [20, 21]});
});

test('an unreadable dependency list is reported in problems and does not change passed', async () => {
  const {r, data} = await check(specDoc(true), {
    labels: ['Type: Scaffold', 'Scope: Epic', 'Stage: Specification', 'scaffold:plan-pending'],
    extra: gh => { gh.overrides.set('gh_dependencies_list', () => FakePiGh.err('rejected', 'GITHUB_READ')); },
  });
  assert.equal(data.passed, true);
  assert.equal(r.status, 'validated');
  assert.ok(r.problems.some(p => p.code === 'DEPENDENCIES_UNREADABLE'), JSON.stringify(r.problems));
  assert.deepEqual(data.waiting, {planPending: true, openBlockers: []});
});
