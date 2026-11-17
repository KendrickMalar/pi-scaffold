// #4 scaffold_epic_draft_create: build a strict local Epic draft (managed block per #4 v1) and, by default,
// create it as an unfinished Epic through deterministic-gh (template kind parent, labels Type: Scaffold / Scope: Epic).
// The planner model is recorded from the session, never called. Nothing is completed or invented.
import {join} from 'node:path';
import {
  LIMITS, StrictReader, isRepoRef, isUuid, problem, readOriginalRequest, readQuestionFact, readResearchSeed, decodeEpicDoc,
  type Decoded, type EpicDocV1, type OriginalRequest, type Problem, type QuestionFact, type ResearchItemSeed, type ScaffoldResult, type TbdDocV1,
} from '../core/contracts.js';
import {renderEpicBlock, canonicalDocJson, MANAGED_START} from '../core/epic-render.js';
import {parseIssueBody} from '../core/body-codec.js';
import {sha256Text, taggedDigest} from '../core/digests.js';
import {OwnedFileError, readOwnedFile, writeOwnedFile} from '../core/files.js';
import {withOperation} from '../core/lifecycle.js';
import {buildTemplateSnapshot, TEMPLATE_FIELD, TEMPLATE_IDS} from '../core/template-snapshot.js';
import type {ToolCall} from '../core/runtime.js';
import {decodeGithubIssue, readIssue, DETERMINISTIC_GH_MASK} from '../ports/deterministic-gh.js';
import {readLabels} from './labels-ensure.js';
import {PLAN_PENDING_LABEL} from '../core/epic-wait.js';

export const EPIC_DRAFT_CREATE = 'scaffold_epic_draft_create';
export const EPIC_LABELS = ['Type: Scaffold', 'Scope: Epic'] as const;
const TBD_LABEL = 'Scope: TBD';
export interface EpicDraftInput {
  repo: string; operationId: string; title: string; purpose: string;
  /** Required unless tbdIssue is given; then it defaults to the TBD's request (managed block, or title and body). */
  originalRequest?: OriginalRequest;
  background?: string | null; initialFacts?: QuestionFact[]; research?: ResearchItemSeed[]; mode?: 'prepare' | 'publish';
  /** TBD Issue (same repository, label Scope: TBD, open) this Epic is created from. It is closed once the Epic exists. */
  tbdIssue?: number;
}
export interface EpicDraftData {
  draftRef: {path: string; sha256: string}; workflowId: string; missingFields: string[]; issue?: {number: number; url: string};
  tbd?: {number: number; url: string; closed: boolean};
}

export function decodeEpicDraftInput(value: unknown): Decoded<EpicDraftInput> {
  const r = new StrictReader();
  const o = r.object(value, '', ['repo', 'operationId', 'title', 'purpose'], ['originalRequest', 'background', 'initialFacts', 'research', 'mode', 'tbdIssue']);
  if (!o) return r.result(undefined as never);
  const input: EpicDraftInput = {
    repo: r.pattern(o.repo, 'repo', isRepoRef, 'OWNER/REPO'), operationId: r.pattern(o.operationId, 'operationId', isUuid, 'a lowercase random UUID'),
    title: r.text(o.title, 'title'), purpose: r.text(o.purpose, 'purpose'),
  };
  if (o.tbdIssue !== undefined) input.tbdIssue = r.int(o.tbdIssue, 'tbdIssue');
  if (o.originalRequest !== undefined) input.originalRequest = readOriginalRequest(r, o.originalRequest, 'originalRequest');
  else if (o.tbdIssue === undefined) r.add('REQUIRED', 'originalRequest', 'Required field is missing (or give tbdIssue).');
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

function buildDoc(input: EpicDraftInput & {originalRequest: OriginalRequest}, workflowId: string): EpicDocV1 {
  return {
    version: 1, kind: 'epic', workflowId, revision: 1, createOperationId: input.operationId, stage: 'setup',
    purpose: input.purpose, originalRequest: input.originalRequest, background: input.background ?? null,
    questions: input.initialFacts ?? [], requirements: [], criteria: [], constraints: null, outOfScope: null,
    research: (input.research ?? []).map(s => ({...s, state: 'pending' as const, claim: null, conclusion: null, evidenceRefs: [], limitations: []})),
    decisions: [], design: null, dependencyPlan: null, wavePlan: null, handoff: null,
    ...(input.tbdIssue !== undefined ? {sourceTbd: input.tbdIssue} : {}),
  };
}

interface RawTbd { number: number; url: string; title: string; body: string; state: 'open' | 'closed'; labels: string[] }
/** Reads a TBD Issue as raw text (it may have no managed block). */
async function readTbd(call: ToolCall, repo: string, number: number): Promise<RawTbd | Problem[]> {
  const r = await call.bridge.call('gh_issue_get', {repo, issue: number}, decodeGithubIssue, call.scope);
  if (r.status !== 'ok') return r.problems.length ? r.problems : [problem('TBD_NOT_FOUND', 'tbdIssue', `#${number} could not be read.`)];
  const i = r.data!;
  const url = `https://github.com/${repo}/issues/${number}`;
  if (i.pull_request !== undefined || i.number !== number || i.html_url.toLowerCase() !== url.toLowerCase()) return [problem('GITHUB_IDENTITY', 'tbdIssue', 'Expected exactly this repository Issue (not a PR).')];
  if ((i.body ?? '').includes(DETERMINISTIC_GH_MASK) || i.title.includes(DETERMINISTIC_GH_MASK)) return [problem('BODY_MASKED', 'tbdIssue', 'deterministic-gh redacted part of this TBD as a secret candidate; remove the secret-like text first.')];
  return {number, url: i.html_url, title: i.title, body: i.body ?? '', state: i.state, labels: i.labels};
}
/** Fills the fields the caller omitted from the TBD: its managed block, or its title and body as the original request. */
function fromTbd(input: EpicDraftInput, tbd: RawTbd): {ok: true; value: EpicDraftInput & {originalRequest: OriginalRequest}} | {ok: false; problems: Problem[]} {
  let doc: TbdDocV1 | undefined;
  if (tbd.body.split('\n').some(l => l.replace(/\r$/, '') === MANAGED_START)) {
    const p = parseIssueBody(tbd.body);
    if (!p.ok) return {ok: false, problems: p.problems.map(x => ({...x, path: 'tbdIssue.' + x.path}))};
    if (p.value.doc.kind !== 'tbd') return {ok: false, problems: [problem('NOT_A_TBD', 'tbdIssue', `#${tbd.number} carries a ${p.value.doc.kind} document, not a TBD.`)]};
    doc = p.value.doc;
  }
  const request = input.originalRequest ?? doc?.originalRequest ?? {text: tbd.body.trim() ? `${tbd.title}\n\n${tbd.body.trim()}` : tbd.title, sourceRefs: []};
  const sourceRefs = request.sourceRefs.includes(tbd.url) ? request.sourceRefs : [...request.sourceRefs, tbd.url];
  return {ok: true, value: {
    ...input, originalRequest: {text: request.text, sourceRefs},
    ...(input.background === undefined && doc ? {background: doc.background} : {}),
    ...(input.initialFacts === undefined && doc ? {initialFacts: doc.questions} : {}),
    ...(input.research === undefined && doc ? {research: doc.research} : {}),
  }};
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
  if (JSON.stringify(input).includes(DETERMINISTIC_GH_MASK)) return blocked([problem('UNREADABLE_TEXT', '', `Input contains "${DETERMINISTIC_GH_MASK}", which deterministic-gh uses for redaction; the Epic could not be read back. Rephrase it.`)]);
  const planner = call.env.currentModel();
  if (!planner) return blocked([problem('PLANNER_UNKNOWN', 'planner', 'The session model/thinking level is unknown; the planner cannot be recorded. No model is changed or called.')]);
  const mode = input.mode ?? 'publish';
  const fromTbdOps = input.tbdIssue === undefined ? [] : mode === 'prepare' ? ['gh_issue_get'] : ['gh_issue_close_if_current'];
  const caps = mode === 'prepare'
    ? await call.bridge.requireCapabilities(['gh_issue_validate', ...fromTbdOps], call.scope)
    : await call.bridge.requireCapabilities(['gh_issue_validate', 'gh_issue_submit', 'gh_issue_list', 'gh_issue_get', 'gh_labels_list', ...fromTbdOps], call.scope, ['issue-list-labels']);
  if (!caps.ok) return {status: caps.problems.some(p => p.code === 'STALE_SCOPE') ? 'cancelled' : 'blocked', operation, problems: caps.problems};
  // Each Epic is its own workflow: its journal and artifacts never hold up other Epics or repository label setup.
  const workflowId = workflowIdFor(input.operationId);
  const context = await call.repoContext(input.repo, workflowId);
  if (!context.ok) return blocked(context.problems);
  const dir = join(context.value.workflowStateRoot, 'artifacts', input.operationId);
  // The TBD as this operation first read it. Resumes build the same Epic from it even if the TBD was edited since.
  const tbdPath = join(dir, 'tbd.json');
  let tbd: RawTbd | undefined, tbdLive: RawTbd | undefined, tbdRecorded = false;
  let full: EpicDraftInput & {originalRequest: OriginalRequest};
  if (input.tbdIssue !== undefined) {
    const read = await readTbd(call, input.repo, input.tbdIssue);
    if (Array.isArray(read)) return blocked(read);
    tbdLive = read;
    if (!tbdLive.labels.includes(TBD_LABEL)) return blocked([problem('NOT_A_TBD', 'tbdIssue', `#${tbdLive.number} has no ${TBD_LABEL} label.`)]);
    try { tbd = JSON.parse((await readOwnedFile(tbdPath, {root: call.namespaceRoot})).toString('utf8')) as RawTbd; tbdRecorded = true; }
    catch (e) { if (!(e instanceof OwnedFileError && e.code === 'NOT_FOUND')) return blocked([problem('RECORDED_DRAFT_INVALID', 'tbdIssue', `The recorded TBD of this operation (${tbdPath}) is unreadable.`)]); tbd = tbdLive; }
    const filled = fromTbd(input, tbd);
    if (!filled.ok) return blocked(filled.problems);
    full = filled.value;
  } else full = input as EpicDraftInput & {originalRequest: OriginalRequest};
  const doc = buildDoc(full, workflowId);
  const decoded = decodeEpicDoc(doc);
  if (!decoded.ok) return blocked(decoded.problems);
  if (Buffer.byteLength(canonicalDocJson(doc)) > LIMITS.jsonBytes) return blocked([problem('LIMIT_EXCEEDED', 'json', `Managed JSON exceeds ${LIMITS.jsonBytes} bytes.`)]);
  const block = renderEpicBlock(doc);
  if (Buffer.byteLength(block) > LIMITS.bodyBytes - 1024) return blocked([problem('LIMIT_EXCEEDED', 'body', 'The Epic body would exceed the Issue body limit.')]);

  const draftPath = join(dir, 'draft.json');
  const journal = call.journal(context.value);
  // The operation is bound to the normalized content (defaults applied), never to the session model.
  const payloadDigest = taggedDigest('epic-draft', {repo: input.repo, title: input.title, doc: JSON.parse(canonicalDocJson(doc))});
  const record = await journal.load(input.operationId);
  if (record && record.payloadDigest !== payloadDigest) return blocked([problem('OPERATION_PAYLOAD_MISMATCH', 'operationId', 'This operationId was already used with different content.')]);
  // A closed TBD is turned into an Epic only by the operation that already created (or found) that Epic.
  const epicKnown = !!record?.steps.some(s => (s.name === 'submit' || s.name === 'found') && s.phase !== 'failed');
  if (tbdLive && tbdLive.state === 'closed' && !epicKnown) return blocked([problem('TBD_CLOSED', 'tbdIssue', `#${tbdLive.number} is already closed.`)]);
  if (tbd && !tbdRecorded && mode === 'publish') await writeOwnedFile(tbdPath, JSON.stringify(tbd), {root: call.namespaceRoot});
  let recorded: {agents?: {planner?: {model: string; thinking: string; reason: string}}} | undefined;
  if (record) {
    const invalid = () => blocked([problem('RECORDED_DRAFT_INVALID', 'draft', `The recorded draft of this operation (${draftPath}) is unreadable. Check whether the Epic was created before using another operationId.`)]);
    try { recorded = JSON.parse((await readOwnedFile(draftPath, {root: call.namespaceRoot})).toString('utf8')); }
    catch (e) { if (!(e instanceof OwnedFileError && e.code === 'NOT_FOUND')) return invalid(); }
    const p = recorded?.agents?.planner;
    if (recorded && (typeof p?.model !== 'string' || typeof p.thinking !== 'string' || typeof p.reason !== 'string')) return invalid();
  }
  // A recorded operation keeps the planner of its first call, so its draft and policy snapshot stay consistent.
  const plannerBinding = recorded?.agents?.planner ?? {model: planner.model, thinking: planner.thinking, reason: 'Epic下書きを作成したセッションのモデル（記録のみ）'};
  const snapshot = await buildTemplateSnapshot('epic', {planner: plannerBinding as never}, join(dir, 'template'), call.namespaceRoot);
  // The orchestrator marks Epics it launched a session for, so they wait for its plan (SCAFFOLD_PLAN_PENDING=1).
  const planPending = call.environment?.().SCAFFOLD_PLAN_PENDING === '1';
  const epicLabels: string[] = planPending ? [...EPIC_LABELS, PLAN_PENDING_LABEL] : [...EPIC_LABELS];
  const draft = {version: 1, template: TEMPLATE_IDS.epic, repo: input.repo, title: input.title, labels: epicLabels, fields: {[TEMPLATE_FIELD]: block}, agents: {planner: plannerBinding}};
  const draftText = JSON.stringify(draft, null, 2) + '\n';
  await writeOwnedFile(draftPath, draftText, {root: call.namespaceRoot});
  const args = {draftPath, templatePath: snapshot.templatePath};
  const base: EpicDraftData = {draftRef: {path: draftPath, sha256: sha256Text(draftText)}, workflowId, missingFields: missingFields(doc)};

  const validated = await call.bridge.call('gh_issue_validate', args, () => true as const, call.scope);
  if (validated.status !== 'ok') return {status: validated.status === 'cancelled' ? 'cancelled' : 'blocked', operation, problems: validated.problems};
  if (mode === 'prepare') return {status: 'prepared', operation, data: base, problems: []};

  const labels = await readLabels(call, input.repo);
  if ('error' in labels) return blocked(labels.error);
  const absent = epicLabels.filter(l => labels.labels.get(l.toLowerCase())?.name !== l);
  if (absent.length) return blocked([problem('LABELS_NOT_READY', 'labels', `Management labels are missing (${absent.join(', ')}); run scaffold_labels_ensure first.${planPending ? ` ${PLAN_PENDING_LABEL} is created by the orchestrator, not by scaffold_labels_ensure.` : ''}`)]);

  /** Readable managed Epics of the repository (number and document). */
  const epics = async (): Promise<{number: number; doc: EpicDocV1}[] | Problem[]> => {
    const r = await call.bridge.call('gh_issue_list', {repo: input.repo, state: 'all', labels: [...EPIC_LABELS]}, decodeIssueList, call.scope);
    if (r.status !== 'ok' || r.data!.some(i => !i)) return r.problems.length ? r.problems : [problem('ISSUE_LIST_FAILED', 'issues', 'Issues could not be listed completely.')];
    return r.data!.flatMap(i => { const p = parseIssueBody(i!.body ?? ''); return p.ok && p.value.doc.kind === 'epic' ? [{number: i!.number, doc: p.value.doc}] : []; });
  };
  /** Issues whose managed body carries this operation's createOperationId. */
  const candidates = async (): Promise<{number: number}[] | Problem[]> => {
    const all = await epics();
    if (all.length && 'code' in all[0]!) return all as Problem[];
    // Only a readable managed Epic created by this operation counts; mentions of the id elsewhere are ignored.
    return (all as {number: number; doc: EpicDocV1}[]).filter(e => e.doc.createOperationId === input.operationId).map(e => ({number: e.number}));
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
      // One TBD becomes one Epic: an Epic another operation made from the same TBD stops this one before it posts.
      if (found === undefined && input.tbdIssue !== undefined) {
        const all = await epics();
        if (all.length && 'code' in all[0]!) return run.stop(all as Problem[], base);
        const other = (all as {number: number; doc: EpicDocV1}[]).filter(e => e.doc.sourceTbd === input.tbdIssue);
        if (other.length) return run.stop([problem('TBD_ALREADY_HAS_EPIC', 'tbdIssue', `TBD #${input.tbdIssue} already has Epic ${other.map(e => '#' + e.number).join(', ')} from another operation; resume that operation instead of starting a new one.`)], base);
      }
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
    if (managed.slice().sort().join('\n') !== [...EPIC_LABELS].sort().join('\n')) return run.stop([problem('EPIC_LABELS_INCOMPLETE', 'labels', `#${number} has managed labels [${managed.join(', ')}] instead of exactly Type: Scaffold and Scope: Epic. Repairing them needs a conditional label change (deterministic-gh #6); the Epic is not created again.`)], data);
    if (!tbd) return {status: reused ? 'noop' : 'applied', data};
    // The TBD has become this Epic: close it, conditioned on the body this operation read (recorded once, reused on resume).
    const t = tbd;
    const reread = async () => { const x = await readTbd(call, input.repo, t.number); if (Array.isArray(x)) return run.stop(x, data); return x; };
    const closeStep = run.record.steps.find(s => s.name === 'close-tbd');
    const closePending = closeStep?.phase === 'requested' || closeStep?.phase === 'unknown';
    let current = await reread();
    // Closed by anyone (and no close of ours in doubt) is enough: a TBD closed by hand is not closed again.
    if (current.state !== 'closed' || closePending) {
      const path = join(dir, 'close-tbd.json');
      const expectedBody = sha256Text(t.body);
      await writeOwnedFile(path, JSON.stringify({version: 1, repo: input.repo, operation: 'issue-close-if-current', issue: t.number, reason: 'completed', expectedBodySha256: expectedBody}), {root: call.namespaceRoot});
      try {
        await run.write('close-tbd', () => call.bridge.call('gh_issue_close_if_current', {changePath: path}, () => true as const, call.scope), {
          reconcile: async () => { const s = await reread(); return s.state === 'closed' ? 'applied' : 'not-applied'; },
        });
      } catch (e) {
        // Keep reporting the created Epic when closing the TBD stops (an uncertain step still ends as unknown).
        const stopped = e as {problems?: Problem[]};
        if (Array.isArray(stopped?.problems)) run.stop(stopped.problems, data);
        throw e;
      }
      current = await reread();
    }
    if (current.state !== 'closed') return run.stop([problem('TBD_NOT_CLOSED', 'tbdIssue', `The Epic #${number} exists but TBD #${t.number} is still open.`)], data);
    return {status: reused ? 'noop' : 'applied', data: {...data, tbd: {number: t.number, url: t.url, closed: true}}};
  });
  return result as ScaffoldResult<EpicDraftData>;
}
