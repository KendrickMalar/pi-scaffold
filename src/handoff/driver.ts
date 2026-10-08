// Shared handoff transport (#5, reused by #9/#14/#15): new Herdr tab → fixed pi-profile launch → receiver-ready →
// conditional Epic stage/label commit → fixed stage prompt → started receipt. Every step is journaled; unknown
// outcomes are reconciled (tab label / receipts / Issue state) and never retried blindly. No tab is closed.
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {
  problem, type EpicDocV1, type GateResult, type IssueSnapshot, type MutationInput, type Problem, type ScaffoldResult, type Stage,
} from '../core/contracts.js';
import {patchDoc} from '../core/body-codec.js';
import {sha256Text, taggedDigest} from '../core/digests.js';
import {writeOwnedFile} from '../core/files.js';
import {withOperation, type OperationRun} from '../core/lifecycle.js';
import {prepareLabelEdit} from '../core/label-policy.js';
import type {ToolCall} from '../core/runtime.js';
import {readIssue, type GhOutcome} from '../ports/pi-gh.js';
import {HerdrError, SUPPORTED_HERDR, type HerdrPort} from './herdr-client.js';
import {buildLaunchCommand, unsafeLaunchValues} from './launcher.js';
import {promptTag} from './receiver.js';
import {handoffDir, nonceSha256, readReceipt, writePacket, type HandoffPacketV1, type ReceiptPhase} from './packet.js';

export interface HandoffInput extends MutationInput { expectedStage: Stage; nextStage: Stage }
export interface HandoffData { nonceSha256: string; tabId: string; paneId: string; targetSessionId: string; phase: string }
export type StageGate = (snapshot: IssueSnapshot) => Promise<GateResult>;
/** pi-gh tools every Scaffold stage session needs, besides this package's own registered tools. */
export const BASE_REQUIRED_TOOLS = ['gh_capabilities', 'gh_issue_get', 'gh_issue_edit_if_current', 'gh_issue_labels_if_current'];
const STAGE_NAMES: Partial<Record<Stage, string>> = {specification: '仕様策定（Specification）', 'basic-design': '基本設計（BasicDesign）', implementation: '詳細設計・実装（Implementation）', verification: '検証（Verification）'};

export function stagePrompt(stage: Stage, repo: string, epic: number, nonceSha: string): string {
  return `pi-scaffold: このセッションは Epic #${epic}（${repo}）の${STAGE_NAMES[stage] ?? stage}工程です。Epic を読み込み、この工程の作業を始めてください。前の会話の内容は引き継いでいません。［${promptTag(nonceSha)}］`;
}

/** Input-bound checks that must hold until this operation itself commits the stage (re-run right before the body write). */
async function readyForCommit(snapshot: IssueSnapshot, input: HandoffInput, gate: StageGate): Promise<Problem[]> {
  const doc = snapshot.doc;
  if (doc.kind !== 'epic') return [problem('NOT_AN_EPIC', 'epicIssue', `#${input.epicIssue} is not a Scaffold Epic.`)];
  if (snapshot.bodySha256 !== input.expectedBodySha256) return [problem('STALE_BODY', 'expectedBodySha256', 'Epic body changed; read it again.')];
  if (doc.revision !== input.expectedRevision) return [problem('STALE_REVISION', 'expectedRevision', `Epic revision is ${doc.revision}.`)];
  if (doc.stage !== input.expectedStage) return [problem('STAGE_MISMATCH', 'expectedStage', `Epic is in ${doc.stage}, not ${input.expectedStage}.`)];
  const labelPlan = prepareLabelEdit(snapshot, {type: 'Scaffold', scope: 'Epic', stage: input.nextStage});
  if (!labelPlan.ok) return labelPlan.problems;
  const gated = await gate(snapshot);
  return gated.status === 'validated' ? [] : gated.problems;
}
/** This operation has already committed the stage (its own handoff state is in the Epic). */
const committedBy = (s: IssueSnapshot, input: HandoffInput) => s.doc.kind === 'epic' && s.doc.stage === input.nextStage && s.doc.handoff?.operationId === input.operationId;
/** committedBy, and this journal really holds that operation (not abandoned). */
export async function committedByUs(s: IssueSnapshot, input: HandoffInput, journal: {list(): Promise<{operationId: string; abandonedAt?: string}[]>}): Promise<boolean> {
  return committedBy(s, input) && (await journal.list()).some(r => r.operationId === input.operationId && !r.abandonedAt);
}

async function herdrStep<T>(fn: () => Promise<T>): Promise<GhOutcome<T>> {
  try { return {status: 'ok', data: await fn(), problems: [], isError: false}; }
  catch (e) {
    const kind = e instanceof HerdrError ? e.kind : 'unknown';
    const p = [problem(kind === 'unknown' ? 'HERDR_OUTCOME_UNKNOWN' : 'HERDR_FAILED', 'herdr', (e as Error).message)];
    return {status: kind === 'unknown' ? 'unknown' : 'blocked', problems: p, isError: true};
  }
}

export async function handoffStage(input: HandoffInput, gate: StageGate, call: ToolCall, operation: string): Promise<ScaffoldResult<HandoffData>> {
  const blocked = (problems: Problem[]): ScaffoldResult<HandoffData> => ({status: 'blocked', operation, problems});
  const env = call.environment();
  // ---- preconditions: any failure here has zero side effects -------------------------------------
  if (env.HERDR_ENV !== '1' || !env.HERDR_WORKSPACE_ID || !env.HERDR_PANE_ID) return blocked([problem('HERDR_UNAVAILABLE', 'herdr', 'This session is not running inside Herdr.')]);
  if (env.PI_SUBAGENT_CHILD) return blocked([problem('CHILD_SESSION', 'session', 'A subagent child cannot start a stage session.')]);
  const herdr: HerdrPort = call.herdr();
  let version: {version: string; protocol: number};
  try { version = await herdr.version(); } catch (e) { return blocked([problem('HERDR_UNAVAILABLE', 'herdr', (e as Error).message)]); }
  if (version.version !== SUPPORTED_HERDR.version || version.protocol !== SUPPORTED_HERDR.protocol)
    return blocked([problem('HERDR_UNSUPPORTED', 'herdr', `Herdr ${version.version}/protocol ${version.protocol} is not verified (need ${SUPPORTED_HERDR.version}/${SUPPORTED_HERDR.protocol}).`)]);
  const caps = await call.bridge.requireCapabilities(['gh_issue_get', 'gh_issue_edit_if_current', 'gh_issue_labels_if_current'], call.scope);
  if (!caps.ok) return blocked(caps.problems);
  const repoOnly = await call.repoContext(input.repo, null);
  if (!repoOnly.ok) return blocked(repoOnly.problems);
  const snap = await readIssue(input.repo, input.epicIssue, call.bridge, call.scope);
  if (!snap.ok) return blocked(snap.problems);
  const doc = snap.value.doc;
  if (doc.kind !== 'epic') return blocked([problem('NOT_AN_EPIC', 'epicIssue', `#${input.epicIssue} is not a Scaffold Epic.`)]);
  const context = await call.repoContext(input.repo, doc.workflowId);
  if (!context.ok) return blocked(context.problems);
  const ctx = context.value;
  const journal = call.journal(ctx);
  // Until this operation commits the stage itself, the Epic must still match the caller's input — also on resume.
  // An Epic that only *names* this operation (no live journal record here) is not trusted as our commit.
  if (!(await committedByUs(snap.value, input, journal))) { const p = await readyForCommit(snap.value, input, gate); if (p.length) return blocked(p); }
  const busy = (await journal.list()).filter(r => !r.abandonedAt && r.operationId !== input.operationId && r.operation === operation && ['running', 'partial', 'unknown'].includes(r.status));
  if (busy.length) {
    const stuck = problem('HANDOFF_IN_PROGRESS', 'operationId', `Another handoff of this Epic is in progress (${busy.map(r => r.operationId).join(', ')}); resume it, or abandon it from the parent TUI to start over.`);
    // Only a human in the parent TUI may abandon a stuck handoff. Its tab and any receiving session are left as they are.
    if (!call.env.approvalUi.interactive) return blocked([stuck]);
    const details = busy.map(r => {
      const tab = r.steps.find(s => s.name === 'tab-ids')?.data as {tabId?: string; paneId?: string} | undefined;
      return `- operation ${r.operationId}（状態: ${r.status}、最後の段階: ${r.steps.at(-1)?.name ?? 'なし'}${tab?.tabId ? `、タブ ${tab.tabId}` : ''}）`;
    }).join('\n');
    let ok = false;
    try { ok = await call.env.approvalUi.confirm('pi-scaffold: 止まっている引き継ぎを放棄しますか？', `Epic #${input.epicIssue}（${input.repo}）に、終わっていない引き継ぎがあります。\n${details}\n\n放棄すると、その引き継ぎは再開できなくなり、新しい引き継ぎを始めます。既存のタブや起動済みのPiは閉じません。GitHubのStage・本文は変えません。`, {signal: call.scope.signal}); } catch { ok = false; }
    if (!ok || !call.scope.isCurrent()) return blocked([stuck]);
    for (const r of busy) await journal.abandon(r.operationId);
  }
  if (ctx.profileId !== 'developer' || !ctx.profileInstructionsDigest) return blocked([problem('PROFILE_NOT_DEVELOPMENT', 'profile', 'Stage sessions start only from the Development (developer) Profile.')]);
  if (!ctx.accountBinding) return blocked([problem('ACCOUNT_UNBOUND', 'account', 'Owner policy must declare authMode "file-backed" for this repository.')]);
  const names = call.env.toolNames();
  const missingTools = BASE_REQUIRED_TOOLS.filter(t => !names.includes(t));
  if (missingTools.length) return blocked([problem('REQUIRED_TOOL_MISSING', 'tools', `This session lacks ${missingTools.join(', ')}; the receiving session would too.`)]);
  const requiredTools = [...BASE_REQUIRED_TOOLS, ...names.filter(n => n.startsWith('scaffold_'))].sort();
  const binding = {workspaceId: env.HERDR_WORKSPACE_ID, paneId: env.HERDR_PANE_ID};
  let live: {workspaceId: string; paneId: string};
  try { live = await herdr.currentPane(); } catch (e) { return blocked([problem('HERDR_UNAVAILABLE', 'herdr', (e as Error).message)]); }
  if (live.workspaceId !== binding.workspaceId || live.paneId !== binding.paneId) return blocked([problem('HERDR_BINDING_CHANGED', 'herdr', 'This tool is no longer running in the pane it was started from.')]);
  const model = call.env.currentModel();
  const dir = handoffDir(ctx.workflowStateRoot, input.operationId);
  const unsafe = unsafeLaunchValues({packetPath: join(dir, 'packet.json'), ...(model ? {model: model.model, thinking: model.thinking} : {})});
  if (unsafe.length) return blocked([problem('UNSAFE_LAUNCH_VALUE', unsafe.join(','), `The launch command would contain ${unsafe.join(' and ')} with characters other than A-Z a-z 0-9 . _ / : @ + - (for example spaces or non-ASCII in the agent directory path). Nothing was started; use a plain path/model id.`)]);

  const payloadDigest = taggedDigest('handoff', {input, requiredTools});
  const result = await withOperation({operation, repo: input.repo, workflowId: doc.workflowId, operationId: input.operationId, payloadDigest, journal, scope: call.scope}, async run => {
    const budget = () => { if (call.overBudget()) run.pause([problem('CALL_BUDGET_EXHAUSTED', '', 'Call budget used; progress is recorded. Call again with the same operationId.')]); };
    const checkBinding = async () => {
      run.checkpoint();
      let now: {workspaceId: string; paneId: string};
      try { now = await herdr.currentPane(); } catch (e) { return run.stop([problem('HERDR_UNAVAILABLE', 'herdr', (e as Error).message)]); }
      if (now.workspaceId !== binding.workspaceId || now.paneId !== binding.paneId) run.stop([problem('HERDR_BINDING_CHANGED', 'herdr', 'The calling pane moved or reconnected; stopped instead of controlling another pane.')]);
    };
    // prepared: private packet with a fresh nonce (journal keeps only its digest and path).
    budget();
    let prepared = run.done('prepared') as {packetPath: string; packetSha256: string; nonceSha256: string} | undefined;
    if (!prepared) {
      const nonce = randomBytes(32).toString('hex');
      const packet: HandoffPacketV1 = {
        version: 1, nonce, workflowId: doc.workflowId, repo: input.repo, epicIssue: input.epicIssue, sourceStage: input.expectedStage, targetStage: input.nextStage,
        artifactDigests: {epicBodySha256: snap.value.bodySha256, epicLabelsSha256: snap.value.labelsSha256}, cwd: ctx.repoRoot,
        profileId: ctx.profileId!, profileInstructionsDigest: ctx.profileInstructionsDigest!, accountBinding: ctx.accountBinding!, requiredTools, resourceRefs: [],
      };
      const written = await writePacket(dir, packet, call.namespaceRoot);
      prepared = {packetPath: written.path, packetSha256: written.sha256, nonceSha256: nonceSha256(nonce)};
      run.note('prepared', prepared);
    }
    const label = `scaffold-${prepared.nonceSha256.slice(0, 12)}`;
    // tab-created (no focus; reconciled by its unique label, never created twice).
    await checkBinding();
    let found: {tabId: string; paneId: string} | undefined;
    const tab = (await run.write('tab-create', () => herdrStep(() => herdr.tabCreate({workspaceId: binding.workspaceId, cwd: ctx.repoRoot, label})), {
      reconcile: async () => {
        // The label is unique per packet: a complete listing without it means the tab was never created.
        try { const tabs = await herdr.tabList(binding.workspaceId); const t = tabs.find(x => x.label === label); if (t?.paneId) { found = {tabId: t.tabId, paneId: t.paneId}; return 'applied'; } return t ? 'unknown' : 'not-applied'; }
        catch { return 'unknown'; }
      },
    })) ?? found ?? run.done('tab-ids') as {tabId: string; paneId: string} | undefined;
    if (!tab) return run.stop([problem('HERDR_TAB_UNKNOWN', 'herdr', 'The created tab could not be identified.')]);
    run.note('tab-ids', tab);
    // pane-run: the fixed launch command in the created root pane only.
    const waitReceipt = async (phase: ReceiptPhase) => {
      const deadline = Math.min(call.now() + (call.runtime.waitMs ?? 60_000), call.deadline);
      for (;;) {
        const r = await readReceipt(dir, phase, call.namespaceRoot);
        if (r) {
          if (r.packetSha256 !== prepared!.packetSha256 || r.nonceSha256 !== prepared!.nonceSha256) return run.stop([problem('RECEIVER_PACKET_MISMATCH', 'receipt', 'The receiver confirmed a different packet; it was changed after it was written.')]);
          return r;
        }
        if (call.now() >= deadline || !run.scope.isCurrent()) return undefined;
        await new Promise(res => setTimeout(res, call.runtime.pollMs ?? 500));
      }
    };
    budget();
    const runStep = run.record.steps.find(s => s.name === 'pane-run');
    if (!runStep || runStep.phase === 'failed') {
      // Only an idle shell receives the launch command (also before a retry after a definite failure).
      await checkBinding();
      let shell: {shellReady: boolean};
      try { shell = await herdr.processInfo(tab.paneId); } catch (e) { return run.stop([problem('HERDR_FAILED', 'herdr', (e as Error).message)]); }
      if (!shell.shellReady) return run.stop([problem('HERDR_PANE_BUSY', 'herdr', 'The new tab is not at an idle shell; nothing was run.')]);
    }
    await run.write('pane-run', () => herdrStep(() => herdr.paneRun(tab.paneId, buildLaunchCommand({packetPath: prepared!.packetPath, ...(model ? {model: model.model, thinking: model.thinking} : {})}))).then(o => ({...o, data: o.status === 'ok' ? true : undefined})), {
      reconcile: async () => (await readReceipt(dir, 'receiver-ready', call.namespaceRoot)) ? 'applied' : 'unknown',
    });
    // receiver-ready: the new session confirmed cwd/profile/account/tools for this packet.
    const ready = await waitReceipt('receiver-ready');
    if (!ready) return run.pause([problem('RECEIVER_NOT_READY', 'receiver', 'The new session has not confirmed the packet yet; call again with the same operationId.')]);
    run.note('receiver-ready', {sessionId: ready.sessionId});
    budget();
    // stage-committed: conditional Epic body (stage + public handoff state) then conditional labels.
    await commitStage(run, call, input, gate, prepared.nonceSha256, dir);
    budget();
    // prompt-sent: fixed stage prompt to the recognized agent in the created pane.
    await checkBinding();
    await run.write('prompt', () => herdrStep(() => herdr.agentPrompt(tab.paneId, stagePrompt(input.nextStage, input.repo, input.epicIssue, prepared!.nonceSha256))).then(o => ({...o, data: o.status === 'ok' ? true : undefined})), {
      reconcile: async () => (await readReceipt(dir, 'turn-started', call.namespaceRoot)) ? 'applied' : 'unknown',
    });
    // turn-started: only a started receipt from the same session completes the handoff.
    const started = await waitReceipt('turn-started');
    if (!started) return run.pause([problem('TURN_NOT_STARTED', 'receiver', 'The prompt was sent but the new session has not started its turn yet; call again with the same operationId.')]);
    if (started.sessionId !== ready.sessionId) return run.stop([problem('RECEIVER_SESSION_MISMATCH', 'receiver', 'A different session reported the start.')]);
    return {status: 'applied', data: {nonceSha256: prepared.nonceSha256, tabId: tab.tabId, paneId: tab.paneId, targetSessionId: started.sessionId, phase: 'turn-started'}};
  });
  return result as ScaffoldResult<HandoffData>;
}

async function commitStage(run: OperationRun, call: ToolCall, input: HandoffInput, gate: StageGate, nonceSha: string, dir: string): Promise<void> {
  const reread = async () => { const r = await readIssue(input.repo, input.epicIssue, call.bridge, call.scope); if (!r.ok) run.stop(r.problems); return (r as {ok: true; value: IssueSnapshot}).value; };
  const committed = (s: IssueSnapshot) => committedBy(s, input) && (s.doc as EpicDocV1).handoff?.nonceSha256 === nonceSha;
  const bodyStep = run.record.steps.find(st => st.name === 'stage-body');
  let current = await reread();
  if (bodyStep?.phase !== 'done' && !committed(current)) {
    // Re-check everything against the caller's input right before writing (stale body, stage, Blocked, gate).
    if (!bodyStep || bodyStep.phase === 'failed') { const p = await readyForCommit(current, input, gate); if (p.length) run.stop(p); }
    const doc = current.doc as EpicDocV1;
    const next: EpicDocV1 = {...doc, stage: input.nextStage, handoff: {nonceSha256: nonceSha, sourceStage: input.expectedStage, targetStage: input.nextStage, phase: 'stage-committed', operationId: input.operationId}};
    const edit = patchDoc(current, next);
    if (!edit.ok) run.stop(edit.problems);
    const bodyPath = join(dir, 'stage-body.json');
    const expected = current.bodySha256;
    await run.write('stage-body', async () => {
      await writeOwnedFile(bodyPath, JSON.stringify({version: 1, repo: input.repo, operation: 'issue-edit-if-current', issue: input.epicIssue, body: (edit as {ok: true; value: {body: string}}).value.body, expectedBodySha256: expected}), {root: call.namespaceRoot});
      return call.bridge.call('gh_issue_edit_if_current', {changePath: bodyPath}, () => true as const, call.scope);
    }, {reconcile: async () => { const s = await reread(); return committed(s) ? 'applied' : s.bodySha256 === expected ? 'not-applied' : 'unknown'; }});
    current = await reread();
  }
  if (!committed(current)) run.stop([problem('STAGE_NOT_COMMITTED', 'epic', 'The Epic body does not show this operation\'s committed stage.')]);
  const plan = prepareLabelEdit(current, {type: 'Scaffold', scope: 'Epic', stage: input.nextStage});
  if (!plan.ok) return run.stop(plan.problems);
  if (!plan.value.add.length && !plan.value.remove.length) return;
  const labelsPath = join(dir, 'stage-labels.json');
  const before = current.labels;
  await run.write('stage-labels', async () => {
    await writeOwnedFile(labelsPath, JSON.stringify({version: 1, repo: input.repo, operation: 'issue-labels-if-current', issue: input.epicIssue, add: plan.value.add, remove: plan.value.remove, expectedLabelsSha256: plan.value.expectedLabelsSha256}), {root: call.namespaceRoot});
    return call.bridge.call('gh_issue_labels_if_current', {changePath: labelsPath}, () => true as const, call.scope);
  }, {reconcile: async () => { const s = await reread(); const ok = plan.value.add.every(l => s.labels.includes(l)) && plan.value.remove.every(l => !s.labels.includes(l)); return ok ? 'applied' : sha256Text(JSON.stringify([...s.labels].sort())) === sha256Text(JSON.stringify([...before].sort())) ? 'not-applied' : 'unknown'; }});
}
