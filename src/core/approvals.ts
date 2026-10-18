// Content approvals recorded only from a parent TUI confirmation of the exact content shown, or by the parent agent itself
// (approvedBy: "agent") when the owner policy says so: for a kind listed in `agentApprovals` (basis: "policy"), or in an
// agent-decision stage of the older `agentDecisionStages` (stage). Never by a subagent child.
// Public Issue text such as `approved: true` or decision logs are never approvals.
import {join} from 'node:path';
import {AGENT_DECISION_STAGES, failed, okValue, problem, isSha256, type AgentDecisionStage, type ApprovalKind, type ApprovalRef, type CallScope, type Decoded, type RepoContext, type ScaffoldResult, type Sha256} from './contracts.js';
import {taggedDigest} from './digests.js';
import {OwnedFileError, readOwnedJson, writeOwnedFile} from './files.js';

export interface ApprovalUi {
  /** True only for a parent TUI session (not print/json/rpc, not a subagent child). */
  interactive: boolean;
  /** True in a subagent child session; such a session never records an approval. */
  child?: boolean;
  confirm(title: string, message: string, options?: {signal?: AbortSignal}): Promise<boolean>;
}
export interface ApprovalView { contentDigest: Sha256; text: string }
interface ApprovalRecord extends ApprovalRef { version: 1; profileId: string; profileInstructionsDigest: Sha256; sessionId: string; approvedAt: string }
/**
 * Human records (also those of older versions) carry none of approvedBy/stage/basis. Agent records carry approvedBy and
 * either basis "policy" (no stage) or an agent-decision stage (no basis).
 */
const validOrigin = (r: ApprovalRecord) => r.approvedBy === undefined ? r.stage === undefined && r.basis === undefined
  : r.approvedBy === 'agent' && (r.basis === 'policy' ? r.stage === undefined : r.basis === undefined && (AGENT_DECISION_STAGES as readonly unknown[]).includes(r.stage));
/** Tool-result note for an approval the parent agent recorded itself. */
export const agentApprovalNote = (ref: ApprovalRef | undefined) => ref?.approvedBy === 'agent'
  ? {agentApproval: {kind: ref.kind, ...(ref.basis ? {basis: ref.basis} : {stage: ref.stage!}), viewDigest: ref.viewDigest}} : {};
/** Adds the note to a result's data object (results without data are returned as they are). */
export function withAgentApproval<R extends {data?: unknown}>(result: R, ref: ApprovalRef | undefined): R {
  const note = agentApprovalNote(ref);
  return 'agentApproval' in note && result.data && typeof result.data === 'object' ? {...result, data: {...result.data, ...note}} : result;
}

const KIND_LABEL: Record<ApprovalKind, string> = {specification: '仕様の内容承認', 'implementation-start': '実装開始の指示', 'epic-completion': 'Epicの最終受け入れ', 'specification-revision': '仕様の改訂'};
/** How an approval may be recorded without a human: `policy` (owner policy agentApprovals) or an old agent-decision stage. */
export interface AgentApprovalOptions { agentStage?: AgentDecisionStage; policy?: boolean }
/**
 * True when the only problem is that no usable record exists for this profile and account, so a person may be asked.
 * An approval of the same content that belongs to another profile or account is never reused; the person gives it again.
 * Anything else (unreadable or invalid record, unbound context) stays blocked.
 */
export const approvalNeedsConfirmation = (problems: readonly {code: string}[]): boolean => problems.length > 0 && problems.every(p => p.code === 'APPROVAL_MISSING' || p.code === 'APPROVAL_MISMATCH');
export function approvalViewDigest(kind: ApprovalKind, view: ApprovalView): Sha256 { return taggedDigest('approval-view', {kind, contentDigest: view.contentDigest, text: view.text}); }

export class ApprovalStore {
  constructor(private readonly root: string) {}
  private path(context: RepoContext, kind: ApprovalKind, viewDigest: Sha256) { return join(context.workflowStateRoot, 'approvals', kind, `${viewDigest}.json`); }
  private static unbound(context: RepoContext) {
    return [
      ...(context.accountBinding ? [] : [problem('ACCOUNT_UNBOUND', 'accountBinding', 'Owner policy does not declare authMode=file-backed for this repository.')]),
      ...(context.profileId && context.profileInstructionsDigest ? [] : [problem('PROFILE_UNBOUND', 'profileId', 'No pi-profile snapshot is recorded in this session.')]),
    ];
  }

  /**
   * `options` (from ToolCall.approvalOptions): with `policy` or `agentStage` the parent records the approval itself without
   * a dialog, in any mode (TUI or headless), because no human is involved. A child session is refused either way.
   */
  async confirmContent(kind: ApprovalKind, workflowId: string, view: ApprovalView, context: RepoContext, ui: ApprovalUi, scope: CallScope, options: AgentApprovalOptions = {}): Promise<ScaffoldResult<ApprovalRef>> {
    const operation = 'confirm-content';
    const unbound = ApprovalStore.unbound(context);
    if (unbound.length) return {operation, status: 'blocked', problems: unbound};
    if (ui.child) return {operation, status: 'blocked', problems: [problem('APPROVAL_UI_REQUIRED', kind, 'A subagent child session cannot record an approval; it may only reference an existing one.')]};
    if (options.policy || options.agentStage) {
      if (!scope.isCurrent()) return {operation, status: 'cancelled', problems: [problem('STALE_SCOPE', kind, 'Session changed; nothing was recorded.')]};
      return this.record(kind, workflowId, approvalViewDigest(kind, view), context, scope, options.policy ? {approvedBy: 'agent', basis: 'policy'} : {approvedBy: 'agent', stage: options.agentStage!});
    }
    if (!ui.interactive) return {operation, status: 'blocked', problems: [problem('APPROVAL_UI_REQUIRED', kind, 'Only the parent TUI can record this approval; headless and child sessions may only reference an existing one.')]};
    if (!scope.isCurrent()) return {operation, status: 'cancelled', problems: [problem('STALE_SCOPE', kind, 'Session changed before confirmation.')]};
    const viewDigest = approvalViewDigest(kind, view);
    const message = `${view.text}\n\n――――\n種別: ${KIND_LABEL[kind]}\n対象: ${context.repo} / workflow ${workflowId}\n内容digest: ${viewDigest}`;
    let accepted = false;
    try { accepted = await ui.confirm(`pi-scaffold: ${KIND_LABEL[kind]}`, message, {signal: scope.signal}); } catch { accepted = false; }
    if (!accepted || !scope.isCurrent()) return {operation, status: 'cancelled', problems: [problem(accepted ? 'STALE_SCOPE' : 'DECLINED', kind, accepted ? 'Session changed during confirmation; nothing was recorded.' : 'Not approved.')]};
    return this.record(kind, workflowId, viewDigest, context, scope, {});
  }
  private async record(kind: ApprovalKind, workflowId: string, viewDigest: Sha256, context: RepoContext, scope: CallScope, origin: {approvedBy?: 'agent'; stage?: AgentDecisionStage; basis?: 'policy'}): Promise<ScaffoldResult<ApprovalRef>> {
    const record: ApprovalRecord = {
      version: 1, kind, viewDigest, repo: context.repo, workflowId, accountBinding: context.accountBinding!,
      profileId: context.profileId!, profileInstructionsDigest: context.profileInstructionsDigest!, sessionId: scope.sessionId, approvedAt: new Date().toISOString(), ...origin,
    };
    await writeOwnedFile(this.path(context, kind, viewDigest), JSON.stringify(record, null, 2), {root: this.root});
    return {operation: 'confirm-content', status: 'validated', data: {kind, viewDigest, repo: context.repo, workflowId, accountBinding: record.accountBinding, ...origin}, problems: []};
  }

  /** Read-only lookup usable from any session; it never creates an approval. */
  async requireContentApproval(kind: ApprovalKind, workflowId: string, viewDigest: Sha256, context: RepoContext): Promise<Decoded<ApprovalRef>> {
    const unbound = ApprovalStore.unbound(context);
    if (unbound.length) return failed(unbound);
    if (!isSha256(viewDigest)) return failed([problem('INVALID_FORMAT', 'viewDigest', 'Expected sha256.')]);
    let record: ApprovalRecord;
    try { record = await readOwnedJson(this.path(context, kind, viewDigest), {root: this.root, maxBytes: 16 * 1024}) as ApprovalRecord; }
    catch (e) {
      if (e instanceof OwnedFileError && e.code === 'NOT_FOUND') return failed([problem('APPROVAL_MISSING', kind, 'No parent approval exists for this exact content.')]);
      return failed([problem(e instanceof OwnedFileError ? e.code : 'APPROVAL_INVALID', kind, (e as Error).message)]);
    }
    if (record?.version === 1 && !validOrigin(record)) return failed([problem('APPROVAL_INVALID', kind, 'The recorded approval has an unknown approvedBy/stage.')]);
    // A policy approval is the agent's own decision, not a person's reading of these instructions: their digest is kept in
    // the record but not compared, so changing the Profile text between stages does not invalidate it.
    const same = record.version === 1 && record.kind === kind && record.viewDigest === viewDigest && record.repo === context.repo && record.workflowId === workflowId
      && record.accountBinding === context.accountBinding && record.profileId === context.profileId
      && (record.basis === 'policy' || record.profileInstructionsDigest === context.profileInstructionsDigest);
    if (!same) return failed([problem('APPROVAL_MISMATCH', kind, 'The recorded approval belongs to another content, workflow, account or profile.')]);
    return okValue({kind, viewDigest, repo: record.repo, workflowId, accountBinding: record.accountBinding, ...(record.approvedBy === 'agent' ? {approvedBy: record.approvedBy, ...(record.basis === 'policy' ? {basis: record.basis} : {stage: record.stage!})} : {})});
  }
}
