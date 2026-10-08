import test from 'node:test';
import assert from 'node:assert/strict';
import {parseIssueBody, buildSnapshot, patchDoc, type RawIssue} from '../src/core/body-codec.js';
import {renderEpicBlock, renderEpicVisible, composeManagedBlock, MANAGED_START, MANAGED_END} from '../src/core/epic-render.js';
import {LIMITS, type EpicDocV1, type Problem} from '../src/core/contracts.js';
import {sha256Text, labelsSha256} from '../src/core/digests.js';
import {initialDoc, populatedDoc, featureDoc} from './helpers/docs.js';

const codes = (problems: Problem[]) => problems.map(p => p.code);
function problemsOf(r: {ok: true} | {ok: false; problems: Problem[]}): Problem[] { assert.equal(r.ok, false); return r.ok ? [] : r.problems; }
function raw(body: string, labels = ['Type: Scaffold', 'Scope: Epic']): RawIssue { return {repo: 'example/demo', number: 10, title: '一覧をCSVで保存できるようにする', body, labels, state: 'open'}; }

test('rendered body round-trips to the same doc', () => {
  for (const doc of [initialDoc(), populatedDoc()]) {
    const parsed = parseIssueBody(renderEpicBlock(doc));
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.value.doc, doc);
    assert.equal(parsed.value.projectionChecked, true);
  }
});

test('bytes outside the managed block are preserved exactly', () => {
  const before = 'メモ: 手で書いた前置き\r\n\r\n', after = '\n\n追記 | テーブルではない\n';
  const body = before + renderEpicBlock(initialDoc()) + after;
  const parsed = parseIssueBody(body);
  assert.ok(parsed.ok);
  assert.equal(parsed.value.before, before);
  assert.equal(parsed.value.after, after);
  const snap = buildSnapshot(raw(body)); assert.ok(snap.ok);
  const next = structuredClone(snap.value.doc) as EpicDocV1; next.background = '背景を追加';
  const edit = patchDoc(snap.value, next); assert.ok(edit.ok);
  assert.ok(edit.value.body.startsWith(before));
  assert.ok(edit.value.body.endsWith(after));
});

test('visible-only edits are a projection mismatch', () => {
  const body = renderEpicBlock(initialDoc()).replace('利用者が一覧をCSVで保存できるようにする。\n\n## 背景', '利用者が一覧をTSVで保存できるようにする。\n\n## 背景');
  assert.ok(codes(problemsOf(parseIssueBody(body))).includes('DOC_PROJECTION_MISMATCH'));
});

test('JSON-only edits are a projection mismatch', () => {
  const body = renderEpicBlock(initialDoc()).replace('"purpose": "利用者が', '"purpose": "管理者が');
  assert.ok(codes(problemsOf(parseIssueBody(body))).includes('DOC_PROJECTION_MISMATCH'));
});

test('non-canonical JSON formatting is a projection mismatch', () => {
  const body = renderEpicBlock(initialDoc()).replace('  "version": 1,', '  "version":  1,');
  assert.ok(codes(problemsOf(parseIssueBody(body))).includes('DOC_PROJECTION_MISMATCH'));
});

test('two marker pairs, a lone marker or an unknown version is invalid', () => {
  const block = renderEpicBlock(initialDoc());
  assert.ok(codes(problemsOf(parseIssueBody(block + '\n' + block))).includes('INVALID_MANAGED_DOCUMENT'));
  assert.ok(codes(problemsOf(parseIssueBody(block.replace(MANAGED_END, '')))).includes('INVALID_MANAGED_DOCUMENT'));
  assert.ok(codes(problemsOf(parseIssueBody('前置きだけ'))).includes('INVALID_MANAGED_DOCUMENT'));
  assert.ok(codes(problemsOf(parseIssueBody(block.replace(MANAGED_START, '<!-- pi-scaffold:v2:start -->').replace(MANAGED_END, '<!-- pi-scaffold:v2:end -->')))).includes('UNKNOWN_VERSION'));
  const json = renderEpicBlock(initialDoc()).replace('"version": 1,', '"version": 2,');
  assert.ok(codes(problemsOf(parseIssueBody(json))).includes('UNKNOWN_VERSION'));
});

test('markers inside an outer code fence are documentation, not managed blocks', () => {
  const example = '説明:\n````markdown\n' + renderEpicBlock(initialDoc()) + '\n````\n\n';
  const parsed = parseIssueBody(example + renderEpicBlock(populatedDoc()));
  assert.ok(parsed.ok, JSON.stringify(parsed.ok ? [] : parsed.problems));
  assert.equal(parsed.value.doc.revision, 7);
  assert.ok(codes(problemsOf(parseIssueBody(example))).includes('INVALID_MANAGED_DOCUMENT'));
  const indented = ' ' + MANAGED_START;
  assert.ok(codes(problemsOf(parseIssueBody(renderEpicBlock(initialDoc()).replace(MANAGED_START, indented)))).includes('INVALID_MANAGED_DOCUMENT'));
});

test('duplicate JSON keys are rejected', () => {
  const body = renderEpicBlock(initialDoc()).replace('  "revision": 1,', '  "revision": 1,\n  "revision": 1,');
  assert.ok(codes(problemsOf(parseIssueBody(body))).includes('DUPLICATE_KEY'));
});

test('ill-formed UTF-16 (non UTF-8 encodable) bodies are rejected', () => {
  assert.ok(codes(problemsOf(parseIssueBody(renderEpicBlock(initialDoc()) + '\uD800'))).includes('INVALID_ENCODING'));
});

test('body limit: exactly 64KiB is allowed, one byte more is rejected', () => {
  const block = renderEpicBlock(initialDoc());
  const room = LIMITS.bodyBytes - Buffer.byteLength(block) - 1;
  const exact = block + '\n' + 'x'.repeat(room);
  assert.equal(Buffer.byteLength(exact), LIMITS.bodyBytes);
  assert.equal(parseIssueBody(exact).ok, true);
  const problems = problemsOf(parseIssueBody(exact + 'x'));
  assert.ok(problems.some(p => p.code === 'LIMIT_EXCEEDED' && p.path === 'body'));
});

function docWithJsonBytes(target: number): EpicDocV1 {
  const doc = initialDoc(); doc.purpose = 'x';
  const base = Buffer.byteLength(JSON.stringify(doc, null, 2));
  doc.purpose = 'x'.repeat(target - base + 1);
  return doc;
}

test('JSON limit: exactly 16KiB is allowed, one byte more is rejected', () => {
  const exact = docWithJsonBytes(LIMITS.jsonBytes);
  assert.equal(parseIssueBody(renderEpicBlock(exact)).ok, true);
  const over = docWithJsonBytes(LIMITS.jsonBytes + 1);
  assert.ok(problemsOf(parseIssueBody(renderEpicBlock(over))).some(p => p.code === 'LIMIT_EXCEEDED' && p.path === 'json'));
});

test('patch is rejected when the doubled visible+JSON body would exceed the limit', () => {
  const snap = buildSnapshot(raw(renderEpicBlock(initialDoc()) + '\n' + 'm'.repeat(34000))); assert.ok(snap.ok);
  const next = docWithJsonBytes(LIMITS.jsonBytes - 10);
  next.revision = snap.value.doc.revision;
  assert.ok(problemsOf(patchDoc(snap.value, next)).some(p => p.code === 'LIMIT_EXCEEDED' && p.path === 'body'));
});

test('snapshot carries the real title, hashes and decoded doc', () => {
  const body = renderEpicBlock(initialDoc());
  const snap = buildSnapshot(raw(body, ['bug', 'Type: Scaffold']));
  assert.ok(snap.ok);
  assert.equal(snap.value.title, '一覧をCSVで保存できるようにする');
  assert.equal(snap.value.bodySha256, sha256Text(body));
  assert.equal(snap.value.labelsSha256, labelsSha256(['Type: Scaffold', 'bug']));
  assert.deepEqual(snap.value.labels, ['Type: Scaffold', 'bug']);
});

test('patchDoc increments revision and binds to the previous body hash', () => {
  const snap = buildSnapshot(raw(renderEpicBlock(initialDoc()))); assert.ok(snap.ok);
  const next = structuredClone(snap.value.doc) as EpicDocV1; next.requirements = [{id: 'REQ001', description: 'CSVで保存できる'}];
  const edit = patchDoc(snap.value, next); assert.ok(edit.ok);
  assert.deepEqual(Object.keys(edit.value), ['version', 'repo', 'operation', 'issue', 'body', 'expectedBodySha256']);
  assert.equal(edit.value.operation, 'issue-edit-if-current');
  assert.equal(edit.value.expectedBodySha256, snap.value.bodySha256);
  const reparsed = parseIssueBody(edit.value.body); assert.ok(reparsed.ok);
  assert.equal(reparsed.value.doc.revision, 2);
  assert.ok(renderEpicVisible(reparsed.value.doc as EpicDocV1).includes('- REQ001：CSVで保存できる'));
});

test('patchDoc refuses identity changes and invalid next docs', () => {
  const snap = buildSnapshot(raw(renderEpicBlock(initialDoc()))); assert.ok(snap.ok);
  for (const mutate of [
    (d: EpicDocV1) => { d.workflowId = '44444444-4444-4444-8444-444444444444'; },
    (d: EpicDocV1) => { d.createOperationId = '44444444-4444-4444-8444-444444444444'; },
    (d: EpicDocV1) => { d.revision = 5; },
    (d: EpicDocV1) => { d.criteria = [{id: 'AC001', requirementIds: ['REQ404'], verification: 'v', expectedResult: 'e'}]; },
  ]) {
    const next = structuredClone(snap.value.doc) as EpicDocV1; mutate(next);
    assert.equal(patchDoc(snap.value, next).ok, false);
  }
});

test('feature docs parse with an unchecked projection but cannot be patched before #10 defines their template', () => {
  const feature = buildSnapshot({...raw('前置き\n' + composeManagedBlock('## 目的\n手書きの表示\n', featureDoc())), labels: ['Type: Scaffold', 'Scope: Feature']});
  assert.ok(feature.ok, JSON.stringify(feature.ok ? [] : feature.problems));
  assert.equal(feature.value.doc.kind, 'feature');
  assert.equal(feature.value.projectionChecked, false);
  assert.ok(codes(problemsOf(patchDoc(feature.value, featureDoc()))).includes('UNSUPPORTED_KIND'));
});

test('a snapshot whose body changed after parsing is not patched', () => {
  const snap = buildSnapshot(raw(renderEpicBlock(initialDoc()))); assert.ok(snap.ok);
  const stale = {...snap.value, body: snap.value.body + '\n手で追記'};
  assert.ok(codes(problemsOf(patchDoc(stale, structuredClone(snap.value.doc) as EpicDocV1))).includes('STALE_SNAPSHOT'));
});
