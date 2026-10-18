// scaffold_specification_revise: revise an approved specification after the specification stage (basic design,
// implementation, verification). The revision is approved like any other content (by the parent agent when the owner
// policy lists specification-revision, otherwise in the parent TUI), logged in the Epic's specRevisions, and only the
// Features whose criteria use a changed REQ/AC ID are marked Blocked until scaffold_feature_revise brings them in line.
// The stage does not move and research results are kept (they were resolved against the approved specification).
import {join} from 'node:path';
import {
  decodeMutationInput, problem,
  type ApprovalRef, type Decoded, type EpicDocV1, type FeatureSnapshot, type IssueSnapshot, type MutationInput, type PreparedIssueLabels, type Problem, type ScaffoldResult, type SpecRevision,
} from '../core/contracts.js';
import {patchDoc} from '../core/body-codec.js';
import {approvalNeedsConfirmation, approvalViewDigest, withAgentApproval, type ApprovalView} from '../core/approvals.js';
import {canonicalJson, specificationDigest, taggedDigest} from '../core/digests.js';
import {readOwnedJson, writeOwnedFile} from '../core/files.js';
import {prepareLabelEdit} from '../core/label-policy.js';
import {withOperation} from '../core/lifecycle.js';
import {reduceSpecification, type SpecificationPatch} from '../core/specification.js';
import {checkSpecificationReady, specificationApprovalView} from '../core/specification-gate.js';
import type {ToolCall} from '../core/runtime.js';
import {readIssue, PI_GH_MASK} from '../ports/pi-gh.js';
import {readFeatureSet} from '../ports/feature-set.js';
import {SPECIFICATION_PATCH_FIELDS} from './specification-update.js';

export const SPECIFICATION_REVISE = 'scaffold_specification_revise';
export const REVISABLE_STAGES: readonly string[] = ['basic-design', 'implementation', 'verification'];
export type SpecificationReviseInput = MutationInput & SpecificationPatch & {reason: string};
export interface SpecificationReviseData { revision: number; specDigest: string; changedIds: string[]; affectedFeatures: number[]; blockedFeatures: number[] }

export function decodeSpecificationReviseInput(value: unknown): Decoded<SpecificationReviseInput> {
  return decodeMutationInput<SpecificationPatch & {reason: string}>(value, {...SPECIFICATION_PATCH_FIELDS, reason: {decode: (r, v, p) => r.text(v, p)}});
}

/** Features whose criteria use a changed REQ ID or a changed AC ID. */
export function affectedFeatures(features: readonly FeatureSnapshot[], changedIds: readonly string[]): number[] {
  const changed = new Set(changedIds);
  return features.filter(f => f.doc.criteria.some(c => changed.has(c.id) || c.requirementIds.some(id => changed.has(id)))).map(f => f.number).sort((a, b) => a - b);
}

/** What is approved: the reason, what changed, which Features stop, and the revised specification itself. */
export function revisionApprovalView(before: EpicDocV1, after: EpicDocV1, reason: string, changedIds: readonly string[], affected: readonly number[]): ApprovalView {
  const spec = specificationApprovalView(after);
  return {
    contentDigest: taggedDigest('specification-revision', {from: specificationDigest(before), to: specificationDigest(after), reason, changedIds, affected}),
    text: [`## 仕様の改訂（${before.stage} 工程）`, `理由：${reason}`, `変わった項目：${changedIds.join(', ') || 'なし'}`, `止めるFeature：${affected.length ? affected.map(n => '#' + n).join(', ') : 'なし'}`, '', spec.text].join('\n'),
  };
}

interface Plan { changedIds: string[]; affected: number[]; labelEdits: {issue: number; changePath: string; expectedLabelsSha256: string}[] }

export async function reviseSpecification(input: SpecificationReviseInput, call: ToolCall): Promise<ScaffoldResult<SpecificationReviseData>> {
  const operation = SPECIFICATION_REVISE;
  const blocked = (problems: Problem[]): ScaffoldResult<SpecificationReviseData> => ({status: 'blocked', operation, problems});
  if (JSON.stringify(input).includes(PI_GH_MASK)) return blocked([problem('UNREADABLE_TEXT', '', `Input contains "${PI_GH_MASK}", which pi-gh uses for redaction; the Epic could not be read back. Rephrase it.`)]);
  const caps = await call.bridge.requireCapabilities(['gh_issue_get', 'gh_issue_edit_if_current', 'gh_issue_labels_if_current', 'gh_subissues_list'], call.scope);
  if (!caps.ok) return blocked(caps.problems);
  const repoOnly = await call.repoContext(input.repo, null);
  if (!repoOnly.ok) return blocked(repoOnly.problems);
  const snap = await readIssue(input.repo, input.epicIssue, call.bridge, call.scope);
  if (!snap.ok) return blocked(snap.problems);
  if (snap.value.doc.kind !== 'epic') return blocked([problem('NOT_AN_EPIC', 'epicIssue', `#${input.epicIssue} is not a Scaffold Epic.`)]);
  const doc = snap.value.doc;
  const context = await call.repoContext(input.repo, doc.workflowId);
  if (!context.ok) return blocked(context.problems);
  const journal = call.journal(context.value);
  const record = await journal.load(input.operationId);
  const dir = join(context.value.workflowStateRoot, 'specification-revise', input.operationId);
  const bodyPath = join(dir, 'epic-body.json');
  let approval: ApprovalRef | undefined;
  let fresh: Plan | undefined;

  // Once the plan is recorded, the checks are history: a resume only finishes the writes.
  if (!record?.steps.some(s => s.name === 'plan')) {
    // ---- preconditions, the revised document and its approval (zero side effects) ----
    const pre: Problem[] = [];
    if (call.environment().PI_SUBAGENT_CHILD || call.env.approvalUi.child) pre.push(problem('CHILD_SESSION', 'session', 'A subagent child cannot revise the specification; ask the parent.'));
    if (snap.value.state !== 'open') pre.push(problem('ISSUE_CLOSED', 'epicIssue', 'The Epic is closed.'));
    if (!REVISABLE_STAGES.includes(doc.stage)) pre.push(problem('STAGE_MISMATCH', 'stage', `The Epic is in ${doc.stage}; ${doc.stage === 'specification' ? 'edit the specification with scaffold_specification_update' : 'only basic-design, implementation and verification Epics are revised here'}.`));
    if (snap.value.bodySha256 !== input.expectedBodySha256) pre.push(problem('STALE_BODY', 'expectedBodySha256', 'The Epic body changed since it was read; read it again.'));
    if (doc.revision !== input.expectedRevision) pre.push(problem('STALE_REVISION', 'expectedRevision', `The Epic is at revision ${doc.revision}.`));
    if (pre.length) return blocked(pre);
    const reduced = reduceSpecification(doc, input);
    if (!reduced.ok) return blocked(reduced.problems);
    // Research stays as it is: its results were accepted with the specification and are not redone for a revision.
    const revised: EpicDocV1 = {...reduced.value.nextDoc, research: doc.research};
    if (canonicalJson(revised) === canonicalJson(doc)) return {status: 'noop', operation, data: {revision: doc.revision, specDigest: specificationDigest(doc), changedIds: [], affectedFeatures: [], blockedFeatures: []}, problems: []};
    const ready = checkSpecificationReady(revised);
    if (ready.status !== 'validated') return blocked(ready.problems);
    const set = await readFeatureSet(input.repo, input.epicIssue, call.bridge, call.scope, {workflowId: doc.workflowId});
    if (!set.ok) return blocked(set.problems);
    const changedIds = reduced.value.changedIds;
    const affected = affectedFeatures(set.value.features, changedIds);
    const labelEdits: Plan['labelEdits'] = [];
    const labelProblems: Problem[] = [];
    for (const f of set.value.features.filter(x => affected.includes(x.number))) {
      const e = prepareLabelEdit(f, {type: 'Scaffold', scope: 'Feature', stage: f.doc.stage, blocked: true});
      if (!e.ok) { labelProblems.push(...e.problems.map(p => ({...p, path: `features[#${f.number}].${p.path}`}))); continue; }
      if (!e.value.add.length && !e.value.remove.length) continue;
      const changePath = join(dir, `labels-${f.number}.json`);
      await writeOwnedFile(changePath, JSON.stringify(e.value satisfies PreparedIssueLabels), {root: call.namespaceRoot});
      labelEdits.push({issue: f.number, changePath, expectedLabelsSha256: f.labelsSha256});
    }
    if (labelProblems.length) return blocked(labelProblems);
    const view = revisionApprovalView(doc, revised, input.reason, changedIds, affected);
    const viewDigest = approvalViewDigest('specification-revision', view);
    const existing = await call.approvals.requireContentApproval('specification-revision', doc.workflowId, viewDigest, context.value);
    if (existing.ok) approval = existing.value;
    else {
      if (!approvalNeedsConfirmation(existing.problems)) return blocked(existing.problems);
      const confirmed = await call.approvals.confirmContent('specification-revision', doc.workflowId, view, context.value, call.env.approvalUi, call.scope, await call.approvalOptions(input.repo, doc.workflowId, 'specification-revision'));
      if (confirmed.status !== 'validated') return {status: confirmed.status, operation, problems: confirmed.problems};
      approval = confirmed.data;
    }
    const entry: SpecRevision = {revision: doc.revision + 1, operationId: input.operationId, stage: doc.stage, reason: input.reason, changedIds, affectedFeatures: affected, approvalViewDigest: viewDigest};
    const edit = patchDoc(snap.value, {...revised, specRevisions: [...(doc.specRevisions ?? []), entry]});
    if (!edit.ok) return blocked(edit.problems);
    await writeOwnedFile(bodyPath, JSON.stringify(edit.value), {root: call.namespaceRoot});
    fresh = {changedIds, affected, labelEdits};
  }

  // ---- writes: the Epic body first, then Blocked on each affected Feature ----
  const {operationId: _id, ...payload} = input;
  const reread = async (n: number, stop: (p: Problem[]) => never) => { const r = await readIssue(input.repo, n, call.bridge, call.scope); if (!r.ok) stop(r.problems); return (r as {ok: true; value: IssueSnapshot}).value; };
  const result = await withOperation<SpecificationReviseData>({operation, repo: input.repo, workflowId: doc.workflowId, operationId: input.operationId, payloadDigest: taggedDigest('specification-revise', payload), journal, scope: call.scope}, async run => {
    const plan = (run.done('plan') as Plan | undefined) ?? (run.note('plan', fresh!), fresh!);
    const planned = await readOwnedJson(bodyPath, {root: call.namespaceRoot, maxBytes: 64 * 1024 * 2}) as {body: string; expectedBodySha256: string};
    await run.write('epic-body', () => call.bridge.call('gh_issue_edit_if_current', {changePath: bodyPath}, () => true as const, call.scope), {
      reconcile: async () => { const s = await reread(input.epicIssue, run.stop); return s.body === planned.body ? 'applied' : s.bodySha256 === planned.expectedBodySha256 ? 'not-applied' : 'unknown'; },
    });
    for (const e of plan.labelEdits) {
      await run.write(`blocked:#${e.issue}`, () => call.bridge.call('gh_issue_labels_if_current', {changePath: e.changePath}, () => true as const, call.scope), {
        reconcile: async () => { const s = await reread(e.issue, run.stop); return s.labels.includes('Blocked') ? 'applied' : s.labelsSha256 === e.expectedLabelsSha256 ? 'not-applied' : 'unknown'; },
      });
    }
    const after = await reread(input.epicIssue, run.stop);
    if (after.body !== planned.body) return run.stop([problem('BODY_NOT_UPDATED', 'epicIssue', 'The Epic body does not show this revision.')]);
    const blockedFeatures: number[] = [];
    for (const n of plan.affected) if ((await reread(n, run.stop)).labels.includes('Blocked')) blockedFeatures.push(n);
    const doc2 = after.doc as EpicDocV1;
    return {status: 'applied', data: {revision: doc2.revision, specDigest: specificationDigest(doc2), changedIds: plan.changedIds, affectedFeatures: plan.affected, blockedFeatures}};
  });
  return withAgentApproval(result as ScaffoldResult<SpecificationReviseData>, approval);
}
