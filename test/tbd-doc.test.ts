import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeScaffoldDoc} from '../src/core/contracts.js';
import {renderEpicVisible, renderTbdBlock, renderTbdVisible} from '../src/core/epic-render.js';
import {buildSnapshot, parseIssueBody, patchDoc} from '../src/core/body-codec.js';
import {initialDoc, tbdDoc} from './helpers/docs.js';


test('tbd doc round-trips through renderTbdBlock/parseIssueBody', () => {
  const doc = tbdDoc();
  const body = 'before\n' + renderTbdBlock(doc) + '\nafter\n';
  const parsed = parseIssueBody(body);
  assert.ok(parsed.ok, JSON.stringify(!parsed.ok && parsed.problems));
  assert.deepEqual(parsed.value.doc, doc);
  assert.equal(parsed.value.projectionChecked, true);
  const visible = renderTbdVisible(doc);
  for (const s of ['## 元の要望', '## 背景', '## 参照資料', '## 確認事項', '## 調査項目', 'Q001', '管理者のみ', '未回答', 'R001']) assert.ok(visible.includes(s), s);
});

test('tbd visible edit is DOC_PROJECTION_MISMATCH', () => {
  const body = renderTbdBlock(tbdDoc()).replace('管理者のみ', '全員');
  const parsed = parseIssueBody(body);
  assert.equal(parsed.ok, false);
  assert.ok(!parsed.ok && parsed.problems.some(p => p.code === 'DOC_PROJECTION_MISMATCH'));
});

test('tbd doc rejects epic-only keys and unknown fields', () => {
  const d = decodeScaffoldDoc({...tbdDoc(), stage: 'setup'});
  assert.equal(d.ok, false);
  assert.ok(!d.ok && d.problems.some(p => p.code === 'UNKNOWN_FIELD' && p.path === 'stage'));
});

test('epic with sourceTbd decodes and renders the same visible body as without', () => {
  const plain = initialDoc();
  const linked = {...initialDoc(), sourceTbd: 7};
  const d = decodeScaffoldDoc(linked);
  assert.ok(d.ok, JSON.stringify(!d.ok && d.problems));
  assert.equal((d.value as typeof linked).sourceTbd, 7);
  assert.equal(renderEpicVisible(linked), renderEpicVisible(plain));
  assert.equal(decodeScaffoldDoc({...initialDoc(), sourceTbd: 0}).ok, false);
});

test('patchDoc rejects tbd', () => {
  const doc = tbdDoc();
  const snap = buildSnapshot({repo: 'example/demo', number: 7, title: 'TBD', body: renderTbdBlock(doc), labels: ['Type: Scaffold', 'Scope: TBD'], state: 'open'});
  assert.ok(snap.ok);
  const r = patchDoc(snap.value, doc);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.problems.some(p => p.code === 'UNSUPPORTED_KIND'));
});
