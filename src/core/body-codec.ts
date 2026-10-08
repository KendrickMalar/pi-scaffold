// Parses and regenerates the managed block inside an Issue body. Bytes outside the block are kept verbatim.
import {
  LIMITS, decodeScaffoldDoc, failed, okValue, problem, isRepoRef, isPositiveInt,
  type Decoded, type IssueSnapshot, type PreparedIssueEdit, type Problem, type ScaffoldDocV1, type EpicDocV1,
} from './contracts.js';
import {MANAGED_START, MANAGED_END, DETAILS_OPEN, DETAILS_CLOSE, renderEpicVisible, renderEpicBlock, renderFeatureVisible, canonicalDocJson} from './epic-render.js';
import {sha256Text, labelsSha256} from './digests.js';

export interface ParsedBody { before: string; after: string; block: string; doc: ScaffoldDocV1; projectionChecked: boolean }
export interface RawIssue { repo: string; number: number; title: string; body: string; labels: string[]; state: 'open' | 'closed' }

const MARKER_LIKE = /^<!--\s*pi-scaffold:([^:\s]+):(start|end)\s*-->\s*$/;
const invalid = (message: string, path = 'body') => problem('INVALID_MANAGED_DOCUMENT', path, message);

/** Line offsets of marker lines that are at column 0 and outside fenced code blocks. */
function findMarkers(body: string): {problems: Problem[]; start: number[]; end: number[]} {
  const problems: Problem[] = [], start: number[] = [], end: number[] = [];
  let fence: {char: string; len: number} | null = null, offset = 0;
  for (const raw of body.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (f && f[1]![0] === fence.char && f[1]!.length >= fence.len && !f[2]!.trim()) fence = null;
    } else if (f && !(f[1]![0] === '`' && f[2]!.includes('`'))) {
      fence = {char: f[1]![0]!, len: f[1]!.length};
    } else if (line === MANAGED_START) start.push(offset);
    else if (line === MANAGED_END) end.push(offset);
    else {
      const m = MARKER_LIKE.exec(line.trim());
      if (m) problems.push(m[1] === 'v1' ? invalid('Marker must be an exact line at column 0.') : problem('UNKNOWN_VERSION', 'body', `Unsupported managed block version ${m[1]}.`));
    }
    offset += raw.length + 1;
  }
  return {problems, start, end};
}

// ---- strict JSON (duplicate keys rejected) ----------------------------------------------------

class JsonError extends Error { constructor(readonly code: string, message: string) { super(message); } }
export function parseStrictJson(text: string): unknown {
  let i = 0;
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++; };
  const fail = (m: string): never => { throw new JsonError('INVALID_JSON', `${m} at offset ${i}.`); };
  const str = (): string => {
    const startAt = i; i++;
    while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; else if (text.charCodeAt(i) < 0x20) fail('Control character in string'); i++; }
    if (text[i] !== '"') fail('Unterminated string');
    i++;
    try { return JSON.parse(text.slice(startAt, i)) as string; } catch { return fail('Invalid string escape'); }
  };
  const value = (): unknown => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++; const out: Record<string, unknown> = {}; const seen = new Set<string>(); ws();
      if (text[i] === '}') { i++; return out; }
      for (;;) {
        ws(); if (text[i] !== '"') fail('Expected key');
        const key = str();
        if (seen.has(key)) throw new JsonError('DUPLICATE_KEY', `Duplicate JSON key "${key}".`);
        seen.add(key); ws(); if (text[i] !== ':') fail('Expected colon'); i++;
        Object.defineProperty(out, key, {value: value(), enumerable: true, writable: true, configurable: true});
        ws(); if (text[i] === ',') { i++; continue; } if (text[i] === '}') { i++; return out; } fail('Expected , or }');
      }
    }
    if (c === '[') {
      i++; const out: unknown[] = []; ws();
      if (text[i] === ']') { i++; return out; }
      for (;;) { out.push(value()); ws(); if (text[i] === ',') { i++; continue; } if (text[i] === ']') { i++; return out; } fail('Expected , or ]'); }
    }
    if (c === '"') return str();
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
    if (!m) return fail('Unexpected token');
    i += m[0].length; return JSON.parse(m[0]);
  };
  const result = value(); ws();
  if (i !== text.length) fail('Trailing data');
  return result;
}

// ---- body codec -------------------------------------------------------------------------------

export function parseIssueBody(body: string): Decoded<ParsedBody> {
  if (typeof body !== 'string') return failed([problem('INVALID_TYPE', 'body', 'Expected a string body.')]);
  if (!body.isWellFormed()) return failed([problem('INVALID_ENCODING', 'body', 'Body is not valid UTF-8 text.')]);
  if (Buffer.byteLength(body) > LIMITS.bodyBytes) return failed([problem('LIMIT_EXCEEDED', 'body', `Body exceeds ${LIMITS.bodyBytes} bytes.`)]);
  const markers = findMarkers(body);
  if (markers.problems.length) return failed(markers.problems);
  if (markers.start.length !== 1 || markers.end.length !== 1) return failed([invalid(`Expected exactly one managed block (found ${markers.start.length} start / ${markers.end.length} end markers).`)]);
  const s = markers.start[0]!, e = markers.end[0]!;
  if (e < s) return failed([invalid('End marker precedes start marker.')]);
  const endOfEnd = e + MANAGED_END.length;
  const block = body.slice(s, endOfEnd), before = body.slice(0, s), after = body.slice(endOfEnd);
  // GitHub's web editor may save CRLF. The managed block is regenerated anyway, so parse it LF-normalized;
  // bytes outside the block are kept exactly as they are.
  const lf = block.replace(/\r\n/g, '\n');
  const inner = lf.slice(MANAGED_START.length + 1, lf.length - MANAGED_END.length);
  const detailsAt = inner.lastIndexOf('\n' + DETAILS_OPEN);
  if (!lf.startsWith(MANAGED_START + '\n') || detailsAt < 0 || !inner.endsWith(DETAILS_CLOSE)) return failed([invalid('Managed block structure is not recognized.')]);
  const visible = inner.slice(0, detailsAt);
  const jsonText = inner.slice(detailsAt + 1 + DETAILS_OPEN.length, inner.length - DETAILS_CLOSE.length);
  if (Buffer.byteLength(jsonText) > LIMITS.jsonBytes) return failed([problem('LIMIT_EXCEEDED', 'json', `Managed JSON exceeds ${LIMITS.jsonBytes} bytes.`)]);
  let parsed: unknown;
  try { parsed = parseStrictJson(jsonText); } catch (error) {
    const e = error instanceof JsonError ? error : new JsonError('INVALID_JSON', 'Managed JSON is invalid.');
    return failed([problem(e.code === 'DUPLICATE_KEY' ? 'DUPLICATE_KEY' : 'INVALID_MANAGED_DOCUMENT', 'json', e.message)]);
  }
  const decoded = decodeScaffoldDoc(parsed);
  if (!decoded.ok) return failed(decoded.problems.map(p => ({...p, path: p.path ? 'json.' + p.path : 'json'})));
  const doc = decoded.value;
  if (jsonText !== canonicalDocJson(doc)) return failed([problem('DOC_PROJECTION_MISMATCH', 'json', 'Managed JSON is not in canonical form; it was edited directly.')]);
  if (doc.kind === 'epic') {
    if (visible !== renderEpicVisible(doc)) return failed([problem('DOC_PROJECTION_MISMATCH', 'body', 'Visible body differs from the managed JSON. Reflect the edit into the structured data explicitly.')]);
    return okValue({before, after, block, doc, projectionChecked: true});
  }
  if (doc.kind === 'feature') {
    if (visible !== renderFeatureVisible(doc)) return failed([problem('DOC_PROJECTION_MISMATCH', 'body', 'Visible body differs from the managed JSON. Reflect the edit into the structured data explicitly.')]);
    return okValue({before, after, block, doc, projectionChecked: true});
  }
  return okValue({before, after, block, doc, projectionChecked: false});
}

export function buildSnapshot(raw: RawIssue): Decoded<IssueSnapshot> {
  const problems: Problem[] = [];
  if (!isRepoRef(raw.repo)) problems.push(problem('INVALID_FORMAT', 'repo', 'Expected OWNER/REPO.'));
  if (!isPositiveInt(raw.number)) problems.push(problem('INVALID_INTEGER', 'number', 'Expected an Issue number.'));
  if (typeof raw.title !== 'string') problems.push(problem('INVALID_TYPE', 'title', 'Expected a title string.'));
  if (!Array.isArray(raw.labels) || raw.labels.some(l => typeof l !== 'string')) problems.push(problem('INVALID_TYPE', 'labels', 'Expected label names.'));
  if (raw.state !== 'open' && raw.state !== 'closed') problems.push(problem('INVALID_VALUE', 'state', 'Expected open or closed.'));
  if (problems.length) return failed(problems);
  const parsed = parseIssueBody(raw.body);
  if (!parsed.ok) return parsed;
  const labels = [...raw.labels].sort();
  return okValue({
    repo: raw.repo, number: raw.number, title: raw.title, body: raw.body, bodySha256: sha256Text(raw.body),
    labels, labelsSha256: labelsSha256(labels), state: raw.state, doc: parsed.value.doc, projectionChecked: parsed.value.projectionChecked,
  });
}

/** Regenerates the whole managed block for `nextDoc` (revision+1) and keeps the outside bytes. */
export function patchDoc(snapshot: IssueSnapshot, nextDoc: ScaffoldDocV1): Decoded<PreparedIssueEdit> {
  if (sha256Text(snapshot.body) !== snapshot.bodySha256) return failed([problem('STALE_SNAPSHOT', 'body', 'Snapshot body does not match its hash.')]);
  const current = parseIssueBody(snapshot.body);
  if (!current.ok) return current;
  const prev = current.value.doc;
  if (prev.kind !== 'epic' || nextDoc.kind !== 'epic') return failed([problem('UNSUPPORTED_KIND', 'doc.kind', 'Only Epic documents have a defined visible template in this version.')]);
  const identity: Problem[] = [];
  if (nextDoc.workflowId !== prev.workflowId) identity.push(problem('IDENTITY_CHANGED', 'doc.workflowId', 'workflowId cannot change.'));
  if (nextDoc.createOperationId !== prev.createOperationId) identity.push(problem('IDENTITY_CHANGED', 'doc.createOperationId', 'createOperationId cannot change.'));
  if (nextDoc.revision !== prev.revision) identity.push(problem('STALE_REVISION', 'doc.revision', 'Pass the current revision; patchDoc increments it.'));
  if (identity.length) return failed(identity);
  const next: EpicDocV1 = {...nextDoc, revision: prev.revision + 1};
  const decoded = decodeScaffoldDoc(next);
  if (!decoded.ok) return failed(decoded.problems.map(p => ({...p, path: 'doc.' + p.path})));
  const json = canonicalDocJson(next);
  if (Buffer.byteLength(json) > LIMITS.jsonBytes) return failed([problem('LIMIT_EXCEEDED', 'json', `Managed JSON exceeds ${LIMITS.jsonBytes} bytes.`)]);
  const body = current.value.before + renderEpicBlock(next) + current.value.after;
  if (Buffer.byteLength(body) > LIMITS.bodyBytes) return failed([problem('LIMIT_EXCEEDED', 'body', `Body would exceed ${LIMITS.bodyBytes} bytes.`)]);
  return okValue({version: 1, repo: snapshot.repo, operation: 'issue-edit-if-current', issue: snapshot.number, body, expectedBodySha256: snapshot.bodySha256});
}
