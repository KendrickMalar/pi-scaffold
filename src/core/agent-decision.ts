// Agent decision stages (owner policy `agentDecisionStages`). Questions to the human are allowed only up to basic
// design; in a listed implementation/verification session the parent agent decides within the approved spec/design,
// records its decisions, and records content approvals itself. The session stage is the targetStage of the handoff
// packet this session accepted; without an accepted packet there is no stage and nothing changes.
import {AGENT_DECISION_STAGES, type AgentDecisionStage, type Stage} from './contracts.js';
import {loadOwnerPolicy, repoPolicyFor, type OwnerPolicy} from './model-bindings.js';

/** The handoff packet accepted by this process's session (set by the extension on session_start). */
export interface AcceptedHandoff { sessionId: string; repo: string; workflowId: string; targetStage: Stage }

/** Tools that ask the human a question; blocked in agent-decision stages (real Pi only: needs `tool_call` events). */
export const AGENT_DECISION_BLOCKED_TOOLS: readonly string[] = ['ask_user', 'AskUserQuestion'];

export const QUESTION_BLOCK_REASON = (stage: AgentDecisionStage) =>
  `pi-scaffold: この${stage === 'implementation' ? '実装（Implementation）' : '検証（Verification）'}工程では人間に質問できません（owner policy の agentDecisionStages）。承認済みの仕様・設計の範囲で自分で判断して進め、判断した内容と理由を Issue と最終報告に記録してください。仕様・設計の範囲を超える判断が必要なら、作業を止めてその旨を Issue と最終報告に書いてください。`;

const isAgentStage = (s: Stage): s is AgentDecisionStage => (AGENT_DECISION_STAGES as readonly string[]).includes(s);

/**
 * The agent-decision stage for a call, or undefined (= human approvals and questions as before). Requires an accepted
 * packet of this same session for the same repo (and workflow, when given) and a policy entry listing its stage.
 */
export function resolveAgentDecisionStage(handoff: AcceptedHandoff | undefined, policy: OwnerPolicy | undefined, at: {sessionId: string; repo: string; workflowId?: string}): AgentDecisionStage | undefined {
  if (!handoff || handoff.sessionId !== at.sessionId || handoff.repo !== at.repo || (at.workflowId !== undefined && handoff.workflowId !== at.workflowId)) return undefined;
  if (!isAgentStage(handoff.targetStage)) return undefined;
  return (repoPolicyFor(policy, at.repo)?.agentDecisionStages ?? []).includes(handoff.targetStage) ? handoff.targetStage : undefined;
}

/**
 * `tool_call` handler: blocks question tools in a listed stage. Only the tool name is looked at; other tools return
 * at once without any file read. A missing or invalid policy never blocks. Hosts that never emit `tool_call` are unaffected.
 */
export function questionGuard(runtime: {agentDir: string; handoff?: AcceptedHandoff}) {
  return async (event: {toolName: string}, ctx: {sessionManager: {getSessionId(): string}}): Promise<{block: true; reason: string} | undefined> => {
    if (!AGENT_DECISION_BLOCKED_TOOLS.includes(event.toolName) || !runtime.handoff) return undefined;
    const policy = await loadOwnerPolicy(runtime.agentDir);
    const handoff = runtime.handoff;
    const stage = resolveAgentDecisionStage(handoff, policy.ok ? policy.value : undefined, {sessionId: ctx.sessionManager.getSessionId(), repo: handoff.repo, workflowId: handoff.workflowId});
    return stage ? {block: true, reason: QUESTION_BLOCK_REASON(stage)} : undefined;
  };
}
