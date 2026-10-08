import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness, loadToolModule} from './helpers/harness.js';
import {FakePiGh} from './helpers/fake-pi-gh.js';
import {labelDefinitions} from '../src/core/label-definitions.js';
import {renderEpicBlock} from '../src/core/epic-render.js';
import {sha256Text} from '../src/core/digests.js';
import {initialDoc, OPERATION_ID} from './helpers/docs.js';

// Pi converts arguments to the schema types (Value.Convert) before execute(); 42 would become "42".
async function harness(t: {after(fn: () => Promise<void>): void}, module: string, gh: FakePiGh) {
  const {createTool} = await loadToolModule(module);
  const h = await createHarness(createTool, {scenario: {gh}});
  t.after(h.dispose);
  return h;
}
const epic = () => ({repo: 'example/demo', operationId: OPERATION_ID, title: 'CSV出力', purpose: '目的', originalRequest: {text: '依頼', sourceRefs: []}, mode: 'prepare'});

test('wrong types are rejected before Pi coerces them, so nothing runs', async t => {
  const gh = new FakePiGh().seedLabels(labelDefinitions());
  const h = await harness(t, 'extensions/tools/epic-draft.ts', gh);
  for (const bad of [{...epic(), title: 42}, {...epic(), purpose: true}, {...epic(), originalRequest: {text: '依頼', sourceRefs: [3]}}]) {
    const out = await h.invokeAsPi(bad);
    assert.equal(out.piRejected, true, JSON.stringify(bad));
    assert.equal(gh.calls.length, 0);
  }
  const ok = await h.invokeAsPi(epic());
  assert.equal(ok.piRejected, false);
  assert.ok(!ok.piRejected && ok.r.status === 'prepared', JSON.stringify(ok));
});

test('numeric strings are not coerced into integers for mutation inputs', async t => {
  const body = renderEpicBlock(initialDoc());
  const gh = new FakePiGh().add({number: 10, title: 't', body, labels: [], state: 'open'});
  const h = await harness(t, 'test/fixtures/probe-tool.ts', gh);
  const params = {repo: 'example/demo', epicIssue: 10, operationId: OPERATION_ID, expectedRevision: 1, expectedBodySha256: sha256Text(body)};
  for (const bad of [{...params, expectedRevision: '1'}, {...params, epicIssue: '10'}]) {
    const out = await h.invokeAsPi(bad);
    assert.equal(out.piRejected, true, JSON.stringify(bad));
  }
  assert.equal(gh.writes, 0);
});

test('labels_ensure rejects a non-string operationId before coercion', async t => {
  const gh = new FakePiGh();
  const h = await harness(t, 'extensions/tools/labels-ensure.ts', gh);
  assert.equal((await h.invokeAsPi({repo: 'example/demo', operationId: 123})).piRejected, true);
});
