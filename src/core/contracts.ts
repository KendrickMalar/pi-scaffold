// Shared contracts for every pi-scaffold tool. Runtime decoders mirror the TypeBox entry schemas so
// that services never trust input that bypassed Pi's own validation.

export const LIMITS = Object.freeze({
  bodyBytes: 64 * 1024,
  jsonBytes: 16 * 1024,
  artifactBytes: 1024 * 1024,
  features: 50,
  research: 50,
  requirements: 100,
  criteria: 100,
  questions: 100,
  decisions: 100,
  waveMin: 1,
  waveMax: 200,
  callTimeoutMs: 60_000,
});

export const STAGES = ['setup', 'specification', 'basic-design', 'implementation', 'verification', 'completed'] as const;
export type Stage = typeof STAGES[number];
export const HANDOFF_PHASES = ['prepared', 'tab-created', 'receiver-ready', 'stage-committed', 'prompt-sent', 'turn-started'] as const;
export type HandoffPhase = typeof HANDOFF_PHASES[number];
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];
export const RESEARCH_STATES = ['pending', 'in_progress', 'resolved'] as const;
export type ResearchState = typeof RESEARCH_STATES[number];

export type RepoRef = string;
export type Sha256 = string;
export type GitObjectId = string;
export type UUID = string;

export interface Problem { code: string; path: string; message: string }
export type Decoded<T> = {ok: true; value: T} | {ok: false; problems: Problem[]};
export const okValue = <T>(value: T): Decoded<T> => ({ok: true, value});
export const failed = <T = never>(problems: Problem[]): Decoded<T> => ({ok: false, problems});
export const problem = (code: string, path: string, message: string): Problem => ({code, path, message});

export type ScaffoldStatus = 'validated' | 'prepared' | 'applied' | 'noop' | 'blocked' | 'partial' | 'unknown' | 'cancelled';
export interface ScaffoldResult<T = unknown> { status: ScaffoldStatus; operation: string; data?: T; problems: Problem[]; resumeToken?: string }
const ERROR_STATUSES: readonly ScaffoldStatus[] = ['blocked', 'partial', 'unknown', 'cancelled'];
export function isErrorStatus(status: ScaffoldStatus): boolean { return ERROR_STATUSES.includes(status); }

export interface MutationInput { repo: RepoRef; epicIssue: number; operationId: UUID; expectedRevision: number; expectedBodySha256: Sha256 }

export interface OriginalRequest { text: string; sourceRefs: string[] }
export interface Requirement { id: string; description: string }
export interface Criterion { id: string; requirementIds: string[]; verification: string; expectedResult: string }
export interface Decision { id: string; topic: string; decision: string; reason: string; sourceRefs: string[] }
export interface QuestionFact { questionId: string; kind: 'question' | 'conflict'; question: string; answer: string | null; required: boolean; sourceRef: string | null }
export interface ResearchItemSeed { researchId: string; question: string; requiredEvidence: string; doneCondition: string }
export interface ResearchClaim { researchId: string; operationId: UUID; sessionId: string; specBaseDigest: Sha256 }
export interface ResearchItem extends ResearchItemSeed { state: ResearchState; claim: ResearchClaim | null; conclusion: string | null; evidenceRefs: string[]; limitations: string[] }
export interface DesignRef { path: string; sha256: Sha256; gitRef: GitObjectId }
export interface DependencyNode { featureKey: string; issue: number; contracts: string[]; startConditions: string[]; editScope: string[] }
export interface DependencyEdge { from: number; to: number; reason: string }
export interface DependencyPlan { version: 1; nodes: DependencyNode[]; edges: DependencyEdge[] }
export interface WaveAssignment { issue: number; wave: number }
export interface WavePlan { version: 1; assignments: WaveAssignment[]; dependencyDigest: Sha256; featureSetDigest: Sha256 }
/** Public handoff progress. The nonce itself lives only in the private journal/packet. */
export interface HandoffState { nonceSha256: Sha256; sourceStage: Stage; targetStage: Stage; phase: HandoffPhase; operationId: UUID }
export interface ModelBinding { model: string; thinking: ThinkingLevel; reason: string }
export interface OwnedEvidenceRef { relativePath: string; sha256: Sha256 }

export interface EpicDocV1 {
  version: 1; kind: 'epic'; workflowId: UUID; revision: number; createOperationId: UUID; stage: Stage;
  purpose: string; originalRequest: OriginalRequest; background: string | null;
  questions: QuestionFact[]; requirements: Requirement[]; criteria: Criterion[];
  constraints: string[] | null; outOfScope: string[] | null;
  research: ResearchItem[]; decisions: Decision[];
  design: DesignRef | null; dependencyPlan: DependencyPlan | null; wavePlan: WavePlan | null; handoff: HandoffState | null;
}
export type FeatureRole = 'coding-manager' | 'coder' | 'tester';
export interface FeatureDocV1 {
  version: 1; kind: 'feature'; workflowId: UUID; revision: number; createOperationId: UUID;
  featureKey: string; parentEpic: number; stage: Stage; purpose: string;
  editScope: string[]; outOfScope: string[]; designRef: DesignRef; criteria: Criterion[];
  bindings: Record<FeatureRole, ModelBinding>; evidenceRefs: OwnedEvidenceRef[];
}
export interface TaskDocV1 {
  version: 1; kind: 'task'; workflowId: UUID; revision: number; createOperationId: UUID;
  taskKey: string; parentFeature: number; purpose: string;
  editScope: string[]; outOfScope: string[]; criteria: Criterion[];
  bindings: {coder: ModelBinding; tester: ModelBinding}; evidenceRefs: OwnedEvidenceRef[];
}
export type ScaffoldDocV1 = EpicDocV1 | FeatureDocV1 | TaskDocV1;

export interface IssueSnapshot {
  repo: RepoRef; number: number; title: string; body: string; bodySha256: Sha256;
  labels: string[]; labelsSha256: Sha256; state: 'open' | 'closed'; doc: ScaffoldDocV1; projectionChecked: boolean;
}
export type FeatureSnapshot = IssueSnapshot & {doc: FeatureDocV1};

export interface EvidenceCriterionReport { id: string; status: 'pass' | 'fail' | 'unverified'; command: string; exitCode: number | null; logPath: string; logSha256: Sha256 }
export interface EvidenceReportV1 { version: 1; workflowId: UUID; featureIssue: number; productRef: GitObjectId; suiteRef: GitObjectId; criteria: EvidenceCriterionReport[] }

export interface GateResult { status: 'validated' | 'blocked'; problems: Problem[]; artifactDigests: Record<string, Sha256> }
export interface WaveCheck { passed: boolean; checks: string[]; problems: Problem[] }

/** B1/B2/B3 change artifacts. These are proposals for pi-gh; no 0.2.0 tool accepts them yet. */
export interface PreparedIssueEdit { version: 1; repo: RepoRef; operation: 'issue-edit-if-current'; issue: number; body: string; expectedBodySha256: Sha256 }
export interface PreparedIssueLabels { version: 1; repo: RepoRef; operation: 'issue-labels-if-current'; issue: number; add: string[]; remove: string[]; expectedLabelsSha256: Sha256 }
export interface PreparedIssueClose { version: 1; repo: RepoRef; operation: 'issue-close-if-current'; issue: number; expectedBodySha256: Sha256; reason: 'completed' }

export interface RepoContext {
  repo: RepoRef; repoRoot: string; gitCommonDir: string; workflowStateRoot: string;
  accountBinding: Sha256 | null; profileId: string | null; profileInstructionsDigest: Sha256 | null;
}
export interface CallScope { sessionId: string; leafId: string; generation: number; signal: AbortSignal; isCurrent(): boolean }
export interface ApprovalRef { kind: ApprovalKind; viewDigest: Sha256; repo: RepoRef; workflowId: UUID; accountBinding: Sha256 }
export type ApprovalKind = 'specification' | 'implementation-start' | 'epic-completion';
export interface OwnedArtifactRef { path: string; sha256: Sha256; operationId: UUID }
export type OwnedPacketRef = OwnedArtifactRef;

// ---- predicates -------------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;
export const isUuid = (v: unknown): v is UUID => typeof v === 'string' && UUID_RE.test(v);
export const isSha256 = (v: unknown): v is Sha256 => typeof v === 'string' && SHA_RE.test(v);
export const isRepoRef = (v: unknown): v is RepoRef => typeof v === 'string' && REPO_RE.test(v) && !/\/\.{1,2}$/.test(v);
export const isGitObjectId = (v: unknown): v is GitObjectId => typeof v === 'string' && OID_RE.test(v);
export const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
export const isNonBlank = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

export type StableIdPrefix = 'REQ' | 'AC' | 'Q' | 'R' | 'D' | 'F' | 'T';
export function parseStableId(prefix: StableIdPrefix, value: unknown): {prefix: StableIdPrefix; number: number} | undefined {
  if (typeof value !== 'string' || !value.startsWith(prefix)) return undefined;
  const digits = value.slice(prefix.length);
  if (!/^\d{3,}$/.test(digits)) return undefined;
  const number = Number(digits);
  if (!Number.isSafeInteger(number) || number < 1 || String(number).padStart(3, '0') !== digits) return undefined;
  return {prefix, number};
}

// ---- strict decoder ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const join = (path: string, key: string | number) => typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key;

class Reader {
  readonly problems: Problem[] = [];
  add(code: string, path: string, message: string) { this.problems.push(problem(code, path, message)); }
  /** Returns the record when it is an object containing only `keys`; reports missing required keys. */
  object(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Rec | undefined {
    if (!isRecord(value)) { this.add('INVALID_TYPE', path, 'Expected an object.'); return undefined; }
    for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) this.add('UNKNOWN_FIELD', join(path, key), 'Unknown field.');
    for (const key of required) if (!Object.hasOwn(value, key) || value[key] === undefined) this.add('REQUIRED', join(path, key), 'Required field is missing.');
    return value;
  }
  text(value: unknown, path: string): string {
    if (typeof value !== 'string') { if (value !== undefined) this.add('INVALID_TYPE', path, 'Expected a string.'); return ''; }
    if (!value.trim()) this.add('BLANK', path, 'Expected non-blank text.');
    return value;
  }
  nullableText(value: unknown, path: string): string | null { return value === null ? null : this.text(value, path); }
  bool(value: unknown, path: string): boolean { if (typeof value !== 'boolean' && value !== undefined) this.add('INVALID_TYPE', path, 'Expected a boolean.'); return value === true; }
  int(value: unknown, path: string, min = 1, max = Number.MAX_SAFE_INTEGER, code = 'INVALID_INTEGER'): number {
    if (value === undefined) return 0;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) this.add(code, path, `Expected an integer from ${min} to ${max}.`);
    return typeof value === 'number' ? value : 0;
  }
  pattern(value: unknown, path: string, test: (v: unknown) => boolean, what: string): string {
    if (value === undefined) return '';
    if (!test(value)) this.add('INVALID_FORMAT', path, `Expected ${what}.`);
    return typeof value === 'string' ? value : '';
  }
  literal<T extends string | number>(value: unknown, path: string, allowed: readonly T[], code = 'INVALID_VALUE'): T {
    if (value !== undefined && !allowed.includes(value as T)) this.add(code, path, `Expected one of: ${allowed.join(', ')}.`);
    return value as T;
  }
  array<T>(value: unknown, path: string, item: (v: unknown, path: string) => T, limit?: number): T[] {
    if (!Array.isArray(value)) { if (value !== undefined) this.add('INVALID_TYPE', path, 'Expected an array.'); return []; }
    if (limit !== undefined && value.length > limit) this.add('LIMIT_EXCEEDED', path, `At most ${limit} items are allowed.`);
    return value.map((v, i) => item(v, join(path, i)));
  }
  nullableArray<T>(value: unknown, path: string, item: (v: unknown, path: string) => T): T[] | null { return value === null ? null : this.array(value, path, item); }
  texts(value: unknown, path: string): string[] { return this.array(value, path, (v, p) => this.text(v, p)); }
  stableId(prefix: StableIdPrefix, value: unknown, path: string): string {
    if (value === undefined) return '';
    if (!parseStableId(prefix, value)) this.add('INVALID_ID', path, `Expected ${prefix}001-style ID.`);
    return typeof value === 'string' ? value : '';
  }
  unique(ids: string[], path: string, key: string) {
    const seen = new Set<string>();
    ids.forEach((id, i) => { if (id && seen.has(id)) this.add('DUPLICATE_ID', join(join(path, i), key), `Duplicate ID ${id}.`); seen.add(id); });
  }
  result<T>(value: T): Decoded<T> { return this.problems.length ? failed(this.problems) : okValue(value); }
}

// ---- MutationInput ----------------------------------------------------------------------------

const MUTATION_KEYS = ['repo', 'epicIssue', 'operationId', 'expectedRevision', 'expectedBodySha256'] as const;
export type FieldDecoders<X> = {[K in keyof X]: {optional?: boolean; decode: (r: InputReader, value: unknown, path: string) => X[K]}};
export type InputReader = Reader;

/** Decodes MutationInput plus tool-specific fields. Unknown keys (approved/force/command…) are always rejected. */
export function decodeMutationInput<X extends object = Record<never, never>>(value: unknown, extra?: FieldDecoders<X>): Decoded<MutationInput & X> {
  const r = new Reader();
  const extraKeys = Object.keys(extra ?? {});
  const required = [...MUTATION_KEYS, ...extraKeys.filter(k => !(extra as Record<string, {optional?: boolean}>)[k]!.optional)];
  const optional = extraKeys.filter(k => (extra as Record<string, {optional?: boolean}>)[k]!.optional);
  const o = r.object(value, '', required, optional);
  if (!o) return r.result(undefined as never);
  const out: Rec = {
    repo: r.pattern(o.repo, 'repo', isRepoRef, 'OWNER/REPO'),
    epicIssue: r.int(o.epicIssue, 'epicIssue'),
    operationId: r.pattern(o.operationId, 'operationId', isUuid, 'a lowercase random UUID'),
    expectedRevision: r.int(o.expectedRevision, 'expectedRevision'),
    expectedBodySha256: r.pattern(o.expectedBodySha256, 'expectedBodySha256', isSha256, '64 lowercase hex characters'),
  };
  for (const key of extraKeys) {
    const field = (extra as Record<string, {decode: (r: Reader, v: unknown, p: string) => unknown}>)[key]!;
    if (o[key] !== undefined) out[key] = field.decode(r, o[key], key);
  }
  return r.result(out as MutationInput & X);
}

// ---- documents --------------------------------------------------------------------------------

function originalRequest(r: Reader, v: unknown, p: string): OriginalRequest {
  const o = r.object(v, p, ['text', 'sourceRefs']) ?? {};
  return {text: r.text(o.text, join(p, 'text')), sourceRefs: r.texts(o.sourceRefs, join(p, 'sourceRefs'))};
}
function requirement(r: Reader, v: unknown, p: string): Requirement {
  const o = r.object(v, p, ['id', 'description']) ?? {};
  return {id: r.stableId('REQ', o.id, join(p, 'id')), description: r.text(o.description, join(p, 'description'))};
}
function criterion(r: Reader, v: unknown, p: string): Criterion {
  const o = r.object(v, p, ['id', 'requirementIds', 'verification', 'expectedResult']) ?? {};
  const ids = r.array(o.requirementIds, join(p, 'requirementIds'), (x, q) => r.stableId('REQ', x, q));
  if (Array.isArray(o.requirementIds) && !o.requirementIds.length) r.add('EMPTY', join(p, 'requirementIds'), 'At least one requirement is required.');
  ids.forEach((id, i) => { if (ids.indexOf(id) !== i) r.add('DUPLICATE_ID', join(join(p, 'requirementIds'), i), `Duplicate reference ${id}.`); });
  return {id: r.stableId('AC', o.id, join(p, 'id')), requirementIds: ids, verification: r.text(o.verification, join(p, 'verification')), expectedResult: r.text(o.expectedResult, join(p, 'expectedResult'))};
}
function decision(r: Reader, v: unknown, p: string): Decision {
  const o = r.object(v, p, ['id', 'topic', 'decision', 'reason', 'sourceRefs']) ?? {};
  return {id: r.stableId('D', o.id, join(p, 'id')), topic: r.text(o.topic, join(p, 'topic')), decision: r.text(o.decision, join(p, 'decision')), reason: r.text(o.reason, join(p, 'reason')), sourceRefs: r.texts(o.sourceRefs, join(p, 'sourceRefs'))};
}
function question(r: Reader, v: unknown, p: string): QuestionFact {
  const o = r.object(v, p, ['questionId', 'kind', 'question', 'answer', 'required', 'sourceRef']) ?? {};
  const answer = r.nullableText(o.answer, join(p, 'answer'));
  const sourceRef = r.nullableText(o.sourceRef, join(p, 'sourceRef'));
  if (answer !== null && o.answer !== undefined && o.sourceRef === null) r.add('SOURCE_REQUIRED', join(p, 'sourceRef'), 'An answered question needs a source reference.');
  return {questionId: r.stableId('Q', o.questionId, join(p, 'questionId')), kind: r.literal(o.kind, join(p, 'kind'), ['question', 'conflict'] as const), question: r.text(o.question, join(p, 'question')), answer, required: r.bool(o.required, join(p, 'required')), sourceRef};
}
function claim(r: Reader, v: unknown, p: string): ResearchClaim {
  const o = r.object(v, p, ['researchId', 'operationId', 'sessionId', 'specBaseDigest']) ?? {};
  return {researchId: r.stableId('R', o.researchId, join(p, 'researchId')), operationId: r.pattern(o.operationId, join(p, 'operationId'), isUuid, 'UUID'), sessionId: r.text(o.sessionId, join(p, 'sessionId')), specBaseDigest: r.pattern(o.specBaseDigest, join(p, 'specBaseDigest'), isSha256, 'sha256')};
}
function research(r: Reader, v: unknown, p: string): ResearchItem {
  const o = r.object(v, p, ['researchId', 'question', 'requiredEvidence', 'doneCondition', 'state', 'claim', 'conclusion', 'evidenceRefs', 'limitations']) ?? {};
  const item: ResearchItem = {
    researchId: r.stableId('R', o.researchId, join(p, 'researchId')), question: r.text(o.question, join(p, 'question')),
    requiredEvidence: r.text(o.requiredEvidence, join(p, 'requiredEvidence')), doneCondition: r.text(o.doneCondition, join(p, 'doneCondition')),
    state: r.literal(o.state, join(p, 'state'), RESEARCH_STATES), claim: o.claim === null || o.claim === undefined ? null : claim(r, o.claim, join(p, 'claim')),
    conclusion: r.nullableText(o.conclusion, join(p, 'conclusion')), evidenceRefs: r.texts(o.evidenceRefs, join(p, 'evidenceRefs')), limitations: r.texts(o.limitations, join(p, 'limitations')),
  };
  if (item.state === 'in_progress' && o.claim === null) r.add('CLAIM_REQUIRED', join(p, 'claim'), 'In-progress research needs a claim.');
  if (item.state === 'pending' && item.claim) r.add('UNEXPECTED_CLAIM', join(p, 'claim'), 'Pending research must not hold a claim.');
  if (item.claim && item.researchId && item.claim.researchId && item.claim.researchId !== item.researchId) r.add('CLAIM_MISMATCH', join(join(p, 'claim'), 'researchId'), 'Claim belongs to another research item.');
  if (item.state === 'resolved') {
    if (o.conclusion === null) r.add('CONCLUSION_REQUIRED', join(p, 'conclusion'), 'Resolved research needs a conclusion.');
    if (Array.isArray(o.evidenceRefs) && !o.evidenceRefs.length) r.add('EVIDENCE_REQUIRED', join(p, 'evidenceRefs'), 'Resolved research needs evidence.');
  }
  return item;
}
const isRelativePath = (v: unknown) => typeof v === 'string' && v.length > 0 && !v.startsWith('/') && !v.includes('\\') && !v.includes('\0') && v.split('/').every(s => s !== '..' && s !== '.');
function designRef(r: Reader, v: unknown, p: string): DesignRef {
  const o = r.object(v, p, ['path', 'sha256', 'gitRef']) ?? {};
  return {path: r.pattern(o.path, join(p, 'path'), isRelativePath, 'a repo-relative path'), sha256: r.pattern(o.sha256, join(p, 'sha256'), isSha256, 'sha256'), gitRef: r.pattern(o.gitRef, join(p, 'gitRef'), isGitObjectId, 'a 40/64 hex commit id')};
}
function dependencyPlan(r: Reader, v: unknown, p: string): DependencyPlan {
  const o = r.object(v, p, ['version', 'nodes', 'edges']) ?? {};
  r.literal(o.version, join(p, 'version'), [1] as const, 'UNKNOWN_VERSION');
  const nodes = r.array(o.nodes, join(p, 'nodes'), (x, q) => {
    const n = r.object(x, q, ['featureKey', 'issue', 'contracts', 'startConditions', 'editScope']) ?? {};
    return {featureKey: r.stableId('F', n.featureKey, join(q, 'featureKey')), issue: r.int(n.issue, join(q, 'issue')), contracts: r.texts(n.contracts, join(q, 'contracts')), startConditions: r.texts(n.startConditions, join(q, 'startConditions')), editScope: r.texts(n.editScope, join(q, 'editScope'))};
  }, LIMITS.features);
  const edges = r.array(o.edges, join(p, 'edges'), (x, q) => {
    const e = r.object(x, q, ['from', 'to', 'reason']) ?? {};
    return {from: r.int(e.from, join(q, 'from')), to: r.int(e.to, join(q, 'to')), reason: r.text(e.reason, join(q, 'reason'))};
  });
  return {version: 1, nodes, edges};
}
function wavePlan(r: Reader, v: unknown, p: string): WavePlan {
  const o = r.object(v, p, ['version', 'assignments', 'dependencyDigest', 'featureSetDigest']) ?? {};
  r.literal(o.version, join(p, 'version'), [1] as const, 'UNKNOWN_VERSION');
  const assignments = r.array(o.assignments, join(p, 'assignments'), (x, q) => {
    const a = r.object(x, q, ['issue', 'wave']) ?? {};
    return {issue: r.int(a.issue, join(q, 'issue')), wave: r.int(a.wave, join(q, 'wave'), LIMITS.waveMin, LIMITS.waveMax, 'INVALID_WAVE')};
  }, LIMITS.features);
  return {version: 1, assignments, dependencyDigest: r.pattern(o.dependencyDigest, join(p, 'dependencyDigest'), isSha256, 'sha256'), featureSetDigest: r.pattern(o.featureSetDigest, join(p, 'featureSetDigest'), isSha256, 'sha256')};
}
function handoff(r: Reader, v: unknown, p: string): HandoffState {
  const o = r.object(v, p, ['nonceSha256', 'sourceStage', 'targetStage', 'phase', 'operationId']) ?? {};
  return {nonceSha256: r.pattern(o.nonceSha256, join(p, 'nonceSha256'), isSha256, 'sha256'), sourceStage: r.literal(o.sourceStage, join(p, 'sourceStage'), STAGES), targetStage: r.literal(o.targetStage, join(p, 'targetStage'), STAGES), phase: r.literal(o.phase, join(p, 'phase'), HANDOFF_PHASES), operationId: r.pattern(o.operationId, join(p, 'operationId'), isUuid, 'UUID')};
}
export function decodeModelBinding(r: Reader, v: unknown, p: string): ModelBinding {
  const o = r.object(v, p, ['model', 'thinking', 'reason']) ?? {};
  return {model: r.pattern(o.model, join(p, 'model'), x => typeof x === 'string' && MODEL_RE.test(x), 'provider/id'), thinking: r.literal(o.thinking, join(p, 'thinking'), THINKING_LEVELS), reason: r.text(o.reason, join(p, 'reason'))};
}
function evidenceRef(r: Reader, v: unknown, p: string): OwnedEvidenceRef {
  const o = r.object(v, p, ['relativePath', 'sha256']) ?? {};
  return {relativePath: r.pattern(o.relativePath, join(p, 'relativePath'), isRelativePath, 'a relative path inside the evidence root'), sha256: r.pattern(o.sha256, join(p, 'sha256'), isSha256, 'sha256')};
}

const HEADER = ['version', 'kind', 'workflowId', 'revision', 'createOperationId'] as const;
function header(r: Reader, o: Rec) {
  return {workflowId: r.pattern(o.workflowId, 'workflowId', isUuid, 'UUID'), revision: r.int(o.revision, 'revision'), createOperationId: r.pattern(o.createOperationId, 'createOperationId', isUuid, 'UUID')};
}

const EPIC_KEYS = [...HEADER, 'stage', 'purpose', 'originalRequest', 'background', 'questions', 'requirements', 'criteria', 'constraints', 'outOfScope', 'research', 'decisions', 'design', 'dependencyPlan', 'wavePlan', 'handoff'] as const;
function epic(r: Reader, o: Rec): EpicDocV1 {
  const h = header(r, o);
  const doc: EpicDocV1 = {
    version: 1, kind: 'epic', workflowId: h.workflowId, revision: h.revision, createOperationId: h.createOperationId,
    stage: r.literal(o.stage, 'stage', STAGES), purpose: r.text(o.purpose, 'purpose'),
    originalRequest: originalRequest(r, o.originalRequest, 'originalRequest'), background: r.nullableText(o.background, 'background'),
    questions: r.array(o.questions, 'questions', (v, p) => question(r, v, p), LIMITS.questions),
    requirements: r.array(o.requirements, 'requirements', (v, p) => requirement(r, v, p), LIMITS.requirements),
    criteria: r.array(o.criteria, 'criteria', (v, p) => criterion(r, v, p), LIMITS.criteria),
    constraints: r.nullableArray(o.constraints, 'constraints', (v, p) => r.text(v, p)),
    outOfScope: r.nullableArray(o.outOfScope, 'outOfScope', (v, p) => r.text(v, p)),
    research: r.array(o.research, 'research', (v, p) => research(r, v, p), LIMITS.research),
    decisions: r.array(o.decisions, 'decisions', (v, p) => decision(r, v, p), LIMITS.decisions),
    design: o.design === null ? null : designRef(r, o.design, 'design'),
    dependencyPlan: o.dependencyPlan === null ? null : dependencyPlan(r, o.dependencyPlan, 'dependencyPlan'),
    wavePlan: o.wavePlan === null ? null : wavePlan(r, o.wavePlan, 'wavePlan'),
    handoff: o.handoff === null ? null : handoff(r, o.handoff, 'handoff'),
  };
  r.unique(doc.questions.map(q => q.questionId), 'questions', 'questionId');
  r.unique(doc.requirements.map(q => q.id), 'requirements', 'id');
  r.unique(doc.criteria.map(q => q.id), 'criteria', 'id');
  r.unique(doc.research.map(q => q.researchId), 'research', 'researchId');
  r.unique(doc.decisions.map(q => q.id), 'decisions', 'id');
  const reqs = new Set(doc.requirements.map(q => q.id));
  doc.criteria.forEach((c, i) => c.requirementIds.forEach((id, j) => { if (id && parseStableId('REQ', id) && !reqs.has(id)) r.add('UNKNOWN_REFERENCE', `criteria[${i}].requirementIds[${j}]`, `${id} does not exist.`); }));
  return doc;
}

const FEATURE_KEYS = [...HEADER, 'featureKey', 'parentEpic', 'stage', 'purpose', 'editScope', 'outOfScope', 'designRef', 'criteria', 'bindings', 'evidenceRefs'] as const;
function feature(r: Reader, o: Rec): FeatureDocV1 {
  const h = header(r, o);
  const b = r.object(o.bindings, 'bindings', ['coding-manager', 'coder', 'tester']) ?? {};
  const doc: FeatureDocV1 = {
    version: 1, kind: 'feature', ...h, featureKey: r.stableId('F', o.featureKey, 'featureKey'), parentEpic: r.int(o.parentEpic, 'parentEpic'),
    stage: r.literal(o.stage, 'stage', STAGES), purpose: r.text(o.purpose, 'purpose'),
    editScope: r.texts(o.editScope, 'editScope'), outOfScope: r.texts(o.outOfScope, 'outOfScope'), designRef: designRef(r, o.designRef, 'designRef'),
    criteria: r.array(o.criteria, 'criteria', (v, p) => criterion(r, v, p), LIMITS.criteria),
    bindings: {'coding-manager': decodeModelBinding(r, b['coding-manager'], 'bindings.coding-manager'), coder: decodeModelBinding(r, b.coder, 'bindings.coder'), tester: decodeModelBinding(r, b.tester, 'bindings.tester')},
    evidenceRefs: r.array(o.evidenceRefs, 'evidenceRefs', (v, p) => evidenceRef(r, v, p)),
  };
  if (Array.isArray(o.criteria) && !o.criteria.length) r.add('EMPTY', 'criteria', 'At least one criterion is required.');
  r.unique(doc.criteria.map(c => c.id), 'criteria', 'id');
  return doc;
}

const TASK_KEYS = [...HEADER, 'taskKey', 'parentFeature', 'purpose', 'editScope', 'outOfScope', 'criteria', 'bindings', 'evidenceRefs'] as const;
function task(r: Reader, o: Rec): TaskDocV1 {
  const h = header(r, o);
  const b = r.object(o.bindings, 'bindings', ['coder', 'tester']) ?? {};
  const doc: TaskDocV1 = {
    version: 1, kind: 'task', ...h, taskKey: r.stableId('T', o.taskKey, 'taskKey'), parentFeature: r.int(o.parentFeature, 'parentFeature'), purpose: r.text(o.purpose, 'purpose'),
    editScope: r.texts(o.editScope, 'editScope'), outOfScope: r.texts(o.outOfScope, 'outOfScope'),
    criteria: r.array(o.criteria, 'criteria', (v, p) => criterion(r, v, p), LIMITS.criteria),
    bindings: {coder: decodeModelBinding(r, b.coder, 'bindings.coder'), tester: decodeModelBinding(r, b.tester, 'bindings.tester')},
    evidenceRefs: r.array(o.evidenceRefs, 'evidenceRefs', (v, p) => evidenceRef(r, v, p)),
  };
  r.unique(doc.criteria.map(c => c.id), 'criteria', 'id');
  return doc;
}

/** Decodes any managed document. The returned value is rebuilt in the canonical key order. */
export function decodeScaffoldDoc(value: unknown): Decoded<ScaffoldDocV1> {
  const r = new Reader();
  if (!isRecord(value)) { r.add('INVALID_TYPE', '', 'Expected an object.'); return r.result(undefined as never); }
  if (value.version !== 1) { r.add('UNKNOWN_VERSION', 'version', 'Only version 1 documents are supported.'); return r.result(undefined as never); }
  const kind = value.kind;
  const keys = kind === 'epic' ? EPIC_KEYS : kind === 'feature' ? FEATURE_KEYS : kind === 'task' ? TASK_KEYS : undefined;
  if (!keys) { r.add('INVALID_VALUE', 'kind', 'Expected epic, feature or task.'); return r.result(undefined as never); }
  const o = r.object(value, '', keys)!;
  const doc = kind === 'epic' ? epic(r, o) : kind === 'feature' ? feature(r, o) : task(r, o);
  return r.result(doc);
}
export function decodeEpicDoc(value: unknown): Decoded<EpicDocV1> {
  const d = decodeScaffoldDoc(value);
  if (!d.ok) return d;
  return d.value.kind === 'epic' ? okValue(d.value) : failed([problem('INVALID_VALUE', 'kind', 'Expected an epic document.')]);
}

export {Reader as StrictReader};
/** Field readers shared by tool input decoders (same rules as the managed document). */
export const readOriginalRequest = originalRequest;
export const readQuestionFact = question;
export const readRequirement = requirement;
export const readCriterion = criterion;
export const readDecision = decision;
export const readDesignRef = designRef;
export const readDependencyPlan = dependencyPlan;
export function readResearchSeed(r: Reader, v: unknown, p: string): ResearchItemSeed {
  const o = r.object(v, p, ['researchId', 'question', 'requiredEvidence', 'doneCondition']) ?? {};
  return {researchId: r.stableId('R', o.researchId, join(p, 'researchId')), question: r.text(o.question, join(p, 'question')), requiredEvidence: r.text(o.requiredEvidence, join(p, 'requiredEvidence')), doneCondition: r.text(o.doneCondition, join(p, 'doneCondition'))};
}
