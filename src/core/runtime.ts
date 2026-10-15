// Node-only runtime shared by every tool service. The Pi adapter (extensions/tool-kit.ts) fills ToolEnv
// from the tool context; tests fill it with fakes. Factories only build objects; nothing starts here.
import {homedir} from 'node:os';
import {realpath} from 'node:fs/promises';
import {LIMITS, failed, problem, type AgentDecisionStage, type CallScope, type Decoded, type RepoContext} from './contracts.js';
import {RuntimeScope} from './lifecycle.js';
import {OperationJournal} from './journal.js';
import {ApprovalStore, type ApprovalUi} from './approvals.js';
import {loadOwnerPolicy, type OwnerPolicy} from './model-bindings.js';
import {resolveAgentDecisionStage, type AcceptedHandoff} from './agent-decision.js';
import {deriveRepoContext, resolveAgentDir, resolveScaffoldDir} from './repo-context.js';
import {PiGhBridge, type ToolExecutor} from '../ports/pi-gh.js';
import {createGitReader, type GitReader} from '../ports/git-read.js';
import {createHerdrCli, type HerdrPort} from '../handoff/herdr-client.js';
import type {WatchEntry} from '../watch/decide.js';

export interface ToolEnv {
  cwd: string;
  isProjectTrusted(): boolean;
  executeTool: ToolExecutor;
  approvalUi: ApprovalUi;
  identity(): {sessionId: string; leafId: string};
  sessionEntries(): readonly unknown[];
  availableModels(): string[];
  scopedModels(): string[];
  /** Names of the tools registered in this session. */
  toolNames(): string[];
  /** The session's current model and thinking level; undefined when Pi does not report them. Never called, only recorded. */
  currentModel(): {model: string; thinking: string} | undefined;
}
export interface ScaffoldRuntime {
  scope: RuntimeScope; agentDir: string; scaffoldDir: string; git: GitReader; timeoutMs?: number;
  /** Process environment (HERDR_*, PI_SUBAGENT_CHILD); tests inject a synthetic one. */
  environment?: () => Record<string, string | undefined>;
  herdr?: () => HerdrPort;
  /** Receipt waits: total per call and poll interval. */
  waitMs?: number; pollMs?: number;
  /** Work budget of one tool call; long work pauses as `partial` and resumes with the same operationId. */
  budgetMs?: number;
  now?: () => number;
  /** Set by the extension: tools currently active for the model (plan mode may narrow this). Falls back to ctx.tools. */
  activeToolNames?: () => string[];
  /** Set by the extension: registers an applied handoff's pane for background watching (Issue #36). */
  watch?: {add(entry: WatchEntry): Promise<void>};
  /** Set by the extension when this session accepted a handoff packet; its targetStage is the session stage. */
  handoff?: AcceptedHandoff;
}

export function createRuntime(options: Partial<ScaffoldRuntime> & {env?: Record<string, string | undefined>; home?: string} = {}): ScaffoldRuntime {
  const env = options.env ?? process.env;
  const agentDir = options.agentDir ?? resolveAgentDir(env, options.home ?? homedir());
  const scaffoldDir = resolveScaffoldDir(options.scaffoldDir === undefined ? env : {PI_SCAFFOLD_DIR: options.scaffoldDir}, agentDir);
  return {
    scaffoldDir,
    scope: options.scope ?? new RuntimeScope(),
    agentDir,
    git: options.git ?? createGitReader(),
    ...(options.timeoutMs !== undefined ? {timeoutMs: options.timeoutMs} : {}),
    ...(options.budgetMs !== undefined ? {budgetMs: options.budgetMs} : {}),
    ...(options.now !== undefined ? {now: options.now} : {}),
    ...(options.watch ? {watch: options.watch} : {}),
    ...(options.environment ? {environment: options.environment} : {}), ...(options.herdr ? {herdr: options.herdr} : {}),
    ...(options.waitMs !== undefined ? {waitMs: options.waitMs} : {}), ...(options.pollMs !== undefined ? {pollMs: options.pollMs} : {}),
  };
}

/** Per-call services handed to a tool's run(). */
export class ToolCall {
  readonly bridge: PiGhBridge;
  readonly namespaceRoot: string;
  readonly approvals: ApprovalStore;
  /** Time after which a tool stops starting new steps (an in-flight approval is not cut). */
  readonly deadline: number;
  constructor(readonly runtime: ScaffoldRuntime, readonly env: ToolEnv, readonly scope: CallScope) {
    this.bridge = new PiGhBridge(env.executeTool, {interactiveWrites: env.approvalUi.interactive, ...(runtime.timeoutMs !== undefined ? {timeoutMs: runtime.timeoutMs} : {})});
    this.namespaceRoot = runtime.scaffoldDir;
    this.approvals = new ApprovalStore(this.namespaceRoot);
    this.deadline = this.now() + (runtime.budgetMs ?? LIMITS.callTimeoutMs);
  }
  now(): number { return (this.runtime.now ?? Date.now)(); }
  overBudget(): boolean { return this.now() >= this.deadline; }
  policy(): Promise<Decoded<OwnerPolicy | undefined>> { return loadOwnerPolicy(this.runtime.agentDir, this.runtime.scaffoldDir); }
  async repoContext(repo: string, workflowId: string | null): Promise<Decoded<RepoContext>> {
    const policy = await this.policy();
    if (!policy.ok) return policy;
    let agentDirRealpath: string;
    try { agentDirRealpath = await realpath(this.runtime.agentDir); } catch { return failed([problem('AGENT_DIR_MISSING', 'agentDir', 'The Pi agent directory does not exist.')]); }
    return deriveRepoContext({
      cwd: this.env.cwd, repo, workflowId, trusted: this.env.isProjectTrusted(), agentDir: this.runtime.agentDir, scaffoldDir: this.runtime.scaffoldDir, agentDirRealpath,
      sessionEntries: this.env.sessionEntries(), policy: policy.value, git: this.runtime.git,
    });
  }
  /** The agent-decision stage of this call (see agent-decision.ts); never for a subagent child. */
  async agentDecisionStage(repo: string, workflowId: string): Promise<AgentDecisionStage | undefined> {
    if (this.env.approvalUi.child || this.environment().PI_SUBAGENT_CHILD || !this.runtime.handoff) return undefined;
    const policy = await this.policy();
    return resolveAgentDecisionStage(this.runtime.handoff, policy.ok ? policy.value : undefined, {sessionId: this.scope.sessionId, repo, workflowId});
  }
  environment(): Record<string, string | undefined> { return this.runtime.environment ? this.runtime.environment() : process.env; }
  herdr(): HerdrPort { const env = this.environment(); return this.runtime.herdr ? this.runtime.herdr() : createHerdrCli({...(env.HERDR_BIN_PATH ? {bin: env.HERDR_BIN_PATH} : {}), ...(env.HERDR_SOCKET_PATH ? {socketPath: env.HERDR_SOCKET_PATH} : {}), caller: env}); }
  journal(context: RepoContext): OperationJournal { return new OperationJournal({root: this.namespaceRoot, workflowStateRoot: context.workflowStateRoot}); }
}
