import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness, loadToolModule, type Scenario} from './helpers/harness.js';
import {FakeDeterministicGh} from './helpers/fake-deterministic-gh.js';
import {parseIssueBody} from '../src/core/body-codec.js';
import {labelDefinitions} from '../src/core/label-definitions.js';
import type {TbdDocV1} from '../src/core/contracts.js';
import {OPERATION_ID} from './helpers/docs.js';

const base = () => ({
  repo: 'example/demo', operationId: OPERATION_ID, title: '一覧をCSVで保存したい',
  originalRequest: {text: 'W1：一覧をCSVで保存したい。', sourceRefs: []},
});
const withLabels = () => new FakeDeterministicGh().seedLabels(labelDefinitions());
async function harness(t: {after(fn: () => Promise<void>): void}, gh = withLabels(), scenario: Scenario = {}) {
  const {createTool} = await loadToolModule('extensions/tools/tbd-create.ts');
  const h = await createHarness(createTool, {scenario: {gh, defaultParams: base(), ...scenario}});
  t.after(h.dispose);
  return h;
}
type Data = {workflowId: string; issue?: {number: number; url: string}};

for (const [label, patch] of [
  ['missing title', {title: undefined}], ['blank original request', {originalRequest: {text: '  ', sourceRefs: []}}],
  ['answered question without source', {initialFacts: [{questionId: 'Q001', kind: 'question', question: '誰が使うか', answer: '管理者', required: true, sourceRef: null}]}],
  ['bad research id', {research: [{researchId: 'W1', question: 'q', requiredEvidence: 'e', doneCondition: 'd'}]}],
  ['epic-only field', {purpose: '目的'}],
] as const) {
  test(`tbd create: ${label} is blocked before any GitHub call`, async t => {
    const gh = withLabels();
    const input: Record<string, unknown> = {...base(), ...patch};
    for (const k of Object.keys(input)) if (input[k] === undefined) delete input[k];
    const out = await (await harness(t, gh)).invoke(input);
    assert.equal(out.r.status, 'blocked');
    assert.equal(gh.calls.length, 0, JSON.stringify(out.r.problems));
  });
}

test('tbd create publishes one TBD with exactly Type: Scaffold and Scope: TBD and a tbd managed body', async t => {
  const gh = withLabels();
  const facts = [{questionId: 'Q001', kind: 'question', question: '誰が使うか', answer: '管理者のみ', required: true, sourceRef: 'walkthrough 作業メモ の Q001'}];
  const out = await (await harness(t, gh)).invoke({...base(), background: '毎週の集計に使う。', initialFacts: facts});
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  const data = out.r.data as Data;
  assert.deepEqual(data.issue, {number: 10, url: 'https://github.com/example/demo/issues/10'});
  const issue = gh.issues.get(10)!;
  assert.deepEqual(issue.labels.sort(), ['Scope: TBD', 'Type: Scaffold']);
  assert.equal(gh.submitted[0]!.draft.template, 'scaffold-tbd-v1');
  const parsed = parseIssueBody(issue.body);
  assert.ok(parsed.ok, JSON.stringify(parsed.ok ? [] : parsed.problems));
  const doc = parsed.value.doc as TbdDocV1;
  assert.equal(doc.kind, 'tbd');
  assert.equal(doc.createOperationId, OPERATION_ID);
  assert.equal(doc.workflowId, data.workflowId);
  assert.equal(doc.background, '毎週の集計に使う。');
  assert.deepEqual(doc.questions, facts);
  assert.deepEqual(doc.research, []);
});

test('tbd create with the same operationId returns the same Issue without posting again', async t => {
  const gh = withLabels();
  const h = await harness(t, gh);
  assert.equal((await h.invoke()).r.status, 'applied');
  const again = await h.invoke();
  assert.equal(again.r.status, 'noop', JSON.stringify(again.r.problems));
  assert.deepEqual((again.r.data as Data).issue, {number: 10, url: 'https://github.com/example/demo/issues/10'});
  assert.equal(gh.count('gh_issue_submit'), 1);
  const changed = await h.invoke({...base(), title: '別の題'});
  assert.equal(changed.r.status, 'blocked');
  assert.ok(changed.r.problems.some(p => p.code === 'OPERATION_PAYLOAD_MISMATCH'));
});

test('tbd create without Scope: TBD in the repository is LABELS_NOT_READY', async t => {
  const gh = new FakeDeterministicGh().seedLabels(labelDefinitions().filter(l => l.name !== 'Scope: TBD'));
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(p => p.code === 'LABELS_NOT_READY'));
  assert.equal(gh.count('gh_issue_submit'), 0);
});

test('tbd create ignores Epics and TBDs of other operations when looking for its own Issue', async t => {
  const gh = withLabels();
  const h = await harness(t, gh);
  assert.equal((await h.invoke({...base(), operationId: '44444444-4444-4444-8444-444444444444'})).r.status, 'applied');
  const out = await h.invoke();
  assert.equal(out.r.status, 'applied');
  assert.equal((out.r.data as Data).issue!.number, 11);
});
