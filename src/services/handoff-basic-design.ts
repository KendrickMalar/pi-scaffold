// #9 scaffold_handoff_basic_design: specification → basic-design only. The specification must be complete and its exact
// content approved in the parent TUI (headless sessions may only reference an existing approval). Transport is #5's driver;
// the gate re-checks completeness and the approval right before the stage commit.
import {decodeMutationInput, problem, type Decoded, type EpicDocV1, type IssueSnapshot, type MutationInput, type ScaffoldResult} from '../core/contracts.js';
import {approvalViewDigest} from '../core/approvals.js';
import {checkSpecificationReady, specificationApprovalView} from '../core/specification-gate.js';
import {committedByUs, handoffStage, type HandoffData, type StageGate} from '../handoff/driver.js';
import {prepareLabelEdit} from '../core/label-policy.js';
import type {ToolCall} from '../core/runtime.js';
import {readIssue} from '../ports/pi-gh.js';

export const HANDOFF_BASIC_DESIGN = 'scaffold_handoff_basic_design';
export function decodeBasicDesignHandoffInput(value: unknown): Decoded<MutationInput> { return decodeMutationInput(value); }

export async function handoffBasicDesign(input: MutationInput, call: ToolCall): Promise<ScaffoldResult<HandoffData>> {
  const operation = HANDOFF_BASIC_DESIGN;
  const blocked = (problems: ReturnType<typeof problem>[]): ScaffoldResult<HandoffData> => ({status: 'blocked', operation, problems});
  const caps = await call.bridge.requireCapabilities(['gh_issue_get'], call.scope);
  if (!caps.ok) return blocked(caps.problems);
  const snap = await readIssue(input.repo, input.epicIssue, call.bridge, call.scope);
  if (!snap.ok) return blocked(snap.problems);
  const doc = snap.value.doc;
  if (doc.kind !== 'epic') return blocked([problem('NOT_AN_EPIC', 'epicIssue', `#${input.epicIssue} is not a Scaffold Epic.`)]);
  const context = await call.repoContext(input.repo, doc.workflowId);
  if (!context.ok) return blocked(context.problems);
  const handoff = {...input, expectedStage: 'specification' as const, nextStage: 'basic-design' as const};
  // Nothing is asked for a handoff that cannot proceed. Only an operation this journal really committed skips the checks (the driver resumes it).
  const ours = await committedByUs(snap.value, handoff, call.journal(context.value));
  if (!ours) {
    const env = call.environment();
    if (env.HERDR_ENV !== '1' || !env.HERDR_WORKSPACE_ID || !env.HERDR_PANE_ID) return blocked([problem('HERDR_UNAVAILABLE', 'herdr', 'This session is not running inside Herdr.')]);
    if (env.PI_SUBAGENT_CHILD) return blocked([problem('CHILD_SESSION', 'session', 'A subagent child cannot approve the specification or start a stage session.')]);
    if (doc.stage !== 'specification') return blocked([problem('STAGE_MISMATCH', 'stage', `Epic is in ${doc.stage}, not specification.`)]);
    const stale = [
      ...(snap.value.bodySha256 !== input.expectedBodySha256 ? [problem('STALE_BODY', 'expectedBodySha256', 'Epic body changed; read it again.')] : []),
      ...(doc.revision !== input.expectedRevision ? [problem('STALE_REVISION', 'expectedRevision', `Epic revision is ${doc.revision}.`)] : []),
    ];
    if (stale.length) return blocked(stale);
    const labels = prepareLabelEdit(snap.value, {type: 'Scaffold', scope: 'Epic', stage: 'basic-design'});
    if (!labels.ok) return blocked(labels.problems);
    const gate = checkSpecificationReady(doc);
    if (gate.status !== 'validated') return blocked(gate.problems);
    const view = specificationApprovalView(doc);
    const existing = await call.approvals.requireContentApproval('specification', doc.workflowId, approvalViewDigest('specification', view), context.value);
    if (!existing.ok) {
      if (!existing.problems.every(p => p.code === 'APPROVAL_MISSING')) return blocked(existing.problems);
      const confirmed = await call.approvals.confirmContent('specification', doc.workflowId, view, context.value, call.env.approvalUi, call.scope);
      if (confirmed.status !== 'validated') return {status: confirmed.status, operation, problems: confirmed.problems};
    }
  }
  // Right before the stage commit: still complete, and the approval matches the specification as it is now.
  const gate: StageGate = async (s: IssueSnapshot) => {
    const d = s.doc as EpicDocV1;
    const ready = checkSpecificationReady(d);
    if (ready.status !== 'validated') return ready;
    const approved = await call.approvals.requireContentApproval('specification', d.workflowId, approvalViewDigest('specification', specificationApprovalView(d)), context.value);
    return approved.ok ? ready : {status: 'blocked', problems: approved.problems, artifactDigests: ready.artifactDigests};
  };
  return handoffStage(handoff, gate, call, operation);
}
