// #7 scaffold_research_begin: move named pending research items to in_progress under one claim and hand out briefs.
// No research is run, no model is called and no agent is started. Briefs are issued only after the claim is read back.
import {join} from 'node:path';
import {
  LIMITS, decodeMutationInput, problem,
  type Decoded, type EpicDocV1, type IssueSnapshot, type MutationInput, type PreparedIssueEdit, type Problem, type ResearchClaim, type ScaffoldResult,
} from '../core/contracts.js';
import {patchDoc} from '../core/body-codec.js';
import {taggedDigest} from '../core/digests.js';
import {readOwnedJson, writeOwnedFile} from '../core/files.js';
import {withOperation} from '../core/lifecycle.js';
import {holdsClaim, planResearchBegin, researchBrief, type ResearchBrief} from '../core/research.js';
import type {ToolCall} from '../core/runtime.js';
import {readIssue} from '../ports/pi-gh.js';

export const RESEARCH_BEGIN = 'scaffold_research_begin';
export type ResearchBeginInput = MutationInput & {researchIds: string[]};
export interface ResearchBeginData { claims: ResearchClaim[]; briefs: ResearchBrief[]; skipped: string[] }
type Stored = Omit<ResearchBeginData, 'briefs'>;

export function decodeResearchBeginInput(value: unknown): Decoded<ResearchBeginInput> {
  return decodeMutationInput<{researchIds: string[]}>(value, {
    researchIds: {decode: (r, v, p) => r.array(v, p, (x, q) => r.text(x, q), LIMITS.research)},
  });
}

function preflight(snapshot: IssueSnapshot, input: ResearchBeginInput): Problem[] {
  const doc = snapshot.doc as EpicDocV1;
  const problems: Problem[] = [];
  if (snapshot.state !== 'open') problems.push(problem('ISSUE_CLOSED', 'epicIssue', 'The Epic is closed.'));
  if (doc.stage !== 'specification') problems.push(problem('STAGE_MISMATCH', 'stage', `Research is started during specification; the Epic is in ${doc.stage}.`));
  if (snapshot.bodySha256 !== input.expectedBodySha256) problems.push(problem('STALE_BODY', 'expectedBodySha256', 'The Epic body changed since it was read; read it again.'));
  if (doc.revision !== input.expectedRevision) problems.push(problem('STALE_REVISION', 'expectedRevision', `The Epic is at revision ${doc.revision}.`));
  return problems;
}

export async function beginResearch(input: ResearchBeginInput, call: ToolCall): Promise<ScaffoldResult<ResearchBeginData>> {
  const operation = RESEARCH_BEGIN;
  const blocked = (problems: Problem[]): ScaffoldResult<ResearchBeginData> => ({status: 'blocked', operation, problems});
  const caps = await call.bridge.requireCapabilities(['gh_issue_get', 'gh_issue_edit_if_current'], call.scope);
  if (!caps.ok) return blocked(caps.problems);
  const repoOnly = await call.repoContext(input.repo, null);
  if (!repoOnly.ok) return blocked(repoOnly.problems);
  const snap = await readIssue(input.repo, input.epicIssue, call.bridge, call.scope);
  if (!snap.ok) return blocked(snap.problems);
  if (snap.value.doc.kind !== 'epic') return blocked([problem('NOT_AN_EPIC', 'epicIssue', 'Expected an Epic.')]);
  const context = await call.repoContext(input.repo, snap.value.doc.workflowId);
  if (!context.ok) return blocked(context.problems);
  const plannedPath = join(context.value.workflowStateRoot, 'research-begin', input.operationId, 'epic-body.json');
  const {operationId: _id, ...payload} = input;
  const reread = async (stop: (p: Problem[]) => never) => { const r = await readIssue(input.repo, input.epicIssue, call.bridge, call.scope); if (!r.ok) stop(r.problems); return (r as {ok: true; value: IssueSnapshot}).value; };

  const result = await withOperation<Stored>({
    operation, repo: input.repo, workflowId: snap.value.doc.workflowId, operationId: input.operationId,
    payloadDigest: taggedDigest('research-begin', payload), journal: call.journal(context.value), scope: call.scope,
  }, async run => {
    const step = run.record.steps.find(s => s.name === 'epic-body');
    if (!step || step.phase === 'failed') {
      const current = step ? await reread(run.stop) : snap.value;
      const problems = preflight(current, input);
      if (problems.length) run.stop(problems);
      // Never adopt an existing claim here: this journal has not sent one (an operationId copied from the Issue is not ownership).
      const plan = planResearchBegin(current.doc as EpicDocV1, input.researchIds, {operationId: input.operationId, sessionId: call.scope.sessionId});
      if (!plan.ok) return run.stop(plan.problems);
      run.note('plan', {claims: plan.value.claims, skipped: plan.value.skipped} satisfies Stored);
      if (!plan.value.changed) return {status: 'noop', data: {claims: plan.value.claims, skipped: plan.value.skipped}};
      const edit = patchDoc(current, plan.value.nextDoc);
      if (!edit.ok) return run.stop(edit.problems);
      await writeOwnedFile(plannedPath, JSON.stringify(edit.value), {root: call.namespaceRoot});
    }
    const planned = await readOwnedJson(plannedPath, {root: call.namespaceRoot, maxBytes: LIMITS.bodyBytes * 2}) as PreparedIssueEdit;
    const stored = run.done('plan') as Stored;
    await run.write('epic-body', () => call.bridge.call('gh_issue_edit_if_current', {changePath: plannedPath}, () => true as const, call.scope), {
      reconcile: async () => { const s = await reread(run.stop); return s.body === planned.body ? 'applied' : s.bodySha256 === planned.expectedBodySha256 ? 'not-applied' : 'unknown'; },
    });
    return {status: 'applied', data: stored};
  });
  if (result.status !== 'applied' && result.status !== 'noop') return result as ScaffoldResult<ResearchBeginData>;
  // Briefs only from a fresh read that still shows every claim (also for a re-run of a completed operation).
  // Right after our own write a failed read-back is resumable with the same operationId; nothing is handed out meanwhile.
  const stored = result.data as Stored;
  const notNow = (problems: Problem[]): ScaffoldResult<ResearchBeginData> => result.status === 'applied'
    ? {status: 'partial', operation, problems, resumeToken: input.operationId} : blocked(problems);
  const after = await readIssue(input.repo, input.epicIssue, call.bridge, call.scope);
  if (!after.ok) return notNow(after.problems);
  const doc = after.value.doc as EpicDocV1;
  const state = [
    ...(after.value.state !== 'open' ? [problem('ISSUE_CLOSED', 'epicIssue', 'The Epic is closed; no brief is issued.')] : []),
    ...(doc.stage !== 'specification' ? [problem('STAGE_MISMATCH', 'stage', `The Epic is in ${doc.stage}; no brief is issued.`)] : []),
  ];
  if (state.length) return blocked(state);
  const lost = stored.claims.filter(c => !holdsClaim(doc, c));
  if (lost.length) return notNow(lost.map(c => problem('CLAIM_LOST', c.researchId, `${c.researchId} is no longer in progress under this claim (the specification changed or it was released); no brief is issued.`)));
  return {...result, data: {...stored, briefs: stored.claims.map(c => researchBrief(doc, c.researchId, `${input.repo}#${input.epicIssue}`))}};
}
