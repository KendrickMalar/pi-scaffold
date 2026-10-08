import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness, loadToolModule, type Scenario} from './helpers/harness.js';
import {FakePiGh} from './helpers/fake-pi-gh.js';
import {renderEpicBlock, renderEpicVisible} from '../src/core/epic-render.js';
import {parseIssueBody} from '../src/core/body-codec.js';
import {sha256Text, specBaseDigest, specificationDigest} from '../src/core/digests.js';
import {labelDefinitions} from '../src/core/label-definitions.js';
import {reduceSpecification} from '../src/core/specification.js';
import {planResearchBegin, RESEARCH_STOP_CONDITIONS} from '../src/core/research.js';
import type {EpicDocV1, ResearchClaim} from '../src/core/contracts.js';
import {populatedDoc} from './helpers/docs.js';

const OP = '66666666-6666-4666-8666-666666666666', OTHER_OP = '77777777-7777-4777-8777-777777777777';
const BEFORE = '外のメモ\n\n', AFTER = '\n\n末尾メモ\n';
/** Specification-stage Epic: R001 resolved, R002/R003/R004 pending. */
function specDoc(mutate: (d: EpicDocV1) => void = () => {}): EpicDocV1 {
  const d = populatedDoc();
  d.stage = 'specification'; d.revision = 3; d.design = null; d.dependencyPlan = null; d.wavePlan = null; d.handoff = null;
  d.research[2] = {...d.research[2]!, state: 'pending', claim: null};
  d.research.push({researchId: 'R004', question: '文字コードは何が必要か', requiredEvidence: '利用者へのヒアリング記録', doneCondition: '採用する文字コードが1つに決まる', state: 'pending', claim: null, conclusion: null, evidenceRefs: [], limitations: []});
  mutate(d);
  return d;
}
const claimOf = (d: EpicDocV1, researchId: string, operationId: string, sessionId = 'other-session'): ResearchClaim => ({researchId, operationId, sessionId, specBaseDigest: specBaseDigest(d)});
function world(doc = specDoc()) {
  const gh = new FakePiGh().seedLabels(labelDefinitions()).enableProposals();
  gh.add({number: 10, title: '一覧をCSVで保存できるようにする', body: BEFORE + renderEpicBlock(doc) + AFTER, labels: ['Type: Scaffold', 'Scope: Epic', 'Stage: Specification'], state: 'open'});
  return gh;
}
const docOf = (gh: FakePiGh) => (parseIssueBody(gh.issues.get(10)!.body) as {ok: true; value: {doc: EpicDocV1}}).value.doc;
const params = (gh: FakePiGh, extra: Record<string, unknown> = {}) => ({
  repo: 'example/demo', epicIssue: 10, operationId: OP, expectedRevision: docOf(gh).revision, expectedBodySha256: sha256Text(gh.issues.get(10)!.body), researchIds: ['R002'], ...extra,
});
async function harness(t: {after(fn: () => Promise<void>): void}, gh: FakePiGh, scenario: Scenario = {}) {
  const {createTool} = await loadToolModule('extensions/tools/research-begin.ts');
  const h = await createHarness(createTool, {scenario: {gh, defaultParams: scenario.defaultParams ?? params(gh), ...scenario}});
  t.after(h.dispose);
  return h;
}
type Brief = {researchId: string; question: string; requiredEvidence: string; doneCondition: string; stopConditions: string[]; background: string | null; purpose: string; epic: string; specBaseDigest: string};
type Data = {claims: ResearchClaim[]; briefs: Brief[]; skipped: string[]};
const edits = (gh: FakePiGh) => gh.count('gh_issue_edit_if_current');
/** Only pi-gh reads and the one conditional edit: no research run, model call or agent launch. */
const onlyGhCalls = (gh: FakePiGh) => assert.deepEqual([...new Set(gh.calls.map(c => c.name))].sort().filter(n => !['gh_capabilities', 'gh_issue_edit_if_current', 'gh_issue_get'].includes(n)), []);

// ---- input validation ---------------------------------------------------------------------------

for (const [label, ids, code] of [
  ['empty', [], 'EMPTY'], ['duplicate', ['R002', 'R002'], 'DUPLICATE_ID'], ['unknown', ['R999'], 'UNKNOWN_RESEARCH'], ['wrong kind', ['REQ001'], 'INVALID_FORMAT'],
] as const) {
  test(`researchIds ${label} is blocked with zero claims`, async t => {
    const gh = world();
    const out = await (await harness(t, gh)).invoke(params(gh, {researchIds: ids}));
    assert.equal(out.r.status, 'blocked');
    assert.ok(out.r.problems.some(p => p.code === code), JSON.stringify(out.r.problems));
    assert.equal(gh.writes, 0);
  });
}

for (const key of ['done', 'approved', 'force']) {
  test(`input ${key}=true is rejected with zero changes`, async t => {
    const gh = world();
    const out = await (await harness(t, gh)).invoke(params(gh, {[key]: true}));
    assert.equal(out.inputSchemaValid, false);
    assert.equal(out.r.status, 'blocked');
    assert.equal(gh.writes, 0);
  });
}

// ---- claiming ---------------------------------------------------------------------------------

test('a pending item becomes in_progress with a claim bound to the real operation, session, ID and baseline; the brief comes after read-back', async t => {
  const gh = world(), start = specDoc();
  const out = await (await harness(t, gh)).invoke(params(gh, {researchIds: ['R002', 'R004']}));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  const doc = docOf(gh), data = out.r.data as Data;
  for (const id of ['R002', 'R004']) {
    const item = doc.research.find(r => r.researchId === id)!;
    assert.equal(item.state, 'in_progress');
    assert.deepEqual(item.claim, {researchId: id, operationId: OP, sessionId: 'session-harness', specBaseDigest: specBaseDigest(start)});
  }
  assert.deepEqual(data.claims, doc.research.filter(r => ['R002', 'R004'].includes(r.researchId)).map(r => r.claim));
  assert.deepEqual(data.briefs.map(b => b.researchId), ['R002', 'R004']);
  const b = data.briefs[1]!, seed = start.research[3]!;
  assert.deepEqual([b.question, b.requiredEvidence, b.doneCondition], [seed.question, seed.requiredEvidence, seed.doneCondition]);
  assert.equal(b.background, start.background); assert.equal(b.purpose, start.purpose);
  assert.equal(b.epic, 'example/demo#10'); assert.equal(b.specBaseDigest, specBaseDigest(start));
  assert.deepEqual(b.stopConditions, [...RESEARCH_STOP_CONDITIONS]);
  assert.ok(gh.count('gh_issue_get') >= 2 && gh.calls.map(c => c.name).lastIndexOf('gh_issue_get') > gh.calls.findIndex(c => c.name === 'gh_issue_edit_if_current'), 'read back after the edit');
  assert.equal(edits(gh), 1);
  onlyGhCalls(gh); assert.equal(out.herdrCalls, 0);
});

test('Q/REQ/AC/D, other research and outside bytes are kept; specBaseDigest and specDigest do not change', async t => {
  const gh = world(), start = specDoc();
  await (await harness(t, gh)).invoke();
  const doc = docOf(gh), body = gh.issues.get(10)!.body;
  assert.ok(body.startsWith(BEFORE) && body.endsWith(AFTER));
  assert.deepEqual([doc.questions, doc.requirements, doc.criteria, doc.decisions], [start.questions, start.requirements, start.criteria, start.decisions]);
  assert.deepEqual(doc.research.filter(r => r.researchId !== 'R002'), start.research.filter(r => r.researchId !== 'R002'));
  assert.equal(specBaseDigest(doc), specBaseDigest(start));
  assert.equal(specificationDigest(doc), specificationDigest(start));
  assert.equal(doc.revision, start.revision + 1);
});

test('re-running the same claim returns the same brief with zero remote writes', async t => {
  const gh = world();
  const h = await harness(t, gh);
  const first = await h.invoke();
  const again = await h.invoke();
  assert.equal(again.r.status, 'noop'); assert.equal(again.ghWrites, 0);
  assert.deepEqual((again.r.data as Data).briefs, (first.r.data as Data).briefs);
  assert.deepEqual((again.r.data as Data).claims, (first.r.data as Data).claims);
});

test('a resolved item is skipped and never restarted', async t => {
  const gh = world();
  const out = await (await harness(t, gh)).invoke(params(gh, {researchIds: ['R001']}));
  assert.equal(out.r.status, 'noop', JSON.stringify(out.r));
  assert.deepEqual((out.r.data as Data).skipped, ['R001']);
  assert.deepEqual((out.r.data as Data).briefs, []);
  assert.equal(gh.writes, 0);
  assert.equal(docOf(gh).research[0]!.state, 'resolved');
});

test('resolved items are skipped while pending ones in the same call are claimed', async t => {
  const gh = world();
  const out = await (await harness(t, gh)).invoke(params(gh, {researchIds: ['R001', 'R003']}));
  assert.equal(out.r.status, 'applied');
  assert.deepEqual((out.r.data as Data).skipped, ['R001']);
  assert.deepEqual((out.r.data as Data).briefs.map(b => b.researchId), ['R003']);
});

test('an item claimed by another owner is not taken over, however old the claim is', async t => {
  const gh = world(specDoc(d => { d.research[1] = {...d.research[1]!, state: 'in_progress', claim: claimOf(d, 'R002', OTHER_OP)}; }));
  const before = gh.issues.get(10)!.body;
  const out = await (await harness(t, gh)).invoke(params(gh, {researchIds: ['R002', 'R004']}));
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(p => p.code === 'CLAIMED_BY_OTHER' && p.path === 'researchIds[0]'), JSON.stringify(out.r.problems));
  assert.equal(gh.writes, 0); assert.equal(gh.issues.get(10)!.body, before);
});

test('the same session under a different operationId is another owner', async t => {
  const gh = world(specDoc(d => { d.research[1] = {...d.research[1]!, state: 'in_progress', claim: claimOf(d, 'R002', OTHER_OP, 'session-harness')}; }));
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(p => p.code === 'CLAIMED_BY_OTHER'));
  assert.equal(gh.writes, 0);
});

test('a claim whose baseline differs from the current one is blocked, not re-taken', async t => {
  const gh = world(specDoc(d => { d.research[1] = {...d.research[1]!, state: 'in_progress', claim: {...claimOf(d, 'R002', OP), specBaseDigest: 'e'.repeat(64)}}; }));
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(p => p.code === 'STALE_CLAIM'), JSON.stringify(out.r.problems));
  assert.equal(gh.writes, 0);
});

test('after an AC change the old claim is rejected; resolving another item keeps it', () => {
  const start = specDoc();
  const claimed = planResearchBegin(start, ['R002', 'R004'], {operationId: OP, sessionId: 's1'});
  assert.ok(claimed.ok);
  const doc = claimed.value.nextDoc;
  // Another research item gets resolved (independent of R002): baseline and the R002 claim stay valid.
  const other = structuredClone(doc);
  other.research[3] = {...other.research[3]!, state: 'resolved', claim: null, conclusion: 'UTF-8', evidenceRefs: ['https://example.com/hearing'], limitations: []};
  assert.equal(specBaseDigest(other), specBaseDigest(doc));
  const still = planResearchBegin(other, ['R002'], {operationId: OP, sessionId: 's1', adoptOwnClaims: true});
  assert.ok(still.ok && still.value.claims[0]!.specBaseDigest === specBaseDigest(doc));
  // An AC change (through #6) resets the claim; the old claim cannot be used any more.
  const changed = reduceSpecification(doc, {facts: [], requirements: [], criteria: [{...doc.criteria[0]!, expectedResult: '変更後の期待結果'}], decisions: []});
  assert.ok(changed.ok);
  assert.equal(changed.value.nextDoc.research[1]!.claim, null);
});

test('after an AC change, re-running the old operation does not hand out the old brief', async t => {
  const gh = world();
  const h = await harness(t, gh);
  assert.equal((await h.invoke()).r.status, 'applied');
  // A specification change resets research (as #6 does) and is saved to the Issue.
  const changed = reduceSpecification(docOf(gh), {facts: [], requirements: [], criteria: [{...docOf(gh).criteria[0]!, expectedResult: '変更後'}], decisions: []});
  assert.ok(changed.ok);
  gh.issues.get(10)!.body = BEFORE + renderEpicBlock({...changed.value.nextDoc, revision: docOf(gh).revision + 1}) + AFTER;
  const again = await h.invoke();
  assert.equal(again.r.status, 'blocked', JSON.stringify(again.r));
  assert.ok(again.r.problems.some(p => p.code === 'CLAIM_LOST'), JSON.stringify(again.r.problems));
  assert.equal((again.r.data as Partial<Data> | undefined)?.briefs, undefined);
});

// ---- write safety -------------------------------------------------------------------------------

test('an unknown claim write hands out no brief and is reconciled on resume', async t => {
  const gh = world();
  const real = gh.execute;
  gh.overrides.set('gh_issue_edit_if_current', async args => { gh.overrides.delete('gh_issue_edit_if_current'); await real('gh_issue_edit_if_current', args); return {result: {content: [], structuredContent: {status: 'unknown'}}, isError: true}; });
  const h = await harness(t, gh);
  const first = await h.invoke();
  assert.equal(first.r.status, 'unknown');
  assert.equal((first.r.data as Partial<Data>).briefs, undefined, 'no brief while the claim is unconfirmed');
  const before = edits(gh);
  const resumed = await h.invoke();
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.equal(edits(gh), before, 'reconciled from the Issue, not resent');
  assert.equal((resumed.r.data as Data).briefs.length, 1);
});

test('a visible/JSON mismatch, a stale body or revision writes nothing', async t => {
  const gh = world(); const p = params(gh);
  gh.issues.get(10)!.body = gh.issues.get(10)!.body.replace(renderEpicVisible(specDoc()).split('\n')[0]!, '# 手で書き換えた見出し');
  const bad = await (await harness(t, gh, {defaultParams: p})).invoke({...p, expectedBodySha256: sha256Text(gh.issues.get(10)!.body)});
  assert.equal(bad.r.status, 'blocked'); assert.ok(bad.r.problems.some(x => x.code === 'DOC_PROJECTION_MISMATCH'));
  assert.equal(gh.writes, 0);
  for (const extra of [{expectedBodySha256: 'f'.repeat(64)}, {expectedRevision: 2}]) {
    const g = world();
    const out = await (await harness(t, g)).invoke(params(g, extra));
    assert.equal(out.r.status, 'blocked'); assert.equal(g.writes, 0);
    assert.ok(out.r.problems.some(x => x.code === ('expectedRevision' in extra ? 'STALE_REVISION' : 'STALE_BODY')), JSON.stringify(out.r.problems));
  }
});

for (const stage of ['setup', 'basic-design', 'implementation'] as const) {
  test(`stage ${stage} is blocked`, async t => {
    const gh = world(specDoc(d => { d.stage = stage; }));
    const out = await (await harness(t, gh)).invoke();
    assert.equal(out.r.status, 'blocked');
    assert.ok(out.r.problems.some(p => p.code === 'STAGE_MISMATCH'), JSON.stringify(out.r.problems));
    assert.equal(gh.writes, 0);
  });
}

// ---- review follow-ups --------------------------------------------------------------------------

test('a claim copied from the Issue (our operationId, but not sent by this journal) is not adopted', async t => {
  const gh = world(specDoc(d => { d.research[1] = {...d.research[1]!, state: 'in_progress', claim: claimOf(d, 'R002', OP)}; }));
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(p => p.code === 'CLAIMED_BY_OTHER'), JSON.stringify(out.r.problems));
  assert.equal((out.r.data as Partial<Data> | undefined)?.briefs, undefined);
});

test('a failed read-back after a successful claim write is resumable (partial + resumeToken), and the resume hands out the brief', async t => {
  const gh = world();
  const h = await harness(t, gh);
  let edited = false;
  gh.onCall = name => { if (name === 'gh_issue_edit_if_current') edited = true; };
  gh.overrides.set('gh_issue_get', () => edited ? (gh.overrides.delete('gh_issue_get'), FakePiGh.err('unknown', 'GITHUB_READ')) : undefined);
  const first = await h.invoke();
  assert.equal(first.r.status, 'partial', JSON.stringify(first.r));
  assert.equal(first.r.resumeToken, OP);
  assert.equal((first.r.data as Partial<Data> | undefined)?.briefs, undefined);
  const again = await h.invoke();
  assert.equal(again.r.status, 'noop', JSON.stringify(again.r));
  assert.equal((again.r.data as Data).briefs.length, 1);
  assert.equal(edits(gh), 1);
});

test('re-running a completed operation re-checks stage and open state before handing out briefs', async t => {
  for (const change of [(d: EpicDocV1) => { d.stage = 'basic-design'; }, null] as const) {
    const gh = world();
    const h = await harness(t, gh);
    assert.equal((await h.invoke()).r.status, 'applied');
    if (change) { const d = docOf(gh); change(d); gh.issues.get(10)!.body = BEFORE + renderEpicBlock(d) + AFTER; }
    else gh.issues.get(10)!.state = 'closed';
    const again = await h.invoke();
    assert.equal(again.r.status, 'blocked', JSON.stringify(again.r));
    assert.ok(again.r.problems.some(p => p.code === (change ? 'STAGE_MISMATCH' : 'ISSUE_CLOSED')), JSON.stringify(again.r.problems));
    assert.equal((again.r.data as Partial<Data> | undefined)?.briefs, undefined);
  }
});

test('a write that failed before reaching GitHub is retried only after all checks pass again', async t => {
  const gh = world();
  let fail = true;
  gh.overrides.set('gh_issue_edit_if_current', () => fail ? (fail = false, FakePiGh.err('rejected', 'PRECONDITION_FAILED')) : undefined);
  const h = await harness(t, gh);
  assert.equal((await h.invoke()).r.status, 'blocked');
  gh.issues.get(10)!.body += '\n手で足したメモ';
  const stale = await h.invoke();
  assert.equal(stale.r.status, 'blocked');
  assert.ok(stale.r.problems.some(x => x.code === 'STALE_BODY'), JSON.stringify(stale.r.problems));
  assert.equal(edits(gh), 1);
});

test('an uncertain write that did not land is resent once after reconciling', async t => {
  const gh = world();
  let lose = true;
  gh.overrides.set('gh_issue_edit_if_current', () => lose ? (lose = false, {result: {content: [], structuredContent: {status: 'unknown'}}, isError: true}) : undefined);
  const h = await harness(t, gh);
  assert.equal((await h.invoke()).r.status, 'unknown');
  const resumed = await h.invoke();
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.equal(edits(gh), 2);
  assert.equal((resumed.r.data as Data).briefs.length, 1);
});
