// #9 scaffold_handoff_basic_design: specification → basic-design only. The specification must be complete and its exact
// content approved in the parent TUI (headless sessions may only reference an existing approval). Transport is #5's driver;
// the gate re-checks completeness and the approval right before the stage commit.
import {decodeMutationInput, problem, type Decoded, type EpicDocV1, type IssueSnapshot, type MutationInput, type ScaffoldResult} from '../core/contracts.js';
import {approvalViewDigest} from '../core/approvals.js';
import {checkSpecificationReady, specificationApprovalView} from '../core/specification-gate.js';
import {handoffStage, type HandoffData, type StageGate} from '../handoff/driver.js';
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
  // Nothing is asked for a stage mismatch or an incomplete specification (an operation already committed by us skips this; the driver handles it).
  const ours = doc.stage === 'basic-design' && doc.handoff?.operationId === input.operationId;
  if (!ours) {
    if (doc.stage !== 'specification') return blocked([problem('STAGE_MISMATCH', 'stage', `Epic is in ${doc.stage}, not specification.`)]);
    const gate = checkSpecificationReady(doc);
    if (gate.status !== 'validated') return blocked(gate.problems);
    const view = specificationApprovalView(doc);
    const existing = await call.approvals.requireContentApproval('specification', doc.workflowId, approvalViewDigest('specification', view), context.value);
    if (!existing.ok) {
      if (!existing.problems.every(p => p.code === 'APPROVAL_MISSING')) return blocked(existing.problems);
      if (call.environment().PI_SUBAGENT_CHILD) return blocked([problem('APPROVAL_UI_REQUIRED', 'specification', 'A subagent child cannot record the specification approval.')]);
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
  return handoffStage({...input, expectedStage: 'specification', nextStage: 'basic-design'}, gate, call, operation);
}
