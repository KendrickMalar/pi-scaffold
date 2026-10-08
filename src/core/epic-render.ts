// Deterministic projection of an Epic document into the visible Issue body (#4 v1 layout).
// User-provided text is escaped so it can never form markers, fences, details tags, headings or tables.
import {decodeScaffoldDoc, type EpicDocV1, type ResearchItem, type ScaffoldDocV1} from './contracts.js';

export const MANAGED_START = '<!-- pi-scaffold:v1:start -->';
export const MANAGED_END = '<!-- pi-scaffold:v1:end -->';
export const DETAILS_OPEN = '<details>\n<summary>Scaffold管理データ（自動管理）</summary>\n\n```json\n';
export const DETAILS_CLOSE = '\n```\n</details>\n';

const UNSET = '未設定', NONE_YET = 'まだありません', CONFIRMED_NONE = 'なし（確認済み）', DASH = '—';
const RESEARCH_STATE_LABEL: Record<ResearchItem['state'], string> = {pending: '未着手', in_progress: '調査中', resolved: '解決済み'};

function escapeLine(line: string): string {
  let s = line.replace(/^[ \t]+/, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`|*_~[\]])/g, '\\$1');
  if (/^[#\-+=]/.test(s)) s = '\\' + s;
  s = s.replace(/^(\d+)([.)])/, '$1\\$2');
  return s;
}
function escapeWith(text: string, joiner: string): string { return text.replace(/\r\n?/g, '\n').split('\n').map(escapeLine).join(joiner); }
const para = (text: string) => escapeWith(text, '<br>\n');
const cell = (text: string) => escapeWith(text, '<br>');
const list = (items: readonly string[]) => items.map(i => '- ' + i).join('\n');
const refs = (values: readonly string[]) => values.map(cell).join(', ');
function optionalList(values: readonly string[] | null): string { return values === null ? UNSET : values.length ? list(values.map(cell)) : CONFIRMED_NONE; }
function table(header: string, rows: string[], empty: string): string {
  return header + '\n' + header.replace(/[^|]+/g, '---') + '\n' + (rows.length ? rows.join('\n') : '\n' + empty);
}
const row = (cells: string[]) => '| ' + cells.join(' | ') + ' |';

function researchResult(r: ResearchItem): string {
  if (r.conclusion === null) return DASH;
  const evidence = r.evidenceRefs.length ? refs(r.evidenceRefs) : DASH;
  const limits = r.limitations.length ? r.limitations.map(cell).join(', ') : 'なし';
  return `${r.state === 'resolved' ? '結論' : '未確定'}：${cell(r.conclusion)}<br>根拠：${evidence}<br>限界：${limits}`;
}

export function renderEpicVisible(doc: EpicDocV1): string {
  const sections: string[] = [];
  const add = (title: string, body: string) => sections.push(`## ${title}\n${body}`);
  add('目的', para(doc.purpose));
  add('背景・元の要望', [
    '### 元の要望\n' + para(doc.originalRequest.text),
    '### 背景\n' + (doc.background === null ? UNSET : para(doc.background)),
    '### 参照資料\n' + (doc.originalRequest.sourceRefs.length ? list(doc.originalRequest.sourceRefs.map(cell)) : NONE_YET),
  ].join('\n\n'));
  add('実現したいこと', doc.requirements.length ? list(doc.requirements.map(r => `${r.id}：${cell(r.description)}`)) : UNSET);
  add('完了条件', table('| ID | 対応する要件 | 検証方法 | 合格基準 |', doc.criteria.map(c => row([c.id, c.requirementIds.join(', '), cell(c.verification), cell(c.expectedResult)])), UNSET));
  add('対象外', optionalList(doc.outOfScope));
  add('制約', optionalList(doc.constraints));
  add('未決事項', table('| ID | 確認事項 | 回答 | 根拠 |', doc.questions.map(q => row([
    q.questionId, (q.required ? '【必須】' : '') + (q.kind === 'conflict' ? '【矛盾】' : '') + cell(q.question),
    q.answer === null ? '未回答' : cell(q.answer), q.sourceRef === null ? DASH : cell(q.sourceRef),
  ])), NONE_YET));
  add('調査項目', table('| ID | 調査内容・完了条件 | 状態 | 結論・根拠・限界 |', doc.research.map(r => row([
    r.researchId, `${cell(r.question)}<br>必要な根拠：${cell(r.requiredEvidence)}<br>完了条件：${cell(r.doneCondition)}`,
    RESEARCH_STATE_LABEL[r.state], researchResult(r),
  ])), NONE_YET));
  add('決定事項', table('| ID | 論点 | 決定 | 理由・根拠 |', doc.decisions.map(d => row([
    d.id, cell(d.topic), cell(d.decision), cell(d.reason) + (d.sourceRefs.length ? '<br>根拠：' + refs(d.sourceRefs) : ''),
  ])), NONE_YET));
  const design = doc.design === null ? UNSET : list([`パス：${cell(doc.design.path)}`, `SHA-256：${doc.design.sha256}`, `Git ref：${doc.design.gitRef}`]);
  const deps = doc.dependencyPlan === null ? UNSET : doc.dependencyPlan.edges.length
    ? list(doc.dependencyPlan.edges.map(e => `#${e.from} → #${e.to}：${cell(e.reason)}`)) : '依存なし';
  let waves = UNSET;
  if (doc.wavePlan !== null) {
    const byWave = new Map<number, number[]>();
    for (const a of doc.wavePlan.assignments) byWave.set(a.wave, [...(byWave.get(a.wave) ?? []), a.issue]);
    waves = byWave.size ? list([...byWave.entries()].sort(([a], [b]) => a - b).map(([w, issues]) => `Wave ${w}：${issues.map(i => '#' + i).join(', ')}`)) : '割り当てなし';
  }
  add('設計・実装への参照', ['### 基本設計\n' + design, '### 依存関係\n' + deps, '### Wave計画（基本設計時に記入）\n' + waves].join('\n\n'));
  return sections.join('\n\n') + '\n';
}

/** Fixed key order (from the strict decoder), 2-space indent, and `<`/`>`/`&` escaped so JSON text cannot form HTML. */
export function canonicalDocJson(doc: ScaffoldDocV1): string {
  const decoded = decodeScaffoldDoc(doc);
  if (!decoded.ok) throw new TypeError('Cannot serialize an invalid document: ' + decoded.problems.map(p => `${p.path} ${p.code}`).join(', '));
  return JSON.stringify(decoded.value, null, 2).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

export function composeManagedBlock(visible: string, doc: ScaffoldDocV1): string {
  return `${MANAGED_START}\n${visible}\n${DETAILS_OPEN}${canonicalDocJson(doc)}${DETAILS_CLOSE}${MANAGED_END}`;
}
export function renderEpicBlock(doc: EpicDocV1): string { return composeManagedBlock(renderEpicVisible(doc), doc); }
