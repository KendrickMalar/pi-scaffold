import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHarness, loadToolModule, type Scenario} from './helpers/harness.js';
import {FakePiGh} from './helpers/fake-pi-gh.js';
import {renderEpicBlock, renderEpicVisible} from '../src/core/epic-render.js';
import {parseIssueBody} from '../src/core/body-codec.js';
import {sha256Text, specBaseDigest, specificationDigest} from '../src/core/digests.js';
import {labelDefinitions} from '../src/core/label-definitions.js';
import {reduceSpecification, specificationMissingFields} from '../src/core/specification.js';
import {ApprovalStore} from '../src/core/approvals.js';
import type {EpicDocV1, RepoContext} from '../src/core/contracts.js';
import {makeScope} from './helpers/scope.js';
import {OPERATION_ID, SHA_A, SHA_B, populatedDoc} from './helpers/docs.js';

const BEFORE = 'メモ（管理外・先頭）\r\n\r\n', AFTER = '\n\n末尾のメモ 🙂\n';
/** A specification-stage Epic: two REQ/AC, one D, resolved R001 and a claimed R003. */
function specDoc(mutate: (d: EpicDocV1) => void = () => {}): EpicDocV1 {
  const d = populatedDoc();
  d.stage = 'specification'; d.revision = 3; d.design = null; d.dependencyPlan = null; d.wavePlan = null; d.handoff = null;
  mutate(d);
  return d;
}
function world(doc = specDoc(), wrap = true) {
  const gh = new FakePiGh().seedLabels(labelDefinitions()).enableProposals();
  gh.add({number: 10, title: '一覧をCSVで保存できるようにする', body: wrap ? BEFORE + renderEpicBlock(doc) + AFTER : renderEpicBlock(doc), labels: ['Type: Scaffold', 'Scope: Epic', 'Stage: Specification'], state: 'open'});
  return gh;
}
const docOf = (gh: FakePiGh) => (parseIssueBody(gh.issues.get(10)!.body) as {ok: true; value: {doc: EpicDocV1}}).value.doc;
const params = (gh: FakePiGh, extra: Record<string, unknown> = {}) => ({
  repo: 'example/demo', epicIssue: 10, operationId: OPERATION_ID, expectedRevision: docOf(gh).revision,
  expectedBodySha256: sha256Text(gh.issues.get(10)!.body),
  facts: [], requirements: [], criteria: [], constraints: docOf(gh).constraints, outOfScope: docOf(gh).outOfScope, decisions: [], ...extra,
});
async function harness(t: {after(fn: () => Promise<void>): void}, gh: FakePiGh, scenario: Scenario = {}) {
  const {createTool} = await loadToolModule('extensions/tools/specification-update.ts');
  const h = await createHarness(createTool, {scenario: {gh, defaultParams: scenario.defaultParams ?? params(gh), ...scenario}});
  t.after(h.dispose);
  return h;
}
const edits = (gh: FakePiGh) => gh.count('gh_issue_edit_if_current');
type Data = {revision: number; specDigest: string; missingFields: string[]};
const req = (id: string, description: string) => ({id, description});
const ac = (id: string, requirementIds: string[], verification = '手動で確認', expectedResult = '期待どおり') => ({id, requirementIds, verification, expectedResult});
const q = (questionId: string, answer: string | null, sourceRef: string | null, extra: Record<string, unknown> = {}) => ({questionId, kind: 'question', question: '対象は？', answer, required: true, sourceRef, ...extra});

// ---- input validation: every case is blocked before any write -------------------------------

for (const [label, value] of [['empty', ''], ['blank', '   '], ['missing', undefined], ['number', 42]] as const) {
  test(`requirements[0].description ${label} is blocked with zero writes`, async t => {
    const gh = world();
    const r0: Record<string, unknown> = {id: 'REQ003'}; if (value !== undefined) r0.description = value;
    const out = await (await harness(t, gh)).invoke(params(gh, {requirements: [r0]}));
    assert.equal(out.r.status, 'blocked');
    assert.ok(out.r.problems.some(p => p.path === 'requirements[0].description'), JSON.stringify(out.r.problems));
    assert.equal(gh.writes, 0);
  });
}

const criterionCases: [string, Record<string, unknown>, string][] = [
  ['verification missing', {id: 'AC003', requirementIds: ['REQ001'], expectedResult: 'x'}, 'criteria[0].verification'],
  ['verification blank', {...ac('AC003', ['REQ001']), verification: '  '}, 'criteria[0].verification'],
  ['expectedResult missing', {id: 'AC003', requirementIds: ['REQ001'], verification: 'x'}, 'criteria[0].expectedResult'],
  ['expectedResult blank', {...ac('AC003', ['REQ001']), expectedResult: '\t'}, 'criteria[0].expectedResult'],
  ['requirementIds empty', ac('AC003', []), 'criteria[0].requirementIds'],
  ['requirementIds unknown REQ', ac('AC003', ['REQ999']), 'criteria[0].requirementIds[0]'],
  ['requirementIds duplicate', ac('AC003', ['REQ001', 'REQ001']), 'criteria[0].requirementIds[1]'],
];
for (const [label, c, path] of criterionCases) {
  test(`criterion ${label} is blocked at ${path}`, async t => {
    const gh = world();
    const out = await (await harness(t, gh)).invoke(params(gh, {criteria: [c]}));
    assert.equal(out.r.status, 'blocked');
    assert.ok(out.r.problems.some(p => p.path === path), JSON.stringify(out.r.problems));
    assert.equal(gh.writes, 0);
  });
}

for (const [label, sourceRef] of [['null', null], ['blank', '   ']] as const) {
  test(`an answer with sourceRef ${label} is blocked`, async t => {
    const gh = world();
    const out = await (await harness(t, gh)).invoke(params(gh, {facts: [q('Q003', '全件', sourceRef)]}));
    assert.equal(out.r.status, 'blocked');
    assert.ok(out.r.problems.some(p => p.path === 'facts[0].sourceRef'), JSON.stringify(out.r.problems));
    assert.equal(gh.writes, 0);
  });
}

test('the same ID given twice with different content is blocked; identical repeats are allowed', async t => {
  const gh = world();
  const h = await harness(t, gh);
  const bad = await h.invoke(params(gh, {requirements: [req('REQ003', 'A'), req('REQ003', 'B')]}));
  assert.equal(bad.r.status, 'blocked');
  assert.ok(bad.r.problems.some(p => p.code === 'DUPLICATE_ID' && p.path === 'requirements[1].id'), JSON.stringify(bad.r.problems));
  assert.equal(gh.writes, 0);
  const same = await h.invoke(params(gh, {operationId: '44444444-4444-4444-8444-444444444444', requirements: [req('REQ003', 'A'), req('REQ003', 'A')]}));
  assert.equal(same.r.status, 'applied', JSON.stringify(same.r.problems));
  assert.equal(docOf(gh).requirements.filter(r => r.id === 'REQ003').length, 1);
});

for (const key of ['approved', 'force', 'command']) {
  test(`input ${key} is rejected by schema and service`, async t => {
    const gh = world();
    const out = await (await harness(t, gh)).invoke(params(gh, {[key]: true}));
    assert.equal(out.inputSchemaValid, false);
    assert.equal(out.r.status, 'blocked');
    assert.equal(gh.writes, 0);
  });
}

for (const stage of ['basic-design', 'implementation', 'verification', 'completed'] as const) {
  test(`stage ${stage} stops with NEEDS_REVISION and never rewrites the specification`, async t => {
    const gh = world(specDoc(d => { d.stage = stage; }));
    const out = await (await harness(t, gh)).invoke(params(gh, {requirements: [req('REQ003', '新しい要件')]}));
    assert.equal(out.r.status, 'blocked');
    assert.ok(out.r.problems.some(p => p.code === 'NEEDS_REVISION'), JSON.stringify(out.r.problems));
    assert.equal(gh.writes, 0);
  });
}

test('a setup-stage Epic is blocked (the specification session has not started)', async t => {
  const gh = world(specDoc(d => { d.stage = 'setup'; }));
  const out = await (await harness(t, gh)).invoke(params(gh, {requirements: [req('REQ003', 'x')]}));
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(p => p.code === 'STAGE_MISMATCH'), JSON.stringify(out.r.problems));
  assert.equal(gh.writes, 0);
});

test('a stale revision, a stale body hash or a visible/JSON mismatch writes nothing, outside notes included', async t => {
  for (const make of [
    (gh: FakePiGh) => params(gh, {expectedRevision: 2, requirements: [req('REQ003', 'x')]}),
    (gh: FakePiGh) => params(gh, {expectedBodySha256: 'f'.repeat(64), requirements: [req('REQ003', 'x')]}),
  ]) {
    const gh = world(); const before = gh.issues.get(10)!.body;
    const out = await (await harness(t, gh)).invoke(make(gh));
    assert.equal(out.r.status, 'blocked', JSON.stringify(out.r));
    assert.equal(gh.writes, 0); assert.equal(gh.issues.get(10)!.body, before);
  }
  const gh = world();
  const p = params(gh, {requirements: [req('REQ003', 'x')]});
  gh.issues.get(10)!.body = gh.issues.get(10)!.body.replace('末尾のメモ', '新しい末尾メモ').replace(renderEpicVisible(specDoc()).split('\n')[0]!, '# 手で書き換えた見出し');
  const before = gh.issues.get(10)!.body;
  const out = await (await harness(t, gh, {defaultParams: p})).invoke({...p, expectedBodySha256: sha256Text(before)});
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(p => p.code === 'DOC_PROJECTION_MISMATCH'), JSON.stringify(out.r.problems));
  assert.equal(gh.writes, 0); assert.equal(gh.issues.get(10)!.body, before);
});

test('a closed Epic is blocked', async t => {
  const gh = world(); gh.issues.get(10)!.state = 'closed';
  const out = await (await harness(t, gh)).invoke(params(gh, {requirements: [req('REQ003', 'x')]}));
  assert.equal(out.r.status, 'blocked');
  assert.equal(gh.writes, 0);
});

// ---- saving incomplete specifications -------------------------------------------------------

test('unanswered questions stay null and REQ without AC is reported as missing, never as complete', async t => {
  const gh = world(specDoc(d => { d.background = null; d.outOfScope = null; }));
  const out = await (await harness(t, gh)).invoke(params(gh, {
    facts: [q('Q003', null, null), q('Q004', null, null, {kind: 'conflict', question: 'AとBが食い違う', required: false})],
    requirements: [req('REQ003', '件数を表示する')],
  }));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  const doc = docOf(gh);
  assert.equal(doc.questions.find(x => x.questionId === 'Q003')!.answer, null);
  assert.equal(doc.questions.find(x => x.questionId === 'Q003')!.sourceRef, null);
  const data = out.r.data as Data;
  assert.deepEqual(data.missingFields.sort(), ['background', 'criteria.REQ003', 'outOfScope', 'questions.Q002.answer', 'questions.Q003.answer', 'questions.Q004.answer'].sort());
  assert.equal(data.revision, 4);
  assert.equal(data.specDigest, specificationDigest(doc));
  assert.ok(!('complete' in data) && !('completed' in data));
});

test('missingFields covers an empty requirement list and null constraints', () => {
  const doc = specDoc(d => { d.requirements = []; d.criteria = []; d.constraints = null; d.questions = []; });
  assert.deepEqual(specificationMissingFields(doc).sort(), ['constraints', 'requirements']);
});

test('[] for constraints/outOfScope means "confirmed none" and is not missing', () => {
  const doc = specDoc(d => { d.constraints = []; d.outOfScope = []; });
  const missing = specificationMissingFields(doc);
  assert.ok(!missing.includes('constraints') && !missing.includes('outOfScope'));
});

// ---- baseline changes ---------------------------------------------------------------------

test('changing a requirement bumps revision once, keeps IDs and outside bytes, resets research and keeps history', async t => {
  const start = specDoc(d => { d.research[2] = {...d.research[2]!, state: 'in_progress', claim: {researchId: 'R003', operationId: '55555555-5555-4555-8555-555555555555', sessionId: 'other-session', specBaseDigest: specBaseDigest(d)}}; });
  const gh = world(start);
  const h = await harness(t, gh);
  const out = await h.invoke(params(gh, {requirements: [req('REQ002', '出力は UTF-8 (BOM付き) にする')]}));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  const body = gh.issues.get(10)!.body, doc = docOf(gh);
  assert.ok(body.startsWith(BEFORE) && body.endsWith(AFTER), 'outside bytes are preserved exactly');
  assert.equal(doc.revision, start.revision + 1);
  assert.deepEqual(doc.requirements.map(r => r.id), ['REQ001', 'REQ002']);
  assert.deepEqual(doc.criteria.map(c => c.id), start.criteria.map(c => c.id));
  assert.equal(doc.requirements[1]!.description, '出力は UTF-8 (BOM付き) にする');
  assert.notEqual(specBaseDigest(doc), specBaseDigest(start));
  assert.ok(doc.research.every(r => r.state === 'pending' && r.claim === null && r.conclusion === null && !r.evidenceRefs.length && !r.limitations.length), JSON.stringify(doc.research));
  assert.deepEqual(doc.research.map(r => r.researchId), start.research.map(r => r.researchId), 'research questions are kept, only progress resets');
  const dir = join(h.agentDir, 'pi-scaffold');
  const files = await findFiles(dir, f => f.includes('research-history'));
  assert.equal(files.length, 1, files.join(','));
  const history = JSON.parse(await readFile(files[0]!, 'utf8'));
  assert.equal(history.specBaseDigest, specBaseDigest(start));
  assert.deepEqual(history.research, start.research);
  assert.equal(edits(gh), 1);
});

test('changing only decisions changes specDigest but keeps the research baseline and claims', async t => {
  const start = specDoc(d => { d.research[2] = {...d.research[2]!, state: 'in_progress', claim: {researchId: 'R003', operationId: '55555555-5555-4555-8555-555555555555', sessionId: 'other-session', specBaseDigest: specBaseDigest(d)}}; });
  const gh = world(start);
  const h = await harness(t, gh);
  const out = await h.invoke(params(gh, {decisions: [{id: 'D002', topic: '文字コード', decision: 'UTF-8', reason: '利用者の要望', sourceRefs: ['hearing-2']}]}));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  const doc = docOf(gh);
  assert.equal(specBaseDigest(doc), specBaseDigest(start));
  assert.notEqual(specificationDigest(doc), specificationDigest(start));
  assert.deepEqual(doc.research, start.research);
  assert.deepEqual(await findFiles(join(h.agentDir, 'pi-scaffold'), f => f.includes('research-history')), []);
});

test('an AC may reference a REQ added in the same patch; existing records not in the patch are untouched', async t => {
  const gh = world();
  const out = await (await harness(t, gh)).invoke(params(gh, {requirements: [req('REQ003', '件数を表示')], criteria: [ac('AC003', ['REQ003'])]}));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  const doc = docOf(gh), start = specDoc();
  assert.deepEqual(doc.requirements.slice(0, 2), start.requirements);
  assert.deepEqual(doc.criteria.map(c => c.id), ['AC001', 'AC002', 'AC003']);
  assert.ok(!(out.r.data as Data).missingFields.includes('criteria.REQ003'));
});

test('originalRequest and background change only when given; constraints [] is saved as confirmed none', async t => {
  const gh = world();
  const out = await (await harness(t, gh)).invoke(params(gh, {background: '月次で集計に使う', constraints: []}));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  const doc = docOf(gh);
  assert.equal(doc.background, '月次で集計に使う');
  assert.deepEqual(doc.constraints, []);
  assert.deepEqual(doc.originalRequest, specDoc().originalRequest);
});

test('omitting constraints/outOfScope keeps them; nothing is erased implicitly', async t => {
  const gh = world(specDoc(d => { d.constraints = ['社内のみ']; d.outOfScope = ['PDF出力']; }));
  const p: Record<string, unknown> = params(gh, {requirements: [req('REQ003', 'x')]});
  delete p.constraints; delete p.outOfScope;
  const out = await (await harness(t, gh)).invoke(p);
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.deepEqual([docOf(gh).constraints, docOf(gh).outOfScope], [['社内のみ'], ['PDF出力']]);
});

test('constraints null given explicitly is reflected (null = not set)', async t => {
  const gh = world(specDoc(d => { d.constraints = ['社内のみ']; }));
  const out = await (await harness(t, gh)).invoke(params(gh, {constraints: null}));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.equal(docOf(gh).constraints, null);
  assert.ok((out.r.data as Data).missingFields.includes('constraints'));
});

test('an approval recorded for the old specification is not found after a change', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-scaffold-spec-approval-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const root = join(dir, 'pi-scaffold'), start = specDoc();
  const context: RepoContext = {repo: 'example/demo', repoRoot: '/synthetic/repo', gitCommonDir: '/synthetic/repo/.git', workflowStateRoot: join(root, 'state', 'r', start.workflowId), accountBinding: SHA_A, profileId: 'developer', profileInstructionsDigest: SHA_B};
  const store = new ApprovalStore(root);
  const old = await store.confirmContent('specification', start.workflowId, {contentDigest: specificationDigest(start), text: '仕様（架空）'}, context, {interactive: true, confirm: async () => true}, makeScope());
  assert.equal(old.status, 'validated');
  for (const patch of [{decisions: [{id: 'D002', topic: 't', decision: 'd', reason: 'r', sourceRefs: []}]}, {requirements: [req('REQ001', '変更後')]}]) {
    const r = reduceSpecification(start, {facts: [], requirements: [], criteria: [], decisions: [], ...patch});
    assert.ok(r.ok);
    const {approvalViewDigest} = await import('../src/core/approvals.js');
    const lookup = await store.requireContentApproval('specification', start.workflowId, approvalViewDigest('specification', {contentDigest: r.value.specDigest, text: '仕様（架空）'}), context);
    assert.equal(lookup.ok, false);
    assert.ok(!lookup.ok && lookup.problems.some(p => p.code === 'APPROVAL_MISSING'));
  }
});

test('a write that failed before reaching GitHub is retried only after all checks pass again', async t => {
  const gh = world();
  let fail = true;
  gh.overrides.set('gh_issue_edit_if_current', () => fail ? (fail = false, FakePiGh.err('rejected', 'PRECONDITION_FAILED')) : undefined);
  const h = await harness(t, gh);
  const p = params(gh, {requirements: [req('REQ003', 'x')]});
  assert.equal((await h.invoke(p)).r.status, 'blocked');
  gh.issues.get(10)!.body += '\n手で足したメモ';
  const stale = await h.invoke(p);
  assert.equal(stale.r.status, 'blocked');
  assert.ok(stale.r.problems.some(x => x.code === 'STALE_BODY'), JSON.stringify(stale.r.problems));
  assert.equal(edits(gh), 1, 'the stale retry never sent a second edit');
});

// ---- idempotency and resume -------------------------------------------------------------------

test('no change at all is a noop without writes', async t => {
  const gh = world();
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'noop', JSON.stringify(out.r));
  assert.equal(gh.writes, 0);
});

test('re-running the same operationId returns noop; another payload under it is blocked', async t => {
  const gh = world();
  const h = await harness(t, gh);
  const p = params(gh, {requirements: [req('REQ003', 'x')]});
  assert.equal((await h.invoke(p)).r.status, 'applied');
  const again = await h.invoke(p);
  assert.equal(again.r.status, 'noop'); assert.equal(again.ghWrites, 0);
  const other = await h.invoke({...p, requirements: [req('REQ003', 'y')]});
  assert.equal(other.r.status, 'blocked'); assert.equal(other.ghWrites, 0);
});

test('an uncertain write is reconciled from the Issue and never resent blindly', async t => {
  const gh = world();
  let lose = true;
  gh.overrides.set('gh_issue_edit_if_current', () => lose ? (lose = false, {result: {content: [], structuredContent: {status: 'unknown'}}, isError: true}) : undefined);
  const h = await harness(t, gh);
  const p = params(gh, {requirements: [req('REQ003', 'x')]});
  const first = await h.invoke(p);
  assert.equal(first.r.status, 'unknown'); assert.equal(first.r.resumeToken, OPERATION_ID);
  const resumed = await h.invoke(p);
  assert.equal(resumed.r.status, 'applied', 'not applied remotely → resent once after reconciling: ' + JSON.stringify(resumed.r.problems));
  assert.equal(edits(gh), 2);
  assert.equal(docOf(gh).revision, 4);
});

test('a write that landed but was not confirmed is recognised on resume without a second edit', async t => {
  const gh = world();
  const h = await harness(t, gh);
  const p = params(gh, {requirements: [req('REQ003', 'x')]});
  // Apply for real once, then make the confirmation look lost.
  const real = gh.execute;
  gh.overrides.set('gh_issue_edit_if_current', async (args) => { gh.overrides.delete('gh_issue_edit_if_current'); await real('gh_issue_edit_if_current', args); return {result: {content: [], structuredContent: {status: 'unknown'}}, isError: true}; });
  assert.equal((await h.invoke(p)).r.status, 'unknown');
  const before = edits(gh);
  const resumed = await h.invoke(p);
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.equal(edits(gh), before, 'no second edit');
  assert.equal(docOf(gh).revision, 4);
});

test('reduceSpecification is pure and reports changed IDs', () => {
  const doc = specDoc();
  const snapshot = JSON.stringify(doc);
  const r = reduceSpecification(doc, {facts: [], requirements: [req('REQ001', '変更'), req('REQ003', '追加')], criteria: [], constraints: doc.constraints, outOfScope: doc.outOfScope, decisions: []});
  assert.ok(r.ok, JSON.stringify(!r.ok && r.problems));
  assert.equal(JSON.stringify(doc), snapshot);
  assert.deepEqual(r.value.changedIds.sort(), ['REQ001', 'REQ003']);
  assert.equal(r.value.specDigest, specificationDigest(r.value.nextDoc));
});

async function findFiles(dir: string, match: (f: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, {withFileTypes: true, recursive: true})) {
    const f = join(e.parentPath, e.name);
    if (e.isFile() && match(f)) out.push(f);
  }
  return out;
}
