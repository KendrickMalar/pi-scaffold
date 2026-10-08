import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness, loadToolModule} from './helpers/harness.js';
import {FakePiGh, PI_GH_020_OPERATIONS} from './helpers/fake-pi-gh.js';
import {renderEpicBlock} from '../src/core/epic-render.js';
import {sha256Text} from '../src/core/digests.js';
import {initialDoc, OPERATION_ID} from './helpers/docs.js';

const body = renderEpicBlock(initialDoc());
const params = () => ({repo: 'example/demo', epicIssue: 10, operationId: OPERATION_ID, expectedRevision: 1, expectedBodySha256: sha256Text(body)});
function gh() { return new FakePiGh().add({number: 10, title: '一覧をCSVで保存できるようにする', body, labels: ['Type: Scaffold', 'Scope: Epic'], state: 'open'}); }
async function harness(t: {after(fn: () => Promise<void>): void}, scenario: Parameters<typeof createHarness>[1] extends infer S ? S extends {scenario?: infer X} ? X : never : never = {}) {
  const {createTool} = await loadToolModule('test/fixtures/probe-tool.ts');
  const h = await createHarness(createTool, {scenario: {gh: gh(), defaultParams: params(), ...scenario}});
  t.after(h.dispose);
  return h;
}

test('the real tool definition runs end to end with valid input', async t => {
  const h = await harness(t);
  const out = await h.invoke();
  assert.equal(out.inputSchemaValid, true);
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r));
  assert.equal(out.isError, false);
  assert.equal(out.outputSchemaValid, true);
  assert.equal(out.ghWrites, 1);
  assert.equal(out.herdrCalls, 0);
  const again = await h.invoke();
  assert.equal(again.r.status, 'noop');
  assert.equal(again.ghWrites, 0);
});

test('approved/force/command keys are rejected by schema and service with zero side effects', async t => {
  const h = await harness(t);
  for (const key of ['approved', 'force', 'command']) {
    const out = await h.invoke({...params(), [key]: true});
    assert.equal(out.inputSchemaValid, false);
    assert.equal(out.r.status, 'blocked');
    assert.ok(out.r.problems.some(p => p.path === key));
    assert.equal(out.ghWrites, 0); assert.equal(out.herdrCalls, 0);
    assert.equal(out.isError, true);
    assert.equal(out.outputSchemaValid, true);
  }
});

test('field errors carry their path', async t => {
  const h = await harness(t);
  for (const [field, value] of [['operationId', 'not-a-uuid'], ['expectedRevision', 1.5], ['expectedBodySha256', 'abc'], ['repo', null]] as const) {
    const out = await h.invoke({...params(), [field]: value});
    assert.equal(out.r.status, 'blocked');
    assert.ok(out.r.problems.some(p => p.path === field), field);
    assert.equal(out.ghWrites, 0);
  }
});

test('untrusted projects, foreign origins and missing capabilities block before any write', async t => {
  assert.equal((await (await harness(t, {trusted: false})).invoke()).r.problems[0]!.code, 'UNTRUSTED_PROJECT');
  assert.equal((await (await harness(t, {origin: 'git@github.com:other/demo.git'})).invoke()).r.problems[0]!.code, 'ORIGIN_MISMATCH');
  const g = gh(); g.operations = PI_GH_020_OPERATIONS.filter(o => o !== 'gh_issue_edit');
  const out = await (await harness(t, {gh: g})).invoke();
  assert.equal(out.r.status, 'blocked');
  assert.equal(out.r.problems[0]!.code, 'CAPABILITY_MISSING');
  assert.equal(out.ghWrites, 0);
});

test('stale body hash or revision blocks with zero writes', async t => {
  const h = await harness(t);
  assert.equal((await h.invoke({...params(), expectedBodySha256: 'f'.repeat(64)})).r.problems[0]!.code, 'STALE_BODY');
  const out = await h.invoke({...params(), expectedRevision: 2});
  assert.equal(out.r.problems[0]!.code, 'STALE_REVISION');
  assert.equal(out.ghWrites, 0);
});

test('a nested isError write surfaces as unknown and stays an error', async t => {
  const g = gh();
  g.overrides.set('gh_issue_edit', () => ({...FakePiGh.ok({repo: 'example/demo'}, 'applied'), isError: true}));
  const h = await harness(t, {gh: g});
  const out = await h.invoke();
  assert.equal(out.r.status, 'unknown');
  assert.equal(out.isError, true);
  assert.equal(out.r.resumeToken, OPERATION_ID);
  const retry = await h.invoke();
  assert.equal(retry.r.status, 'unknown', 'never resent without reconciliation');
  assert.equal(retry.ghWrites, 0);
});

test('an aborted call is cancelled before any change', async t => {
  const h = await harness(t);
  const controller = new AbortController(); controller.abort();
  const out = await h.invoke(params(), controller.signal);
  assert.ok(['cancelled', 'blocked'].includes(out.r.status));
  assert.equal(out.isError, true);
  assert.equal(out.ghWrites, 0);
});
