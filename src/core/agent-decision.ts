// Agent decision stages (owner policy `agentDecisionStages`). Questions to the human are allowed only up to basic
// design; in a listed implementation/verification session the parent agent decides within the approved spec/design,
// records its decisions, and records content approvals itself. The one exception is a request that the human do a
// prerequisite task (every question starts with 【事前作業】); decision questions stay blocked. The session stage is the targetStage of the handoff
// packet this session accepted; without an accepted packet there is no stage and nothing changes.
import {AGENT_DECISION_STAGES, type AgentDecisionStage, type Stage} from './contracts.js';
import {loadOwnerPolicy, repoPolicyFor, type OwnerPolicy} from './model-bindings.js';

/** The handoff packet accepted by this process's session (set by the extension on session_start). */
export interface AcceptedHandoff { sessionId: string; repo: string; workflowId: string; targetStage: Stage }

/** Tools that ask the human a question; blocked in agent-decision stages (real Pi only: needs `tool_call` events). */
export const AGENT_DECISION_BLOCKED_TOOLS: readonly string[] = ['ask_user', 'AskUserQuestion'];

/** Marker for a request that the human do a prerequisite task (not a decision). Every question must start with it. */
export const PREREQUISITE_QUESTION_MARKER = '【事前作業】';

export const QUESTION_BLOCK_REASON = (stage: AgentDecisionStage) =>
  `pi-scaffold: この${stage === 'implementation' ? '実装（Implementation）' : '検証（Verification）'}工程では人間に質問できません（owner policy の agentDecisionStages）。承認済みの仕様・設計の範囲で自分で判断して進め、判断した内容と理由を Issue と最終報告に記録してください。仕様・設計の範囲を超える判断が必要なら、作業を止めてその旨を Issue と最終報告に書いてください。\n` +
  `例外：人にしかできない事前作業（ログイン、権限の許可、キーの登録など）が欠けて止まったときだけ、すべての質問文の先頭を「${PREREQUISITE_QUESTION_MARKER}」にすれば作業の依頼として聞けます。判断を求める質問には使えません。`;

/**
 * The question texts of an ask_user / AskUserQuestion call, or undefined when the input has an unknown shape.
 * ask_user (pi-ask-user): `{question: string, ...}`. AskUserQuestion (Claude Code shape): `{questions: [{question: string, ...}, ...]}`.
 * When both fields are present, all of them count.
 */
function questionTexts(input: unknown): string[] | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const {question, questions} = input as {question?: unknown; questions?: unknown};
  const texts: string[] = [];
  if (question !== undefined) {
    if (typeof question !== 'string') return undefined;
    texts.push(question);
  }
  if (questions !== undefined) {
    if (!Array.isArray(questions) || questions.length === 0) return undefined;
    for (const q of questions) {
      const text = typeof q === 'string' ? q : typeof q === 'object' && q !== null ? (q as {question?: unknown}).question : undefined;
      if (typeof text !== 'string') return undefined;
      texts.push(text);
    }
  }
  return texts.length > 0 ? texts : undefined;
}

/** True when every question of the call starts with the prerequisite marker (leading whitespace ignored). */
export function isPrerequisiteRequest(input: unknown): boolean {
  const texts = questionTexts(input);
  return texts !== undefined && texts.every(t => t.trimStart().startsWith(PREREQUISITE_QUESTION_MARKER));
}

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
 * `tool_call` handler: blocks question tools in a listed stage, except a prerequisite-task request (every question
 * starts with {@link PREREQUISITE_QUESTION_MARKER}). Other tools return at once without any file read. A missing or
 * invalid policy never blocks. Hosts that never emit `tool_call` are unaffected.
 */
export function questionGuard(runtime: {agentDir: string; handoff?: AcceptedHandoff}) {
  return async (event: {toolName: string; input?: unknown}, ctx: {sessionManager: {getSessionId(): string}}): Promise<{block: true; reason: string} | undefined> => {
    if (!AGENT_DECISION_BLOCKED_TOOLS.includes(event.toolName) || !runtime.handoff) return undefined;
    if (isPrerequisiteRequest(event.input)) return undefined;
    const policy = await loadOwnerPolicy(runtime.agentDir);
    const handoff = runtime.handoff;
    const stage = resolveAgentDecisionStage(handoff, policy.ok ? policy.value : undefined, {sessionId: ctx.sessionManager.getSessionId(), repo: handoff.repo, workflowId: handoff.workflowId});
    return stage ? {block: true, reason: QUESTION_BLOCK_REASON(stage)} : undefined;
  };
}
