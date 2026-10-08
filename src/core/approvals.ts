// Content approvals recorded only from a parent TUI confirmation of the exact content shown.
// Public Issue text such as `approved: true` or decision logs are never approvals.
import {join} from 'node:path';
import {failed, okValue, problem, isSha256, type ApprovalKind, type ApprovalRef, type CallScope, type Decoded, type RepoContext, type ScaffoldResult, type Sha256} from './contracts.js';
import {taggedDigest} from './digests.js';
import {OwnedFileError, readOwnedJson, writeOwnedFile} from './files.js';

export interface ApprovalUi {
  /** True only for a parent TUI session (not print/json/rpc, not a subagent child). */
  interactive: boolean;
  confirm(title: string, message: string, options?: {signal?: AbortSignal}): Promise<boolean>;
}
export interface ApprovalView { contentDigest: Sha256; text: string }
interface ApprovalRecord extends ApprovalRef { version: 1; profileId: string; profileInstructionsDigest: Sha256; sessionId: string; approvedAt: string }

const KIND_LABEL: Record<ApprovalKind, string> = {specification: '仕様の内容承認', 'implementation-start': '実装開始の指示', 'epic-completion': 'Epicの最終受け入れ'};
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

  async confirmContent(kind: ApprovalKind, workflowId: string, view: ApprovalView, context: RepoContext, ui: ApprovalUi, scope: CallScope): Promise<ScaffoldResult<ApprovalRef>> {
    const operation = 'confirm-content';
    const unbound = ApprovalStore.unbound(context);
    if (unbound.length) return {operation, status: 'blocked', problems: unbound};
    if (!ui.interactive) return {operation, status: 'blocked', problems: [problem('APPROVAL_UI_REQUIRED', kind, 'Only the parent TUI can record this approval; headless and child sessions may only reference an existing one.')]};
    if (!scope.isCurrent()) return {operation, status: 'cancelled', problems: [problem('STALE_SCOPE', kind, 'Session changed before confirmation.')]};
    const viewDigest = approvalViewDigest(kind, view);
    const message = `${view.text}\n\n――――\n種別: ${KIND_LABEL[kind]}\n対象: ${context.repo} / workflow ${workflowId}\n内容digest: ${viewDigest}`;
    let accepted = false;
    try { accepted = await ui.confirm(`pi-scaffold: ${KIND_LABEL[kind]}`, message, {signal: scope.signal}); } catch { accepted = false; }
    if (!accepted || !scope.isCurrent()) return {operation, status: 'cancelled', problems: [problem(accepted ? 'STALE_SCOPE' : 'DECLINED', kind, accepted ? 'Session changed during confirmation; nothing was recorded.' : 'Not approved.')]};
    const record: ApprovalRecord = {
      version: 1, kind, viewDigest, repo: context.repo, workflowId, accountBinding: context.accountBinding!,
      profileId: context.profileId!, profileInstructionsDigest: context.profileInstructionsDigest!, sessionId: scope.sessionId, approvedAt: new Date().toISOString(),
    };
    await writeOwnedFile(this.path(context, kind, viewDigest), JSON.stringify(record, null, 2), {root: this.root});
    return {operation, status: 'validated', data: {kind, viewDigest, repo: context.repo, workflowId, accountBinding: record.accountBinding}, problems: []};
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
    const same = record.version === 1 && record.kind === kind && record.viewDigest === viewDigest && record.repo === context.repo && record.workflowId === workflowId
      && record.accountBinding === context.accountBinding && record.profileId === context.profileId && record.profileInstructionsDigest === context.profileInstructionsDigest;
    if (!same) return failed([problem('APPROVAL_MISMATCH', kind, 'The recorded approval belongs to another content, workflow, account or profile.')]);
    return okValue({kind, viewDigest, repo: record.repo, workflowId, accountBinding: record.accountBinding});
  }
}
