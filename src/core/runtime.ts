// Node-only runtime shared by every tool service. The Pi adapter (extensions/tool-kit.ts) fills ToolEnv
// from the tool context; tests fill it with fakes. Factories only build objects; nothing starts here.
import {homedir} from 'node:os';
import {realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {LIMITS, failed, problem, type CallScope, type Decoded, type RepoContext} from './contracts.js';
import {RuntimeScope} from './lifecycle.js';
import {OperationJournal} from './journal.js';
import {ApprovalStore, type ApprovalUi} from './approvals.js';
import {loadOwnerPolicy, type OwnerPolicy} from './model-bindings.js';
import {deriveRepoContext, resolveAgentDir} from './repo-context.js';
import {PiGhBridge, type ToolExecutor} from '../ports/pi-gh.js';
import {createGitReader, type GitReader} from '../ports/git-read.js';
import {createHerdrCli, type HerdrPort} from '../handoff/herdr-client.js';

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
  scope: RuntimeScope; agentDir: string; git: GitReader; timeoutMs?: number;
  /** Process environment (HERDR_*, PI_SUBAGENT_CHILD); tests inject a synthetic one. */
  environment?: () => Record<string, string | undefined>;
  herdr?: () => HerdrPort;
  /** Receipt waits: total per call and poll interval. */
  waitMs?: number; pollMs?: number;
  /** Work budget of one tool call; long work pauses as `partial` and resumes with the same operationId. */
  budgetMs?: number;
  now?: () => number;
}

export function createRuntime(options: Partial<ScaffoldRuntime> & {env?: Record<string, string | undefined>; home?: string} = {}): ScaffoldRuntime {
  return {
    scope: options.scope ?? new RuntimeScope(),
    agentDir: options.agentDir ?? resolveAgentDir(options.env ?? process.env, options.home ?? homedir()),
    git: options.git ?? createGitReader(),
    ...(options.timeoutMs !== undefined ? {timeoutMs: options.timeoutMs} : {}),
    ...(options.budgetMs !== undefined ? {budgetMs: options.budgetMs} : {}),
    ...(options.now !== undefined ? {now: options.now} : {}),
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
    this.namespaceRoot = join(runtime.agentDir, 'pi-scaffold');
    this.approvals = new ApprovalStore(this.namespaceRoot);
    this.deadline = this.now() + (runtime.budgetMs ?? LIMITS.callTimeoutMs);
  }
  now(): number { return (this.runtime.now ?? Date.now)(); }
  overBudget(): boolean { return this.now() >= this.deadline; }
  policy(): Promise<Decoded<OwnerPolicy | undefined>> { return loadOwnerPolicy(this.runtime.agentDir); }
  async repoContext(repo: string, workflowId: string | null): Promise<Decoded<RepoContext>> {
    const policy = await this.policy();
    if (!policy.ok) return policy;
    let agentDirRealpath: string;
    try { agentDirRealpath = await realpath(this.runtime.agentDir); } catch { return failed([problem('AGENT_DIR_MISSING', 'agentDir', 'The Pi agent directory does not exist.')]); }
    return deriveRepoContext({
      cwd: this.env.cwd, repo, workflowId, trusted: this.env.isProjectTrusted(), agentDir: this.runtime.agentDir, agentDirRealpath,
      sessionEntries: this.env.sessionEntries(), policy: policy.value, git: this.runtime.git,
    });
  }
  environment(): Record<string, string | undefined> { return this.runtime.environment ? this.runtime.environment() : process.env; }
  herdr(): HerdrPort { const env = this.environment(); return this.runtime.herdr ? this.runtime.herdr() : createHerdrCli({...(env.HERDR_BIN_PATH ? {bin: env.HERDR_BIN_PATH} : {}), ...(env.HERDR_SOCKET_PATH ? {socketPath: env.HERDR_SOCKET_PATH} : {}), caller: env}); }
  journal(context: RepoContext): OperationJournal { return new OperationJournal({root: this.namespaceRoot, workflowStateRoot: context.workflowStateRoot}); }
}
