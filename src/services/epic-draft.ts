// #4 scaffold_epic_draft_create: build a strict local Epic draft (managed block per #4 v1) and, by default,
// create it as an unfinished Epic through pi-gh (template kind parent, labels Type: Scaffold / Scope: Epic).
// The planner model is recorded from the session, never called. Nothing is completed or invented.
import {join} from 'node:path';
import {
  LIMITS, StrictReader, isRepoRef, isUuid, problem, readOriginalRequest, readQuestionFact, readResearchSeed, decodeEpicDoc,
  type Decoded, type EpicDocV1, type OriginalRequest, type Problem, type QuestionFact, type ResearchItemSeed, type ScaffoldResult,
} from '../core/contracts.js';
import {renderEpicBlock, canonicalDocJson} from '../core/epic-render.js';
import {parseIssueBody} from '../core/body-codec.js';
import {sha256Text, taggedDigest} from '../core/digests.js';
import {OwnedFileError, readOwnedFile, writeOwnedFile} from '../core/files.js';
import {withOperation} from '../core/lifecycle.js';
import {buildTemplateSnapshot, TEMPLATE_FIELD, TEMPLATE_IDS} from '../core/template-snapshot.js';
import type {ToolCall} from '../core/runtime.js';
import {decodeGithubIssue, readIssue, PI_GH_MASK} from '../ports/pi-gh.js';
import {readLabels} from './labels-ensure.js';

export const EPIC_DRAFT_CREATE = 'scaffold_epic_draft_create';
export const EPIC_LABELS = ['Type: Scaffold', 'Scope: Epic'] as const;
export interface EpicDraftInput {
  repo: string; operationId: string; title: string; purpose: string; originalRequest: OriginalRequest;
  background?: string | null; initialFacts?: QuestionFact[]; research?: ResearchItemSeed[]; mode?: 'prepare' | 'publish';
}
export interface EpicDraftData { draftRef: {path: string; sha256: string}; workflowId: string; missingFields: string[]; issue?: {number: number; url: string} }

export function decodeEpicDraftInput(value: unknown): Decoded<EpicDraftInput> {
  const r = new StrictReader();
  const o = r.object(value, '', ['repo', 'operationId', 'title', 'purpose', 'originalRequest'], ['background', 'initialFacts', 'research', 'mode']);
  if (!o) return r.result(undefined as never);
  const input: EpicDraftInput = {
    repo: r.pattern(o.repo, 'repo', isRepoRef, 'OWNER/REPO'), operationId: r.pattern(o.operationId, 'operationId', isUuid, 'a lowercase random UUID'),
    title: r.text(o.title, 'title'), purpose: r.text(o.purpose, 'purpose'), originalRequest: readOriginalRequest(r, o.originalRequest, 'originalRequest'),
  };
  if (typeof o.title === 'string' && (/[\r\n\u0000-\u001f\u007f]/.test(o.title) || Array.from(o.title).length > 256)) r.add('INVALID_FORMAT', 'title', 'Title must be a single line of at most 256 characters.');
  if (o.background !== undefined) input.background = r.nullableText(o.background, 'background');
  if (o.initialFacts !== undefined) input.initialFacts = r.array(o.initialFacts, 'initialFacts', (v, p) => readQuestionFact(r, v, p), LIMITS.questions);
  if (o.research !== undefined) input.research = r.array(o.research, 'research', (v, p) => readResearchSeed(r, v, p), LIMITS.research);
  if (o.mode !== undefined) input.mode = r.literal(o.mode, 'mode', ['prepare', 'publish'] as const);
  r.unique((input.initialFacts ?? []).map(q => q.questionId), 'initialFacts', 'questionId');
  r.unique((input.research ?? []).map(q => q.researchId), 'research', 'researchId');
  return r.result(input);
}

/** Stable per operation, so prepare and publish (and retries) of one operation share one workflow. */
export function workflowIdFor(operationId: string): string {
  const h = taggedDigest('workflow-id', operationId);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16]!, 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function missingFields(doc: EpicDocV1): string[] {
  return [
    ...(doc.background === null ? ['background'] : []), ...(doc.requirements.length ? [] : ['requirements']), ...(doc.criteria.length ? [] : ['criteria']),
    ...(doc.constraints === null ? ['constraints'] : []), ...(doc.outOfScope === null ? ['outOfScope'] : []),
  ];
}

function buildDoc(input: EpicDraftInput, workflowId: string): EpicDocV1 {
  return {
    version: 1, kind: 'epic', workflowId, revision: 1, createOperationId: input.operationId, stage: 'setup',
    purpose: input.purpose, originalRequest: input.originalRequest, background: input.background ?? null,
    questions: input.initialFacts ?? [], requirements: [], criteria: [], constraints: null, outOfScope: null,
    research: (input.research ?? []).map(s => ({...s, state: 'pending' as const, claim: null, conclusion: null, evidenceRefs: [], limitations: []})),
    decisions: [], design: null, dependencyPlan: null, wavePlan: null, handoff: null,
  };
}

const decodeIssueList = (d: unknown) => Array.isArray(d) ? d.map(decodeGithubIssue) : undefined;
const decodeCreated = (repo: string) => (d: unknown) => {
  const url = (d as {url?: unknown} | null)?.url;
  const m = typeof url === 'string' ? new RegExp(`^https://github\\.com/${repo.replace('.', '\\.')}/issues/([1-9][0-9]*)$`, 'i').exec(url) : null;
  return m ? {number: Number(m[1]), url: url as string} : undefined;
};

export async function createEpicDraft(input: EpicDraftInput, call: ToolCall): Promise<ScaffoldResult<EpicDraftData>> {
  const operation = EPIC_DRAFT_CREATE;
  const blocked = (problems: Problem[]): ScaffoldResult<EpicDraftData> => ({status: 'blocked', operation, problems});
  if (JSON.stringify(input).includes(PI_GH_MASK)) return blocked([problem('UNREADABLE_TEXT', '', `Input contains "${PI_GH_MASK}", which pi-gh uses for redaction; the Epic could not be read back. Rephrase it.`)]);
  const planner = call.env.currentModel();
  if (!planner) return blocked([problem('PLANNER_UNKNOWN', 'planner', 'The session model/thinking level is unknown; the planner cannot be recorded. No model is changed or called.')]);
  const mode = input.mode ?? 'publish';
  const caps = mode === 'prepare'
    ? await call.bridge.requireCapabilities(['gh_issue_validate'], call.scope)
    : await call.bridge.requireCapabilities(['gh_issue_validate', 'gh_issue_submit', 'gh_issue_list', 'gh_issue_get', 'gh_labels_list'], call.scope, ['issue-list-labels']);
  if (!caps.ok) return {status: caps.problems.some(p => p.code === 'STALE_SCOPE') ? 'cancelled' : 'blocked', operation, problems: caps.problems};
  // Each Epic is its own workflow: its journal and artifacts never hold up other Epics or repository label setup.
  const workflowId = workflowIdFor(input.operationId);
  const context = await call.repoContext(input.repo, workflowId);
  if (!context.ok) return blocked(context.problems);
  const doc = buildDoc(input, workflowId);
  const decoded = decodeEpicDoc(doc);
  if (!decoded.ok) return blocked(decoded.problems);
  if (Buffer.byteLength(canonicalDocJson(doc)) > LIMITS.jsonBytes) return blocked([problem('LIMIT_EXCEEDED', 'json', `Managed JSON exceeds ${LIMITS.jsonBytes} bytes.`)]);
  const block = renderEpicBlock(doc);
  if (Buffer.byteLength(block) > LIMITS.bodyBytes - 1024) return blocked([problem('LIMIT_EXCEEDED', 'body', 'The Epic body would exceed the Issue body limit.')]);

  const dir = join(context.value.workflowStateRoot, 'artifacts', input.operationId);
  const draftPath = join(dir, 'draft.json');
  const journal = call.journal(context.value);
  // The operation is bound to the normalized content (defaults applied), never to the session model.
  const payloadDigest = taggedDigest('epic-draft', {repo: input.repo, title: input.title, doc: JSON.parse(canonicalDocJson(doc))});
  const record = await journal.load(input.operationId);
  if (record && record.payloadDigest !== payloadDigest) return blocked([problem('OPERATION_PAYLOAD_MISMATCH', 'operationId', 'This operationId was already used with different content.')]);
  let recorded: {agents?: {planner?: {model: string; thinking: string; reason: string}}} | undefined;
  if (record) {
    try { recorded = JSON.parse((await readOwnedFile(draftPath, {root: call.namespaceRoot})).toString('utf8')); }
    catch (e) { if (!(e instanceof OwnedFileError && e.code === 'NOT_FOUND')) throw e; }
  }
  // A recorded operation keeps the planner of its first call, so its draft and policy snapshot stay consistent.
  const plannerBinding = recorded?.agents?.planner ?? {model: planner.model, thinking: planner.thinking, reason: 'Epic下書きを作成したセッションのモデル（記録のみ）'};
  const snapshot = await buildTemplateSnapshot('epic', {planner: plannerBinding as never}, join(dir, 'template'), call.namespaceRoot);
  const draft = {version: 1, template: TEMPLATE_IDS.epic, repo: input.repo, title: input.title, labels: [...EPIC_LABELS], fields: {[TEMPLATE_FIELD]: block}, agents: {planner: plannerBinding}};
  const draftText = JSON.stringify(draft, null, 2) + '\n';
  await writeOwnedFile(draftPath, draftText, {root: call.namespaceRoot});
  const args = {draftPath, templatePath: snapshot.templatePath};
  const base: EpicDraftData = {draftRef: {path: draftPath, sha256: sha256Text(draftText)}, workflowId, missingFields: missingFields(doc)};

  const validated = await call.bridge.call('gh_issue_validate', args, () => true as const, call.scope);
  if (validated.status !== 'ok') return {status: validated.status === 'cancelled' ? 'cancelled' : 'blocked', operation, problems: validated.problems};
  if (mode === 'prepare') return {status: 'prepared', operation, data: base, problems: []};

  const labels = await readLabels(call, input.repo);
  if ('error' in labels) return blocked(labels.error);
  const absent = EPIC_LABELS.filter(l => labels.labels.get(l.toLowerCase())?.name !== l);
  if (absent.length) return blocked([problem('LABELS_NOT_READY', 'labels', `Management labels are missing (${absent.join(', ')}); run scaffold_labels_ensure first.`)]);

  /** Issues whose managed body carries this operation's createOperationId. */
  const candidates = async (): Promise<{number: number}[] | Problem[]> => {
    const r = await call.bridge.call('gh_issue_list', {repo: input.repo, state: 'all', labels: [...EPIC_LABELS]}, decodeIssueList, call.scope);
    if (r.status !== 'ok' || r.data!.some(i => !i)) return r.problems.length ? r.problems : [problem('ISSUE_LIST_FAILED', 'issues', 'Issues could not be listed completely.')];
    // Only a readable managed Epic created by this operation counts; mentions of the id elsewhere are ignored.
    return r.data!.filter(i => i!.body?.includes(input.operationId)).filter(i => { const p = parseIssueBody(i!.body ?? ''); return p.ok && p.value.doc.kind === 'epic' && p.value.doc.createOperationId === input.operationId; }).map(i => ({number: i!.number}));
  };
  const result = await withOperation({operation, repo: input.repo, workflowId, operationId: input.operationId, payloadDigest, journal, scope: call.scope}, async run => {
    let found: number | undefined;
    const pending = run.record.steps.some(s => s.name === 'submit' && (s.phase === 'requested' || s.phase === 'unknown'));
    let issue = run.done('submit') as {number: number; url: string} | undefined;
    let reused = false;
    if (!issue && !pending) {
      const c = await candidates();
      if (c.length && 'code' in c[0]!) return run.stop(c as Problem[], base);
      if (c.length > 1) return run.stop([problem('DUPLICATE_CANDIDATES', 'issues', `Several Issues (${(c as {number: number}[]).map(x => '#' + x.number).join(', ')}) carry this operation; choose one manually.`)], base);
      if (c.length === 1) { found = (c[0] as {number: number}).number; reused = true; run.note('found', {number: found}); }
    }
    if (!issue && found === undefined) {
      const created = await run.write('submit', () => call.bridge.call('gh_issue_submit', args, decodeCreated(input.repo), call.scope), {
        reconcile: async () => {
          const c = await candidates();
          if (c.length === 1 && !('code' in c[0]!)) { found = (c[0] as {number: number}).number; return 'applied'; }
          return 'unknown';
        },
      });
      if (created) issue = created;
    }
    const number = issue?.number ?? found ?? (run.done('found') as {number: number} | undefined)?.number;
    if (number === undefined) return run.stop([problem('ISSUE_NOT_FOUND', 'issue', 'The created Issue could not be identified.')], base);
    const url = `https://github.com/${input.repo}/issues/${number}`;
    const data: EpicDraftData = {...base, issue: {number, url}};
    const snap = await readIssue(input.repo, number, call.bridge, call.scope);
    if (!snap.ok) return run.stop(snap.problems, data);
    const d = snap.value.doc;
    if (d.kind !== 'epic' || d.createOperationId !== input.operationId || d.workflowId !== workflowId) return run.stop([problem('EPIC_IDENTITY', 'issue', `#${number} is not the Epic created by this operation.`)], data);
    const managed = snap.value.labels.filter(l => /^(Type|Scope|Stage|Wave): /.test(l) || l === 'Blocked');
    if (managed.slice().sort().join('\n') !== [...EPIC_LABELS].sort().join('\n')) return run.stop([problem('EPIC_LABELS_INCOMPLETE', 'labels', `#${number} has managed labels [${managed.join(', ')}] instead of exactly Type: Scaffold and Scope: Epic. Repairing them needs a conditional label change (pi-gh #6); the Epic is not created again.`)], data);
    return {status: reused ? 'noop' : 'applied', data};
  });
  return result as ScaffoldResult<EpicDraftData>;
}
