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
import {buildLaunchCommand} from './launcher.js';
import {handoffDir, nonceSha256, readReceipt, writePacket, type HandoffPacketV1, type ReceiptPhase} from './packet.js';

export interface HandoffInput extends MutationInput { expectedStage: Stage; nextStage: Stage }
export interface HandoffData { nonceSha256: string; tabId: string; paneId: string; targetSessionId: string; phase: string }
export type StageGate = (snapshot: IssueSnapshot) => Promise<GateResult>;
/** pi-gh tools every Scaffold stage session needs, besides this package's own registered tools. */
export const BASE_REQUIRED_TOOLS = ['gh_capabilities', 'gh_issue_get', 'gh_issue_edit_if_current', 'gh_issue_labels_if_current'];
const STAGE_NAMES: Partial<Record<Stage, string>> = {specification: '仕様策定（Specification）', 'basic-design': '基本設計（BasicDesign）', implementation: '詳細設計・実装（Implementation）', verification: '検証（Verification）'};

export function stagePrompt(stage: Stage, repo: string, epic: number): string {
  return `pi-scaffold: このセッションは Epic #${epic}（${repo}）の${STAGE_NAMES[stage] ?? stage}工程です。Epic を読み込み、この工程の作業を始めてください。前の会話の内容は引き継いでいません。`;
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
  // A resumed operation has already changed the Epic itself (stage/labels); its progress is checked by the journal
  // and each step's reconcile instead of comparing with the caller's original snapshot.
  const resuming = !!(await call.journal(ctx).load(input.operationId));
  if (!resuming) {
    if (snap.value.bodySha256 !== input.expectedBodySha256) return blocked([problem('STALE_BODY', 'expectedBodySha256', 'Epic body changed; read it again.')]);
    if (doc.revision !== input.expectedRevision) return blocked([problem('STALE_REVISION', 'expectedRevision', `Epic revision is ${doc.revision}.`)]);
    if (doc.stage !== input.expectedStage) return blocked([problem('STAGE_MISMATCH', 'expectedStage', `Epic is in ${doc.stage}, not ${input.expectedStage}.`)]);
    const labelPlan = prepareLabelEdit(snap.value, {type: 'Scaffold', scope: 'Epic', stage: input.nextStage});
    if (!labelPlan.ok) return blocked(labelPlan.problems);
    const gated = await gate(snap.value);
    if (gated.status !== 'validated') return blocked(gated.problems);
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
  const payloadDigest = taggedDigest('handoff', {input, requiredTools});
  const result = await withOperation({operation, repo: input.repo, workflowId: doc.workflowId, operationId: input.operationId, payloadDigest, journal: call.journal(ctx), scope: call.scope}, async run => {
    const checkBinding = async () => {
      run.checkpoint();
      let now: {workspaceId: string; paneId: string};
      try { now = await herdr.currentPane(); } catch (e) { return run.stop([problem('HERDR_UNAVAILABLE', 'herdr', (e as Error).message)]); }
      if (now.workspaceId !== binding.workspaceId || now.paneId !== binding.paneId) run.stop([problem('HERDR_BINDING_CHANGED', 'herdr', 'The calling pane moved or reconnected; stopped instead of controlling another pane.')]);
    };
    // prepared: private packet with a fresh nonce (journal keeps only its digest and path).
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
        try { const t = (await herdr.tabList(binding.workspaceId)).find(x => x.label === label); if (t?.paneId) { found = {tabId: t.tabId, paneId: t.paneId}; return 'applied'; } }
        catch { /* stays unknown */ }
        return 'unknown';
      },
    })) ?? found ?? run.done('tab-ids') as {tabId: string; paneId: string} | undefined;
    if (!tab) return run.stop([problem('HERDR_TAB_UNKNOWN', 'herdr', 'The created tab could not be identified.')]);
    run.note('tab-ids', tab);
    // pane-run: the fixed launch command in the created root pane only.
    const waitReceipt = async (phase: ReceiptPhase) => {
      const deadline = call.now() + (call.runtime.waitMs ?? 60_000);
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
    if (!run.done('pane-run')) {
      await checkBinding();
      let shell: {shellReady: boolean};
      try { shell = await herdr.processInfo(tab.paneId); } catch (e) { return run.stop([problem('HERDR_FAILED', 'herdr', (e as Error).message)]); }
      if (!shell.shellReady && !run.record.steps.some(s => s.name === 'pane-run')) return run.stop([problem('HERDR_PANE_BUSY', 'herdr', 'The new tab is not at an idle shell; nothing was run.')]);
    }
    await run.write('pane-run', () => herdrStep(() => herdr.paneRun(tab.paneId, buildLaunchCommand({packetPath: prepared!.packetPath, ...(model ? {model: model.model, thinking: model.thinking} : {})}))).then(o => ({...o, data: o.status === 'ok' ? true : undefined})), {
      reconcile: async () => (await readReceipt(dir, 'receiver-ready', call.namespaceRoot)) ? 'applied' : 'unknown',
    });
    // receiver-ready: the new session confirmed cwd/profile/account/tools for this packet.
    const ready = await waitReceipt('receiver-ready');
    if (!ready) return run.pause([problem('RECEIVER_NOT_READY', 'receiver', 'The new session has not confirmed the packet yet; call again with the same operationId.')]);
    run.note('receiver-ready', {sessionId: ready.sessionId});
    // stage-committed: conditional Epic body (stage + public handoff state) then conditional labels.
    await commitStage(run, call, input, snap.value, doc, prepared.nonceSha256, dir);
    // prompt-sent: fixed stage prompt to the recognized agent in the created pane.
    await checkBinding();
    await run.write('prompt', () => herdrStep(() => herdr.agentPrompt(tab.paneId, stagePrompt(input.nextStage, input.repo, input.epicIssue))).then(o => ({...o, data: o.status === 'ok' ? true : undefined})), {
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

async function commitStage(run: OperationRun, call: ToolCall, input: HandoffInput, original: IssueSnapshot, doc: EpicDocV1, nonceSha: string, dir: string): Promise<void> {
  const reread = async () => { const r = await readIssue(input.repo, input.epicIssue, call.bridge, call.scope); if (!r.ok) run.stop(r.problems); return (r as {ok: true; value: IssueSnapshot}).value; };
  const committed = (s: IssueSnapshot) => s.doc.kind === 'epic' && s.doc.stage === input.nextStage && s.doc.handoff?.nonceSha256 === nonceSha;
  if (!run.done('stage-body')) {
    const current = await reread();
    if (!committed(current) && current.bodySha256 !== original.bodySha256) run.stop([problem('STALE_BODY', 'epic', 'The Epic changed after it was checked; the stage was not committed.')]);
  }
  const next: EpicDocV1 = {...doc, stage: input.nextStage, handoff: {nonceSha256: nonceSha, sourceStage: input.expectedStage, targetStage: input.nextStage, phase: 'stage-committed', operationId: input.operationId}};
  const edit = patchDoc(original, next);
  if (!edit.ok) run.stop(edit.problems);
  const bodyPath = join(dir, 'stage-body.json');
  await run.write('stage-body', async () => {
    await writeOwnedFile(bodyPath, JSON.stringify({version: 1, repo: input.repo, operation: 'issue-edit-if-current', issue: input.epicIssue, body: (edit as {ok: true; value: {body: string}}).value.body, expectedBodySha256: original.bodySha256}), {root: call.namespaceRoot});
    return call.bridge.call('gh_issue_edit_if_current', {changePath: bodyPath}, () => true as const, call.scope);
  }, {reconcile: async () => { const s = await reread(); return committed(s) ? 'applied' : s.bodySha256 === original.bodySha256 ? 'not-applied' : 'unknown'; }});
  const afterBody = await reread();
  if (!committed(afterBody)) run.stop([problem('STAGE_NOT_COMMITTED', 'epic', 'The Epic body does not show the committed stage.')]);
  const plan = prepareLabelEdit(afterBody, {type: 'Scaffold', scope: 'Epic', stage: input.nextStage});
  if (!plan.ok) return run.stop(plan.problems);
  if (!plan.value.add.length && !plan.value.remove.length) return;
  const labelsPath = join(dir, 'stage-labels.json');
  const before = afterBody.labels;
  await run.write('stage-labels', async () => {
    await writeOwnedFile(labelsPath, JSON.stringify({version: 1, repo: input.repo, operation: 'issue-labels-if-current', issue: input.epicIssue, add: plan.value.add, remove: plan.value.remove, expectedLabelsSha256: plan.value.expectedLabelsSha256}), {root: call.namespaceRoot});
    return call.bridge.call('gh_issue_labels_if_current', {changePath: labelsPath}, () => true as const, call.scope);
  }, {reconcile: async () => { const s = await reread(); const ok = plan.value.add.every(l => s.labels.includes(l)) && plan.value.remove.every(l => !s.labels.includes(l)); return ok ? 'applied' : sha256Text(JSON.stringify([...s.labels].sort())) === sha256Text(JSON.stringify([...before].sort())) ? 'not-applied' : 'unknown'; }});
}
