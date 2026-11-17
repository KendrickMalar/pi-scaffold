// scaffold_tbd_create: record a request as a TBD Issue (labels Type: Scaffold / Scope: TBD) before the setup stage.
// Same publishing path as scaffold_epic_draft_create (template snapshot → validate → submit → read back); the same
// operationId always returns the same Issue. The session model is recorded as planner, never called.
import {join} from 'node:path';
import {
  LIMITS, StrictReader, isRepoRef, isUuid, problem, readOriginalRequest, readQuestionFact, readResearchSeed, decodeScaffoldDoc,
  type Decoded, type OriginalRequest, type Problem, type QuestionFact, type ResearchItemSeed, type ScaffoldResult, type TbdDocV1,
} from '../core/contracts.js';
import {renderTbdBlock, canonicalDocJson} from '../core/epic-render.js';
import {parseIssueBody} from '../core/body-codec.js';
import {taggedDigest} from '../core/digests.js';
import {OwnedFileError, readOwnedFile, writeOwnedFile} from '../core/files.js';
import {withOperation} from '../core/lifecycle.js';
import {buildTemplateSnapshot, TEMPLATE_FIELD, TEMPLATE_IDS} from '../core/template-snapshot.js';
import type {ToolCall} from '../core/runtime.js';
import {decodeGithubIssue, readIssue, DETERMINISTIC_GH_MASK} from '../ports/deterministic-gh.js';
import {readLabels} from './labels-ensure.js';
import {workflowIdFor} from './epic-draft.js';

export const TBD_CREATE = 'scaffold_tbd_create';
export const TBD_LABELS = ['Type: Scaffold', 'Scope: TBD'] as const;
export interface TbdCreateInput {
  repo: string; operationId: string; title: string; originalRequest: OriginalRequest;
  background?: string | null; initialFacts?: QuestionFact[]; research?: ResearchItemSeed[];
}
export interface TbdCreateData { workflowId: string; issue?: {number: number; url: string} }

export function decodeTbdCreateInput(value: unknown): Decoded<TbdCreateInput> {
  const r = new StrictReader();
  const o = r.object(value, '', ['repo', 'operationId', 'title', 'originalRequest'], ['background', 'initialFacts', 'research']);
  if (!o) return r.result(undefined as never);
  const input: TbdCreateInput = {
    repo: r.pattern(o.repo, 'repo', isRepoRef, 'OWNER/REPO'), operationId: r.pattern(o.operationId, 'operationId', isUuid, 'a lowercase random UUID'),
    title: r.text(o.title, 'title'), originalRequest: readOriginalRequest(r, o.originalRequest, 'originalRequest'),
  };
  if (typeof o.title === 'string' && (/[\r\n\u0000-\u001f\u007f]/.test(o.title) || Array.from(o.title).length > 256)) r.add('INVALID_FORMAT', 'title', 'Title must be a single line of at most 256 characters.');
  if (o.background !== undefined) input.background = r.nullableText(o.background, 'background');
  if (o.initialFacts !== undefined) input.initialFacts = r.array(o.initialFacts, 'initialFacts', (v, p) => readQuestionFact(r, v, p), LIMITS.questions);
  if (o.research !== undefined) input.research = r.array(o.research, 'research', (v, p) => readResearchSeed(r, v, p), LIMITS.research);
  r.unique((input.initialFacts ?? []).map(q => q.questionId), 'initialFacts', 'questionId');
  r.unique((input.research ?? []).map(q => q.researchId), 'research', 'researchId');
  return r.result(input);
}

function buildDoc(input: TbdCreateInput, workflowId: string): TbdDocV1 {
  return {
    version: 1, kind: 'tbd', workflowId, revision: 1, createOperationId: input.operationId,
    originalRequest: input.originalRequest, background: input.background ?? null, questions: input.initialFacts ?? [], research: input.research ?? [],
  };
}

const decodeIssueList = (d: unknown) => Array.isArray(d) ? d.map(decodeGithubIssue) : undefined;
const decodeCreated = (repo: string) => (d: unknown) => {
  const url = (d as {url?: unknown} | null)?.url;
  const m = typeof url === 'string' ? new RegExp(`^https://github\\.com/${repo.replace('.', '\\.')}/issues/([1-9][0-9]*)$`, 'i').exec(url) : null;
  return m ? {number: Number(m[1]), url: url as string} : undefined;
};

export async function createTbd(input: TbdCreateInput, call: ToolCall): Promise<ScaffoldResult<TbdCreateData>> {
  const operation = TBD_CREATE;
  const blocked = (problems: Problem[]): ScaffoldResult<TbdCreateData> => ({status: 'blocked', operation, problems});
  if (JSON.stringify(input).includes(DETERMINISTIC_GH_MASK)) return blocked([problem('UNREADABLE_TEXT', '', `Input contains "${DETERMINISTIC_GH_MASK}", which deterministic-gh uses for redaction; the TBD could not be read back. Rephrase it.`)]);
  const planner = call.env.currentModel();
  if (!planner) return blocked([problem('PLANNER_UNKNOWN', 'planner', 'The session model/thinking level is unknown; the planner cannot be recorded. No model is changed or called.')]);
  const caps = await call.bridge.requireCapabilities(['gh_issue_validate', 'gh_issue_submit', 'gh_issue_list', 'gh_issue_get', 'gh_labels_list'], call.scope, ['issue-list-labels']);
  if (!caps.ok) return {status: caps.problems.some(p => p.code === 'STALE_SCOPE') ? 'cancelled' : 'blocked', operation, problems: caps.problems};
  const workflowId = workflowIdFor(input.operationId);
  const context = await call.repoContext(input.repo, workflowId);
  if (!context.ok) return blocked(context.problems);
  const doc = buildDoc(input, workflowId);
  const decoded = decodeScaffoldDoc(doc);
  if (!decoded.ok) return blocked(decoded.problems);
  const block = renderTbdBlock(doc);
  if (Buffer.byteLength(block) > LIMITS.bodyBytes - 1024) return blocked([problem('LIMIT_EXCEEDED', 'body', 'The TBD body would exceed the Issue body limit.')]);

  const dir = join(context.value.workflowStateRoot, 'artifacts', input.operationId);
  const draftPath = join(dir, 'draft.json');
  const journal = call.journal(context.value);
  const payloadDigest = taggedDigest('tbd-create', {repo: input.repo, title: input.title, doc: JSON.parse(canonicalDocJson(doc))});
  const record = await journal.load(input.operationId);
  if (record && record.payloadDigest !== payloadDigest) return blocked([problem('OPERATION_PAYLOAD_MISMATCH', 'operationId', 'This operationId was already used with different content.')]);
  let recorded: {agents?: {planner?: {model: string; thinking: string; reason: string}}} | undefined;
  if (record) {
    try { recorded = JSON.parse((await readOwnedFile(draftPath, {root: call.namespaceRoot})).toString('utf8')); }
    catch (e) { if (!(e instanceof OwnedFileError && e.code === 'NOT_FOUND')) return blocked([problem('RECORDED_DRAFT_INVALID', 'draft', `The recorded draft of this operation (${draftPath}) is unreadable.`)]); }
  }
  const plannerBinding = recorded?.agents?.planner ?? {model: planner.model, thinking: planner.thinking, reason: 'TBDを作成したセッションのモデル（記録のみ）'};
  const snapshot = await buildTemplateSnapshot('tbd', {planner: plannerBinding as never}, join(dir, 'template'), call.namespaceRoot);
  const draft = {version: 1, template: TEMPLATE_IDS.tbd, repo: input.repo, title: input.title, labels: [...TBD_LABELS], fields: {[TEMPLATE_FIELD]: block}, agents: {planner: plannerBinding}};
  await writeOwnedFile(draftPath, JSON.stringify(draft, null, 2) + '\n', {root: call.namespaceRoot});
  const args = {draftPath, templatePath: snapshot.templatePath};
  const base: TbdCreateData = {workflowId};

  const validated = await call.bridge.call('gh_issue_validate', args, () => true as const, call.scope);
  if (validated.status !== 'ok') return {status: validated.status === 'cancelled' ? 'cancelled' : 'blocked', operation, problems: validated.problems};
  const labels = await readLabels(call, input.repo);
  if ('error' in labels) return blocked(labels.error);
  const absent = TBD_LABELS.filter(l => labels.labels.get(l.toLowerCase())?.name !== l);
  if (absent.length) return blocked([problem('LABELS_NOT_READY', 'labels', `Management labels are missing (${absent.join(', ')}); run scaffold_labels_ensure first.`)]);

  const candidates = async (): Promise<{number: number}[] | Problem[]> => {
    const r = await call.bridge.call('gh_issue_list', {repo: input.repo, state: 'all', labels: [...TBD_LABELS]}, decodeIssueList, call.scope);
    if (r.status !== 'ok' || r.data!.some(i => !i)) return r.problems.length ? r.problems : [problem('ISSUE_LIST_FAILED', 'issues', 'Issues could not be listed completely.')];
    return r.data!.filter(i => i!.body?.includes(input.operationId)).filter(i => { const p = parseIssueBody(i!.body ?? ''); return p.ok && p.value.doc.kind === 'tbd' && p.value.doc.createOperationId === input.operationId; }).map(i => ({number: i!.number}));
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
    const data: TbdCreateData = {...base, issue: {number, url: `https://github.com/${input.repo}/issues/${number}`}};
    const snap = await readIssue(input.repo, number, call.bridge, call.scope);
    if (!snap.ok) return run.stop(snap.problems, data);
    const d = snap.value.doc;
    if (d.kind !== 'tbd' || d.createOperationId !== input.operationId || d.workflowId !== workflowId) return run.stop([problem('TBD_IDENTITY', 'issue', `#${number} is not the TBD created by this operation.`)], data);
    const managed = snap.value.labels.filter(l => /^(Type|Scope|Stage|Wave): /.test(l) || l === 'Blocked');
    if (managed.slice().sort().join('\n') !== [...TBD_LABELS].sort().join('\n')) return run.stop([problem('TBD_LABELS_INCOMPLETE', 'labels', `#${number} has managed labels [${managed.join(', ')}] instead of exactly Type: Scaffold and Scope: TBD.`)], data);
    return {status: reused ? 'noop' : 'applied', data};
  });
  return result as ScaffoldResult<TbdCreateData>;
}
