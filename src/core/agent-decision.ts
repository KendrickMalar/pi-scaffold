// Stages without the human (owner policy). Questions to the human are allowed only in the specification stage: a session
// whose stage the policy lists in `questionBlockedStages` (or the older `agentDecisionStages`) never asks; it decides
// within the approved specification and design, records its decisions, and revises the specification with
// scaffold_specification_revise when the intent itself must change. There is no exception (the former 【事前作業】 marker is
// gone). The session stage is the targetStage of the handoff packet this session accepted; without an accepted packet there
// is no stage and nothing changes.
import {AGENT_DECISION_STAGES, type AgentDecisionStage, type Stage} from './contracts.js';
import {loadOwnerPolicy, repoPolicyFor, repoQuestionBlockedStages, type OwnerPolicy} from './model-bindings.js';

/** The handoff packet accepted by this process's session (set by the extension on session_start). */
export interface AcceptedHandoff { sessionId: string; repo: string; workflowId: string; targetStage: Stage }

/** Tools that ask the human a question; blocked in question-blocked stages (real Pi only: needs `tool_call` events). */
export const AGENT_DECISION_BLOCKED_TOOLS: readonly string[] = ['ask_user', 'AskUserQuestion'];

const STAGE_NAME: Partial<Record<Stage, string>> = {setup: '準備（Setup）', 'basic-design': '基本設計（Basic design）', implementation: '実装（Implementation）', verification: '検証（Verification）'};
export const QUESTION_BLOCK_REASON = (stage: Stage) =>
  `pi-scaffold: この${STAGE_NAME[stage] ?? stage}工程では人間に質問できません（owner policy）。人に聞いてよいのは仕様策定の工程だけです。` +
  '承認済みの仕様・設計の意図の範囲なら自分で決めて進め、判断した内容と理由を Issue と最終報告に記録してください。' +
  '仕様の意図を変える必要があるときは scaffold_specification_revise で仕様を改訂してください（影響する Feature は Blocked になります）。下位の担当なら、親への質問として返してください。';

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

/** The question-blocked stage of a session, or undefined. Same packet rules as resolveAgentDecisionStage. */
export function resolveQuestionBlockedStage(handoff: AcceptedHandoff | undefined, policy: OwnerPolicy | undefined, at: {sessionId: string; repo: string; workflowId?: string}): Stage | undefined {
  if (!handoff || handoff.sessionId !== at.sessionId || handoff.repo !== at.repo || (at.workflowId !== undefined && handoff.workflowId !== at.workflowId)) return undefined;
  return (repoQuestionBlockedStages(policy, at.repo) as readonly string[]).includes(handoff.targetStage) ? handoff.targetStage : undefined;
}

/**
 * `tool_call` handler: blocks question tools in a listed stage. Other tools return at once without any file read. A missing
 * or invalid policy never blocks. Hosts that never emit `tool_call` are unaffected.
 */
export function questionGuard(runtime: {agentDir: string; scaffoldDir?: string; handoff?: AcceptedHandoff}) {
  return async (event: {toolName: string; input?: unknown}, ctx: {sessionManager: {getSessionId(): string}}): Promise<{block: true; reason: string} | undefined> => {
    if (!AGENT_DECISION_BLOCKED_TOOLS.includes(event.toolName) || !runtime.handoff) return undefined;
    const policy = await loadOwnerPolicy(runtime.agentDir, runtime.scaffoldDir);
    const handoff = runtime.handoff;
    const stage = resolveQuestionBlockedStage(handoff, policy.ok ? policy.value : undefined, {sessionId: ctx.sessionManager.getSessionId(), repo: handoff.repo, workflowId: handoff.workflowId});
    return stage ? {block: true, reason: QUESTION_BLOCK_REASON(stage)} : undefined;
  };
}
