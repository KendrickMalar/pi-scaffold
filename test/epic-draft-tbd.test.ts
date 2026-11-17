import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness, loadToolModule} from './helpers/harness.js';
import {FakeDeterministicGh} from './helpers/fake-deterministic-gh.js';
import {renderTbdBlock} from '../src/core/epic-render.js';
import {parseIssueBody} from '../src/core/body-codec.js';
import {labelDefinitions} from '../src/core/label-definitions.js';
import type {EpicDocV1} from '../src/core/contracts.js';
import {OPERATION_ID, tbdDoc} from './helpers/docs.js';

const TBD_URL = 'https://github.com/example/demo/issues/5';
const base = () => ({repo: 'example/demo', operationId: OPERATION_ID, title: '一覧をCSVで保存できるようにする', purpose: '利用者が一覧をCSVで保存できるようにする。', tbdIssue: 5});
function gh(body = renderTbdBlock(tbdDoc()), labels = ['Type: Scaffold', 'Scope: TBD'], state: 'open' | 'closed' = 'open') {
  return new FakeDeterministicGh().seedLabels(labelDefinitions()).enableProposals().add({number: 5, title: 'CSVで保存したい', body, labels, state});
}
async function harness(t: {after(fn: () => Promise<void>): void}, g: FakeDeterministicGh) {
  const {createTool} = await loadToolModule('extensions/tools/epic-draft.ts');
  const h = await createHarness(createTool, {scenario: {gh: g, defaultParams: base()}});
  t.after(h.dispose);
  return h;
}
type Data = {issue?: {number: number; url: string}; tbd?: {number: number; url: string; closed: boolean}};
const epicDoc = (g: FakeDeterministicGh, n: number) => { const p = parseIssueBody(g.issues.get(n)!.body); assert.ok(p.ok, JSON.stringify(!p.ok && p.problems)); return p.value.doc as EpicDocV1; };

test('epic from a managed TBD carries its request, background, facts and research, links it and closes it', async t => {
  const g = gh();
  const out = await (await harness(t, g)).invoke();
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  const data = out.r.data as Data;
  assert.deepEqual(data.tbd, {number: 5, url: TBD_URL, closed: true});
  const doc = epicDoc(g, data.issue!.number);
  const t0 = tbdDoc();
  assert.equal(doc.originalRequest.text, t0.originalRequest.text);
  assert.deepEqual(doc.originalRequest.sourceRefs, [TBD_URL]);
  assert.equal(doc.background, t0.background);
  assert.deepEqual(doc.questions, t0.questions);
  assert.deepEqual(doc.research.map(r => r.researchId), ['R001']);
  assert.equal(doc.sourceTbd, 5);
  assert.equal(g.issues.get(5)!.state, 'closed');
  assert.ok(g.issues.get(data.issue!.number)!.body.includes(TBD_URL), 'the Epic body shows the TBD URL (Looper finds the Epic by it)');
});

test('epic from a TBD without a managed block uses its title and body as the original request', async t => {
  const g = gh('保存の前に件数も見たい。');
  const out = await (await harness(t, g)).invoke();
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  const doc = epicDoc(g, (out.r.data as Data).issue!.number);
  assert.equal(doc.originalRequest.text, 'CSVで保存したい\n\n保存の前に件数も見たい。');
  assert.equal(doc.background, null);
  assert.deepEqual(doc.questions, []);
  assert.equal(g.issues.get(5)!.state, 'closed');
});

test('fields given by the caller win over the TBD', async t => {
  const g = gh();
  const out = await (await harness(t, g)).invoke({...base(), originalRequest: {text: '呼び出し側の依頼', sourceRefs: ['docs/a.md']}, background: null});
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  const doc = epicDoc(g, (out.r.data as Data).issue!.number);
  assert.equal(doc.originalRequest.text, '呼び出し側の依頼');
  assert.deepEqual(doc.originalRequest.sourceRefs, ['docs/a.md', TBD_URL]);
  assert.equal(doc.background, null);
});

for (const [label, g] of [
  ['a closed TBD', () => gh(undefined, undefined, 'closed')],
  ['an Issue without Scope: TBD', () => gh(undefined, ['Type: Scaffold', 'Scope: Epic'])],
  ['a missing Issue', () => new FakeDeterministicGh().seedLabels(labelDefinitions()).enableProposals()],
] as const) {
  test(`${label} blocks with no writes`, async t => {
    const fake = g();
    const out = await (await harness(t, fake)).invoke();
    assert.equal(out.r.status, 'blocked');
    assert.equal(fake.writes, 0, JSON.stringify(out.r.problems));
    assert.ok(!out.r.problems.some(p => p.code === 'UNKNOWN_FIELD'), JSON.stringify(out.r.problems));
  });
}

test('without tbdIssue the original request is still required', async t => {
  const g = gh();
  const {tbdIssue: _x, ...input} = base();
  const out = await (await harness(t, g)).invoke(input);
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(p => p.path === 'originalRequest' && p.code === 'REQUIRED'));
});

test('an uncertain TBD close resumes with the same operationId without creating the Epic again', async t => {
  const g = gh();
  let calls = 0;
  g.overrides.set('gh_issue_close_if_current', () => { calls++; return calls === 1 ? {result: {content: [], structuredContent: {status: 'unknown'}}, isError: true} : undefined; });
  const h = await harness(t, g);
  const first = await h.invoke();
  assert.equal(first.r.status, 'unknown');
  assert.equal(g.issues.get(5)!.state, 'open');
  const resumed = await h.invoke();
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.equal(g.count('gh_issue_submit'), 1);
  assert.equal(g.issues.get(5)!.state, 'closed');
});

test('a TBD edited after it was read is not closed; the Epic stays and the run is partial', async t => {
  const g = gh();
  g.overrides.set('gh_issue_close_if_current', () => { g.issues.get(5)!.body += '\n追記'; return undefined; });
  const out = await (await harness(t, g)).invoke();
  assert.equal(out.r.status, 'partial');
  assert.ok((out.r.data as Data).issue, 'the created Epic is reported');
  assert.equal(g.issues.get(5)!.state, 'open');
  assert.equal(g.count('gh_issue_submit'), 1);
});
