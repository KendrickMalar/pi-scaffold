// #6 scaffold_specification_update: reflect explicitly given hearing results into a specification-stage Epic.
// One conditional body edit (pi-gh *_if_current) per operation; stale bodies and later stages write nothing.
// Approvals are bound to content digests, so any content change makes earlier approvals unusable by construction.
import {join} from 'node:path';
import {
  LIMITS, decodeMutationInput, problem, readCriterion, readDecision, readOriginalRequest, readQuestionFact, readRequirement,
  type Decoded, type EpicDocV1, type IssueSnapshot, type MutationInput, type PreparedIssueEdit, type Problem, type ScaffoldResult,
} from '../core/contracts.js';
import {patchDoc} from '../core/body-codec.js';
import {canonicalJson, sha256Text, specBaseDigest, specificationDigest, taggedDigest} from '../core/digests.js';
import {readOwnedJson, writeOwnedFile} from '../core/files.js';
import {withOperation} from '../core/lifecycle.js';
import {reduceSpecification, specificationMissingFields, type SpecificationPatch} from '../core/specification.js';
import type {ToolCall} from '../core/runtime.js';
import {readIssue, PI_GH_MASK} from '../ports/pi-gh.js';

export const SPECIFICATION_UPDATE = 'scaffold_specification_update';
export type SpecificationUpdateInput = MutationInput & SpecificationPatch;
export interface SpecificationUpdateData { revision: number; specDigest: string; missingFields: string[]; changedIds: string[]; researchReset: boolean }

export function decodeSpecificationUpdateInput(value: unknown): Decoded<SpecificationUpdateInput> {
  return decodeMutationInput<SpecificationPatch>(value, {
    originalRequest: {optional: true, decode: (r, v, p) => readOriginalRequest(r, v, p)},
    background: {optional: true, decode: (r, v, p) => r.nullableText(v, p)},
    facts: {decode: (r, v, p) => r.array(v, p, (x, q) => readQuestionFact(r, x, q), LIMITS.questions)},
    requirements: {decode: (r, v, p) => r.array(v, p, (x, q) => readRequirement(r, x, q), LIMITS.requirements)},
    criteria: {decode: (r, v, p) => r.array(v, p, (x, q) => readCriterion(r, x, q), LIMITS.criteria)},
    constraints: {optional: true, decode: (r, v, p) => r.nullableArray(v, p, (x, q) => r.text(x, q))},
    outOfScope: {optional: true, decode: (r, v, p) => r.nullableArray(v, p, (x, q) => r.text(x, q))},
    decisions: {decode: (r, v, p) => r.array(v, p, (x, q) => readDecision(r, x, q), LIMITS.decisions)},
  });
}

/** Specification may only be edited in its own stage; later stages stop for an explicit revision. */
function preflight(snapshot: IssueSnapshot, input: SpecificationUpdateInput): Problem[] {
  const doc = snapshot.doc as EpicDocV1;
  const problems: Problem[] = [];
  if (snapshot.state !== 'open') problems.push(problem('ISSUE_CLOSED', 'epicIssue', 'The Epic is closed.'));
  if (doc.stage === 'setup') problems.push(problem('STAGE_MISMATCH', 'stage', 'The specification session has not started (stage is setup); hand off with scaffold_handoff_specification first.'));
  else if (doc.stage !== 'specification') problems.push(problem('NEEDS_REVISION', 'stage', `The Epic is in ${doc.stage}; the specification is not rewritten here. Stop and ask the parent to revise it explicitly.`));
  if (snapshot.bodySha256 !== input.expectedBodySha256) problems.push(problem('STALE_BODY', 'expectedBodySha256', 'The Epic body changed since it was read; read it again.'));
  if (doc.revision !== input.expectedRevision) problems.push(problem('STALE_REVISION', 'expectedRevision', `The Epic is at revision ${doc.revision}.`));
  return problems;
}

function dataOf(doc: EpicDocV1, changedIds: string[], researchReset: boolean): SpecificationUpdateData {
  return {revision: doc.revision, specDigest: specificationDigest(doc), missingFields: specificationMissingFields(doc), changedIds, researchReset};
}

interface PlanNote { changedIds: string[]; researchReset: boolean }

export async function updateSpecification(input: SpecificationUpdateInput, call: ToolCall): Promise<ScaffoldResult<SpecificationUpdateData>> {
  const operation = SPECIFICATION_UPDATE;
  const blocked = (problems: Problem[]): ScaffoldResult<SpecificationUpdateData> => ({status: 'blocked', operation, problems});
  if (JSON.stringify(input).includes(PI_GH_MASK)) return blocked([problem('UNREADABLE_TEXT', '', `Input contains "${PI_GH_MASK}", which pi-gh uses for redaction; the Epic could not be read back. Rephrase it.`)]);
  const caps = await call.bridge.requireCapabilities(['gh_issue_get', 'gh_issue_edit_if_current'], call.scope);
  if (!caps.ok) return blocked(caps.problems);
  const repoOnly = await call.repoContext(input.repo, null);
  if (!repoOnly.ok) return blocked(repoOnly.problems);
  const snap = await readIssue(input.repo, input.epicIssue, call.bridge, call.scope);
  if (!snap.ok) return blocked(snap.problems);
  if (snap.value.doc.kind !== 'epic') return blocked([problem('NOT_AN_EPIC', 'epicIssue', 'Expected an Epic.')]);
  const context = await call.repoContext(input.repo, snap.value.doc.workflowId);
  if (!context.ok) return blocked(context.problems);
  const dir = join(context.value.workflowStateRoot, 'specification', input.operationId);
  const plannedPath = join(dir, 'epic-body.json');
  const {operationId: _id, ...payload} = input;
  const reread = async (stop: (p: Problem[]) => never) => { const r = await readIssue(input.repo, input.epicIssue, call.bridge, call.scope); if (!r.ok) stop(r.problems); return (r as {ok: true; value: IssueSnapshot}).value; };

  const result = await withOperation({
    operation, repo: input.repo, workflowId: snap.value.doc.workflowId, operationId: input.operationId,
    payloadDigest: taggedDigest('specification-update', payload), journal: call.journal(context.value), scope: call.scope,
  }, async run => {
    const step = run.record.steps.find(s => s.name === 'epic-body');
    if (!step || step.phase === 'failed') {
      // Fresh (or failed-before-sending) attempt: every check runs against the body read in this call.
      const current = step ? await reread(run.stop) : snap.value;
      const problems = preflight(current, input);
      if (problems.length) run.stop(problems);
      const doc = current.doc as EpicDocV1;
      const reduced = reduceSpecification(doc, input);
      if (!reduced.ok) return run.stop(reduced.problems);
      if (canonicalJson(reduced.value.nextDoc) === canonicalJson(doc)) return {status: 'noop', data: dataOf(doc, [], false)};
      const edit = patchDoc(current, reduced.value.nextDoc);
      if (!edit.ok) return run.stop(edit.problems);
      if (reduced.value.baseChanged && doc.research.length) {
        // Earlier research results stay available locally; they are never carried over automatically.
        await writeOwnedFile(join(context.value.workflowStateRoot, 'research-history', `${input.operationId}.json`), JSON.stringify({
          version: 1, operationId: input.operationId, epicIssue: input.epicIssue, revision: doc.revision, specBaseDigest: specBaseDigest(doc), research: doc.research,
        }, null, 2), {root: call.namespaceRoot});
      }
      // The change file holds exactly pi-gh's contract; what changed is kept in the journal.
      await writeOwnedFile(plannedPath, JSON.stringify(edit.value), {root: call.namespaceRoot});
      run.note('plan', {changedIds: reduced.value.changedIds, researchReset: reduced.value.baseChanged && doc.research.length > 0} satisfies PlanNote);
    }
    const planned = await readOwnedJson(plannedPath, {root: call.namespaceRoot, maxBytes: LIMITS.bodyBytes * 2}) as PreparedIssueEdit;
    const plan = run.done('plan') as PlanNote;
    await run.write('epic-body', () => call.bridge.call('gh_issue_edit_if_current', {changePath: plannedPath}, () => true as const, call.scope), {
      reconcile: async () => { const s = await reread(run.stop); return s.body === planned.body ? 'applied' : s.bodySha256 === planned.expectedBodySha256 ? 'not-applied' : 'unknown'; },
    });
    const after = await reread(run.stop);
    if (sha256Text(after.body) !== sha256Text(planned.body)) return run.stop([problem('BODY_NOT_UPDATED', 'epicIssue', 'The Epic body does not show this update.')]);
    return {status: 'applied', data: dataOf(after.doc as EpicDocV1, plan.changedIds, plan.researchReset)};
  });
  return result as ScaffoldResult<SpecificationUpdateData>;
}
