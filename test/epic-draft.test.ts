import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHarness, loadToolModule, type Scenario} from './helpers/harness.js';
import {FakePiGh} from './helpers/fake-pi-gh.js';
import {renderEpicVisible} from '../src/core/epic-render.js';
import {parseIssueBody} from '../src/core/body-codec.js';
import {labelDefinitions} from '../src/core/label-definitions.js';
import type {EpicDocV1} from '../src/core/contracts.js';
import {OPERATION_ID, initialDoc} from './helpers/docs.js';

const base = () => ({
  repo: 'example/demo', operationId: OPERATION_ID, title: '一覧をCSVで保存できるようにする',
  purpose: '利用者が一覧をCSVで保存できるようにする。', originalRequest: {text: '一覧をCSVでダウンロードできるようにしたい。', sourceRefs: []},
});
const withLabels = () => new FakePiGh().seedLabels(labelDefinitions());
async function harness(t: {after(fn: () => Promise<void>): void}, gh = withLabels(), scenario: Scenario = {}) {
  const {createTool} = await loadToolModule('extensions/tools/epic-draft.ts');
  const h = await createHarness(createTool, {scenario: {gh, defaultParams: base(), ...scenario}});
  t.after(h.dispose);
  return h;
}
const submits = (gh: FakePiGh) => gh.count('gh_issue_submit');
type Data = {draftRef: {path: string; sha256: string}; workflowId: string; missingFields: string[]; issue?: {number: number; url: string}};

for (const field of ['title', 'purpose', 'originalRequest.text'] as const) {
  for (const [label, value] of [['missing', undefined], ['empty', ''], ['blank', '   '], ['null', null], ['number', 42]] as const) {
    test(`${field} ${label} is blocked before any GitHub call`, async t => {
      const gh = withLabels();
      const input: Record<string, unknown> = base();
      const target = field === 'originalRequest.text' ? input.originalRequest as Record<string, unknown> : input;
      const key = field === 'originalRequest.text' ? 'text' : field;
      if (value === undefined) delete target[key]; else target[key] = value;
      const out = await (await harness(t, gh)).invoke(input);
      assert.equal(out.r.status, 'blocked');
      assert.ok(out.r.problems.some(p => p.path === field), JSON.stringify(out.r.problems));
      assert.equal(gh.writes, 0);
    });
  }
}

test('prepare writes nothing remotely, returns the draft ref and never claims a finished spec', async t => {
  const gh = withLabels();
  const h = await harness(t, gh);
  const out = await h.invoke({...base(), mode: 'prepare'});
  assert.equal(out.r.status, 'prepared', JSON.stringify(out.r.problems));
  assert.equal(gh.writes, 0);
  const data = out.r.data as Data;
  assert.match(data.draftRef.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(data.missingFields, ['background', 'requirements', 'criteria', 'constraints', 'outOfScope']);
  assert.equal(data.issue, undefined);
  assert.equal(gh.count('gh_issue_validate'), 1, 'pi-gh validates the draft offline');
  const again = await h.invoke({...base(), mode: 'prepare'});
  assert.equal((again.r.data as Data).draftRef.sha256, data.draftRef.sha256, 'same input → same bytes');
  assert.equal((again.r.data as Data).workflowId, data.workflowId);
});

test('unknown modes are rejected; omitted mode publishes', async t => {
  const gh = withLabels();
  const h = await harness(t, gh);
  assert.equal((await h.invoke({...base(), mode: 'execute'})).r.status, 'blocked');
  assert.equal(gh.calls.length, 0);
  const out = await h.invoke(base());
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.equal(submits(gh), 1);
});

test('an unknown planner model blocks with no GitHub or model calls', async t => {
  for (const scenario of [{model: null}, {thinkingLevel: null}] as Scenario[]) {
    const gh = withLabels();
    const out = await (await harness(t, gh, scenario)).invoke();
    assert.equal(out.r.status, 'blocked');
    assert.ok(out.r.problems.some(p => p.code === 'PLANNER_UNKNOWN'));
    assert.equal(gh.calls.length, 0);
  }
});

test('initial facts and research seeds are validated and never answered for the caller', async t => {
  const gh = withLabels();
  const h = await harness(t, gh);
  const q = {questionId: 'Q001', kind: 'question', question: '対象は顧客一覧だけか', answer: null, required: true, sourceRef: null};
  const r = {researchId: 'R001', question: '10万行で何秒か', requiredEvidence: '計測ログ', doneCondition: 'p95が分かる'};
  for (const bad of [
    {initialFacts: [q, {...q}]},
    {initialFacts: [{...q, answer: 'はい', sourceRef: null}]},
    {research: [r, {...r}]},
    {research: [{...r, doneCondition: ' '}]},
    {research: [{...r, state: 'resolved'}]},
  ]) {
    const out = await h.invoke({...base(), ...bad, mode: 'prepare'});
    assert.equal(out.r.status, 'blocked', JSON.stringify(bad));
  }
  assert.equal(gh.calls.length, 0);
  const ok = await h.invoke({...base(), initialFacts: [q], research: [r], mode: 'prepare'});
  assert.equal(ok.r.status, 'prepared', JSON.stringify(ok.r.problems));
  const draft = JSON.parse(await readFile((ok.r.data as Data).draftRef.path, 'utf8')) as {fields: Record<string, string>};
  const doc = (parseIssueBody(Object.values(draft.fields)[0]!) as {ok: true; value: {doc: EpicDocV1}}).value.doc;
  assert.equal(doc.questions[0]!.answer, null);
  assert.deepEqual(doc.research[0], {...r, state: 'pending', claim: null, conclusion: null, evidenceRefs: [], limitations: []});
});

test('the initial doc is the #4 v1 shape: ten headings, no feature list, wave plan unset', async t => {
  const gh = withLabels();
  const out = await (await harness(t, gh)).invoke({...base(), mode: 'prepare'});
  const draft = JSON.parse(await readFile((out.r.data as Data).draftRef.path, 'utf8')) as {template: string; labels: string[]; parentIssue?: number; fields: Record<string, string>};
  const parsed = parseIssueBody(Object.values(draft.fields)[0]!);
  assert.ok(parsed.ok);
  const doc = parsed.value.doc as EpicDocV1;
  assert.equal('featureRefs' in doc, false);
  assert.equal(doc.wavePlan, null);
  assert.equal(doc.stage, 'setup');
  assert.equal(doc.createOperationId, OPERATION_ID);
  const {workflowId: _w, createOperationId: _c, ...rest} = doc;
  const {workflowId: _fw, createOperationId: _fc, ...golden} = initialDoc();
  assert.deepEqual(rest, golden, 'same content as the #4 golden example');
  const visible = renderEpicVisible(doc);
  assert.equal([...visible.matchAll(/^## (.+)$/gm)].length, 10);
  assert.ok(visible.includes('### Wave計画（基本設計時に記入）\n未設定'));
  assert.equal(draft.template, 'scaffold-epic-v1');
  assert.equal(draft.parentIssue, undefined);
  assert.deepEqual(draft.labels, ['Type: Scaffold', 'Scope: Epic']);
});

test('publish creates one Epic with only Type/Scope labels and a readable managed body', async t => {
  const gh = withLabels();
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  const data = out.r.data as Data;
  assert.deepEqual(data.issue, {number: 10, url: 'https://github.com/example/demo/issues/10'});
  const issue = gh.issues.get(10)!;
  assert.deepEqual(issue.labels.sort(), ['Scope: Epic', 'Type: Scaffold']);
  const parsed = parseIssueBody(issue.body);
  assert.ok(parsed.ok, JSON.stringify(parsed.ok ? [] : parsed.problems));
  assert.equal((parsed.value.doc as EpicDocV1).workflowId, data.workflowId);
  assert.ok(parsed.value.after.includes('planner: `example-provider/planner-1` / `medium`'), 'planner model is recorded, not called');
});

test('the same operation returns the same Issue without posting again', async t => {
  const gh = withLabels();
  const h = await harness(t, gh);
  const first = await h.invoke();
  const second = await h.invoke();
  assert.equal(second.r.status, 'noop');
  assert.deepEqual((second.r.data as Data).issue, (first.r.data as Data).issue);
  assert.equal(submits(gh), 1);
});

test('an existing Issue from this operation is reused even when the journal is gone', async t => {
  const gh = withLabels();
  await (await harness(t, gh)).invoke();
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'noop', JSON.stringify(out.r.problems));
  assert.equal((out.r.data as Data).issue?.number, 10);
  assert.equal(submits(gh), 1);
});

test('two candidate Issues for one operation block', async t => {
  const gh = withLabels();
  await (await harness(t, gh)).invoke();
  const copy = gh.issues.get(10)!;
  gh.add({...copy, number: 11});
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(p => p.code === 'DUPLICATE_CANDIDATES'));
  assert.equal(submits(gh), 1);
});

test('an uncertain submit is never resubmitted', async t => {
  const gh = withLabels();
  gh.overrides.set('gh_issue_submit', () => ({result: {content: [], structuredContent: {status: 'unknown', message: 'uncertain'}}, isError: true}));
  const h = await harness(t, gh);
  assert.equal((await h.invoke()).r.status, 'unknown');
  gh.overrides.delete('gh_issue_submit');
  const again = await h.invoke();
  assert.equal(again.r.status, 'unknown');
  assert.equal(submits(gh), 1, 'no second submit while the first outcome is unknown and no Issue is found');
});

test('an uncertain submit that did create the Issue is reconciled to it', async t => {
  const gh = withLabels();
  let first = true;
  gh.overrides.set('gh_issue_submit', () => { if (!first) return undefined; first = false; return undefined; });
  const h = await harness(t, gh);
  gh.overrides.set('gh_issue_submit', (args) => {
    gh.overrides.delete('gh_issue_submit');
    return Promise.resolve(gh.execute('gh_issue_submit', args)).then(() => ({result: {content: [], structuredContent: {status: 'unknown'}}, isError: true}));
  });
  assert.equal((await h.invoke()).r.status, 'unknown');
  const resumed = await h.invoke();
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.equal((resumed.r.data as Data).issue?.number, 10);
  assert.equal(gh.submitted.length, 1);
});

test('created but labels missing: partial with the number kept, and no second post', async t => {
  const gh = withLabels();
  gh.overrides.set('gh_issue_submit', args => {
    gh.overrides.delete('gh_issue_submit');
    return Promise.resolve(gh.execute('gh_issue_submit', args)).then(r => { gh.issues.get(10)!.labels = ['Type: Scaffold']; return r; });
  });
  const h = await harness(t, gh);
  const out = await h.invoke();
  assert.ok(['partial', 'unknown'].includes(out.r.status), out.r.status);
  assert.ok(out.r.problems.some(p => p.code === 'EPIC_LABELS_INCOMPLETE'));
  assert.equal((out.r.data as {issue?: {number: number}}).issue?.number, 10);
  const again = await h.invoke();
  assert.notEqual(again.r.status, 'applied');
  assert.equal(gh.submitted.length, 1);
});

test('missing management labels stop before submit (run scaffold_labels_ensure first)', async t => {
  const gh = new FakePiGh();
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(p => p.code === 'LABELS_NOT_READY'));
  assert.equal(submits(gh), 0);
});

test('untrusted projects never reach pi-gh writes', async t => {
  const gh = withLabels();
  const out = await (await harness(t, gh, {trusted: false})).invoke();
  assert.ok(out.r.problems.some(p => p.code === 'UNTRUSTED_PROJECT'));
  assert.equal(gh.writes, 0);
});

test('an unresolved Epic operation does not hold other Epics or label setup', async t => {
  const gh = withLabels();
  gh.overrides.set('gh_issue_submit', () => ({result: {content: [], structuredContent: {status: 'unknown'}}, isError: true}));
  const h = await harness(t, gh);
  assert.equal((await h.invoke()).r.status, 'unknown');
  gh.overrides.delete('gh_issue_submit');
  const other = await h.invoke({...base(), operationId: '66666666-6666-4666-8666-666666666666'});
  assert.equal(other.r.status, 'applied', JSON.stringify(other.r.problems));
  const {createTool} = await loadToolModule('extensions/tools/labels-ensure.ts');
  const labels = await createHarness(createTool, {scenario: {gh, defaultParams: {repo: 'example/demo', operationId: '77777777-7777-4777-8777-777777777777'}}});
  t.after(labels.dispose);
  assert.equal((await labels.invoke()).r.status, 'noop');
});

test('a changed session model does not break resuming the same operation', async t => {
  const gh = withLabels();
  gh.overrides.set('gh_issue_submit', args => { gh.overrides.delete('gh_issue_submit'); return Promise.resolve(gh.execute('gh_issue_submit', args)).then(() => ({result: {content: [], structuredContent: {status: 'unknown'}}, isError: true})); });
  const h = await harness(t, gh);
  assert.equal((await h.invoke()).r.status, 'unknown');
  const {createTool} = await loadToolModule('extensions/tools/epic-draft.ts');
  const h2 = await createHarness(createTool, {scenario: {gh, defaultParams: base(), thinkingLevel: 'high'}});
  t.after(h2.dispose);
  const resumedElsewhere = await h2.invoke();
  assert.notEqual(resumedElsewhere.r.problems[0]?.code, 'OPERATION_PAYLOAD_MISMATCH');
  const resumed = await h.invoke();
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.ok(gh.issues.get(10)!.body.includes('`medium`'), 'the recorded planner stays the one that created the draft');
});

test('an unrelated Issue that merely mentions the operationId is never a candidate', async t => {
  const gh = withLabels();
  gh.add({number: 30, title: 'bug', body: `エラー: artifacts/${OPERATION_ID}/draft.json`, labels: ['bug'], state: 'open'});
  gh.add({number: 31, title: 'bug2', body: `<!-- pi-scaffold:v1:start -->壊れた ${OPERATION_ID}`, labels: ['Type: Scaffold', 'Scope: Epic'], state: 'open'});
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.equal(submits(gh), 1);
});

test('candidate search is filtered to Scaffold Epics; pi-gh without the labels feature stops', async t => {
  const gh = withLabels();
  await (await harness(t, gh)).invoke();
  const lists = gh.calls.filter(c => c.name === 'gh_issue_list');
  assert.ok(lists.length >= 1);
  assert.ok(lists.every(c => JSON.stringify((c.args as {labels?: string[]}).labels) === JSON.stringify(['Type: Scaffold', 'Scope: Epic'])));
  const old = withLabels(); old.features = [];
  const out = await (await harness(t, old)).invoke();
  assert.ok(out.r.problems.some(p => p.code === 'CAPABILITY_MISSING' && p.path === 'feature:issue-list-labels'));
  assert.equal(submits(old), 0);
});

test('text pi-gh would redact is refused before any write', async t => {
  const gh = withLabels();
  const out = await (await harness(t, gh)).invoke({...base(), purpose: '既存の値は [REDACTED] だった'});
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(p => p.code === 'UNREADABLE_TEXT'));
  assert.equal(submits(gh), 0);
});
