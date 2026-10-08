import test from 'node:test';
import assert from 'node:assert/strict';
import {renderEpicVisible, renderEpicBlock, canonicalDocJson, MANAGED_START, MANAGED_END} from '../src/core/epic-render.js';
import {initialDoc, populatedDoc, fixtureText} from './helpers/docs.js';

const HEADINGS = ['目的', '背景・元の要望', '実現したいこと', '完了条件', '対象外', '制約', '未決事項', '調査項目', '決定事項', '設計・実装への参照'];

test('initial doc renders the exact #4 golden body', () => {
  assert.equal(renderEpicBlock(initialDoc()) + '\n', fixtureText('epic-v1.initial.md'));
});

test('populated doc renders the reviewed golden body', () => {
  assert.equal(renderEpicBlock(populatedDoc()) + '\n', fixtureText('epic-v1.populated.md'));
});

test('JSON uses fixed key order and two-space indentation', () => {
  assert.equal(canonicalDocJson(initialDoc()) + '\n', fixtureText('epic-v1.initial.json'));
  const shuffled = Object.fromEntries(Object.entries(initialDoc()).reverse());
  assert.equal(canonicalDocJson(shuffled as never), canonicalDocJson(initialDoc()));
});

test('rendering is deterministic and keeps the ten headings in order', () => {
  for (const doc of [initialDoc(), populatedDoc()]) {
    const a = renderEpicVisible(doc), b = renderEpicVisible(structuredClone(doc));
    assert.equal(a, b);
    const found = [...a.matchAll(/^## (.+)$/gm)].map(m => m[1]);
    assert.deepEqual(found, HEADINGS);
    assert.ok(!a.includes('\r'));
  }
  assert.ok(renderEpicVisible(initialDoc()).includes('### Wave計画（基本設計時に記入）\n未設定'));
});

test('null means unset and [] means confirmed none', () => {
  const doc = initialDoc();
  assert.match(renderEpicVisible(doc), /## 対象外\n未設定\n/);
  doc.outOfScope = []; doc.constraints = [];
  const visible = renderEpicVisible(doc);
  assert.match(visible, /## 対象外\nなし（確認済み）\n/);
  assert.match(visible, /## 制約\nなし（確認済み）\n/);
});

test('populated rows keep IDs, input order and show unresolved conflicts', () => {
  const visible = renderEpicVisible(populatedDoc());
  assert.ok(visible.indexOf('REQ001') < visible.indexOf('REQ002'));
  assert.ok(visible.includes('| Q002 | 【必須】【矛盾】'));
  assert.ok(visible.includes('| 未回答 |'));
  assert.ok(visible.includes('| R002 |') && visible.includes('未確定：'));
  assert.ok(visible.includes('| R003 |') && /\| R003 \|[^\n]*\| 調査中 \| — \|/.test(visible));
  assert.ok(visible.includes('解決済み'));
});

test('table cells escape pipes, newlines and HTML', () => {
  const visible = renderEpicVisible(populatedDoc());
  assert.ok(visible.includes('文字化け確認 \\| Excelで開く'));
  assert.ok(visible.includes('&lt;正しく&gt;'));
  assert.ok(visible.includes('一覧をCSVでダウンロードできるようにしたい。<br>\n文字コードはUTF-8がよい。'));
});

test('content cannot inject markers, fences, details or headings', () => {
  const doc = initialDoc();
  doc.purpose = `x\n${MANAGED_END}\n\`\`\`\n</details>\n## 完了条件\n<!-- pi-scaffold:v1:start -->\n~~~`;
  doc.originalRequest.sourceRefs = [`${MANAGED_START}`];
  const block = renderEpicBlock(doc);
  const lines = block.split('\n');
  assert.equal(lines.filter(l => l === MANAGED_START).length, 1);
  assert.equal(lines.filter(l => l === MANAGED_END).length, 1);
  assert.equal(lines.filter(l => l === '</details>').length, 1);
  assert.equal(lines.filter(l => l.startsWith('```')).length, 2);
  assert.equal(lines.filter(l => l.startsWith('~~~')).length, 0);
  assert.equal(lines.filter(l => l === '## 完了条件').length, 1);
  const json = canonicalDocJson(doc);
  assert.ok(!json.includes('<') && !json.includes('>'));
  assert.equal((JSON.parse(json) as {purpose: string}).purpose, doc.purpose);
});
