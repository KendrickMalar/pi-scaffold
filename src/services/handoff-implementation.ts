// #14 scaffold_handoff_implementation: basic-design → implementation only. The design, Features, criteria, bindings and
// Waves must be complete and consistent, and the parent TUI must approve starting implementation for exactly that state
// (headless sessions may only reference an existing start approval). Transport is #5's driver; only the Epic's Stage moves.
import {decodeMutationInput, problem, type Decoded, type EpicDocV1, type GateResult, type IssueSnapshot, type MutationInput, type Problem, type ScaffoldResult} from '../core/contracts.js';
import {approvalViewDigest} from '../core/approvals.js';
import {blobKey, checkDesignReady, startApprovalView} from '../core/design-gate.js';
import {prepareLabelEdit} from '../core/label-policy.js';
import {committedByUs, handoffStage, type HandoffData, type StageGate} from '../handoff/driver.js';
import type {ToolCall} from '../core/runtime.js';
import {readIssue} from '../ports/pi-gh.js';
import {readFeatureSet} from '../ports/feature-set.js';
import {verifyWaves} from './waves-verify.js';

export const HANDOFF_IMPLEMENTATION = 'scaffold_handoff_implementation';
export function decodeImplementationHandoffInput(value: unknown): Decoded<MutationInput> { return decodeMutationInput(value); }

/** Complete readiness of an Epic snapshot: design gate + Wave verification. Returns the start-approval view when ready. */
async function readiness(call: ToolCall, repo: string, epicIssue: number, snapshot: IssueSnapshot, repoRoot: string) {
  const epic = snapshot.doc as EpicDocV1;
  const set = await readFeatureSet(repo, epicIssue, call.bridge, call.scope, {workflowId: epic.workflowId});
  if (!set.ok) return {problems: set.problems};
  const features = set.value.features;
  const blobs = new Map<string, Buffer | undefined>();
  for (const ref of [...(epic.design ? [epic.design] : []), ...features.map(f => f.doc.designRef)]) {
    if (blobs.has(blobKey(ref))) continue;
    try { blobs.set(blobKey(ref), await call.runtime.git.readBlob(ref.gitRef, ref.path, repoRoot)); } catch { blobs.set(blobKey(ref), undefined); }
  }
  const policy = await call.policy();
  if (!policy.ok) return {problems: policy.problems};
  const gate = checkDesignReady({repo, epic, features, blobs, policy: policy.value, availableModels: call.env.availableModels(), scopedModels: call.env.scopedModels()});
  const waves = await verifyWaves({repo, epicIssue}, call);
  const problems: Problem[] = [...gate.problems, ...(waves.data?.passed ? [] : waves.problems.length ? waves.problems : [problem('WAVES_NOT_VERIFIED', 'waves', 'The Wave check did not pass.')])];
  if (problems.length) return {problems};
  return {problems: [], view: startApprovalView(epic, features, set.value.featureSetDigest)};
}

export async function handoffImplementation(input: MutationInput, call: ToolCall): Promise<ScaffoldResult<HandoffData>> {
  const operation = HANDOFF_IMPLEMENTATION;
  const blocked = (problems: Problem[]): ScaffoldResult<HandoffData> => ({status: 'blocked', operation, problems});
  const caps = await call.bridge.requireCapabilities(['gh_issue_get', 'gh_subissues_list', 'gh_dependencies_list'], call.scope);
  if (!caps.ok) return blocked(caps.problems);
  const repoOnly = await call.repoContext(input.repo, null);
  if (!repoOnly.ok) return blocked(repoOnly.problems);
  const snap = await readIssue(input.repo, input.epicIssue, call.bridge, call.scope);
  if (!snap.ok) return blocked(snap.problems);
  const doc = snap.value.doc;
  if (doc.kind !== 'epic') return blocked([problem('NOT_AN_EPIC', 'epicIssue', `#${input.epicIssue} is not a Scaffold Epic.`)]);
  const context = await call.repoContext(input.repo, doc.workflowId);
  if (!context.ok) return blocked(context.problems);
  const handoff = {...input, expectedStage: 'basic-design' as const, nextStage: 'implementation' as const};
  const repoRoot = repoOnly.value.repoRoot;
  if (!(await committedByUs(snap.value, handoff, call.journal(context.value)))) {
    // Cheap preconditions first: nothing is asked for a handoff that cannot proceed.
    const env = call.environment();
    if (env.HERDR_ENV !== '1' || !env.HERDR_WORKSPACE_ID || !env.HERDR_PANE_ID) return blocked([problem('HERDR_UNAVAILABLE', 'herdr', 'This session is not running inside Herdr.')]);
    if (env.PI_SUBAGENT_CHILD) return blocked([problem('CHILD_SESSION', 'session', 'A subagent child cannot approve or start implementation.')]);
    if (doc.stage !== 'basic-design') return blocked([problem('STAGE_MISMATCH', 'stage', `Epic is in ${doc.stage}, not basic-design.`)]);
    const stale = [
      ...(snap.value.bodySha256 !== input.expectedBodySha256 ? [problem('STALE_BODY', 'expectedBodySha256', 'Epic body changed; read it again.')] : []),
      ...(doc.revision !== input.expectedRevision ? [problem('STALE_REVISION', 'expectedRevision', `Epic revision is ${doc.revision}.`)] : []),
    ];
    if (stale.length) return blocked(stale);
    const labels = prepareLabelEdit(snap.value, {type: 'Scaffold', scope: 'Epic', stage: 'implementation'});
    if (!labels.ok) return blocked(labels.problems);
    const ready = await readiness(call, input.repo, input.epicIssue, snap.value, repoRoot);
    if (!ready.view) return blocked(ready.problems);
    const existing = await call.approvals.requireContentApproval('implementation-start', doc.workflowId, approvalViewDigest('implementation-start', ready.view), context.value);
    if (!existing.ok) {
      if (!existing.problems.every(p => p.code === 'APPROVAL_MISSING')) return blocked(existing.problems);
      const confirmed = await call.approvals.confirmContent('implementation-start', doc.workflowId, ready.view, context.value, call.env.approvalUi, call.scope);
      if (confirmed.status !== 'validated') return {status: confirmed.status, operation, problems: confirmed.problems};
    }
  }
  // Right before the stage commit: still ready, and the start approval matches the state as it is now.
  const gate: StageGate = async s => {
    const ready = await readiness(call, input.repo, input.epicIssue, s, repoRoot);
    if (!ready.view) return {status: 'blocked', problems: ready.problems, artifactDigests: {}} as GateResult;
    const approved = await call.approvals.requireContentApproval('implementation-start', (s.doc as EpicDocV1).workflowId, approvalViewDigest('implementation-start', ready.view), context.value);
    return (approved.ok ? {status: 'validated', problems: [], artifactDigests: {startApproval: ready.view.contentDigest}} : {status: 'blocked', problems: approved.problems, artifactDigests: {}}) as GateResult;
  };
  return handoffStage(handoff, gate, call, operation);
}
