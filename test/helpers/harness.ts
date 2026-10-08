// Invokes a real tool definition (createTool) with fake remote ports only. Reducers, gates and codecs are real.
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createJiti} from 'jiti';
import {Check, Errors} from 'typebox/value';
import {validateToolArguments} from '@earendil-works/pi-ai';
import type {TSchema} from 'typebox';
import {createRuntime, type ScaffoldRuntime} from '../../src/core/runtime.js';
import type {GitReader} from '../../src/ports/git-read.js';
import type {OwnerPolicy} from '../../src/core/model-bindings.js';
import type {ScaffoldResult} from '../../src/core/contracts.js';
import {FakePiGh} from './fake-pi-gh.js';

export interface ToolDefinitionLike {
  name: string; parameters: TSchema; prepareArguments?: (args: unknown) => unknown; outputSchema?: TSchema; executionMode?: string;
  execute(id: string, params: unknown, signal: AbortSignal | undefined, update: unknown, ctx: unknown): Promise<{structuredContent: unknown; isError: boolean; content: unknown[]}>;
}
export type CreateTool = (runtime: ScaffoldRuntime) => ToolDefinitionLike;
import type {HerdrPort} from '../../src/handoff/herdr-client.js';
export interface FakeHerdrLike { calls: {command: string; args: unknown}[] }
export interface Scenario {
  gh?: FakePiGh; trusted?: boolean; interactive?: boolean; confirm?: boolean | (() => boolean); child?: boolean;
  origin?: string; sessionEntries?: unknown[]; policy?: OwnerPolicy; availableModels?: string[]; scopedModels?: string[];
  defaultParams?: Record<string, unknown>; herdr?: FakeHerdrLike & Partial<HerdrPort>;
  /** Process environment seen by the tool (HERDR_*, PI_SUBAGENT_CHILD…). */
  environment?: Record<string, string | undefined>; waitMs?: number; pollMs?: number;
  /** Tool names registered in the calling session (ctx.tools). */
  tools?: string[]; budgetMs?: number; now?: () => number;
  /** Reuse another harness's agent directory (same journal), e.g. to resume from a different session model. */
  agentDir?: string;
  /** Session model; null means Pi reports no model. */
  model?: {provider: string; id: string} | null; thinkingLevel?: string | null;
  /** Repository files by `<commit>:<path>` for the read-only git port. */
  blobs?: Record<string, string>;
}
export interface Invocation {
  r: ScaffoldResult; isError: boolean; inputSchemaValid: boolean; inputSchemaErrors: string[]; outputSchemaValid: boolean;
  ghWrites: number; herdrCalls: number; confirmCalls: number;
}

const root = fileURLToPath(new URL('../../../', import.meta.url));
/** Loads a TypeScript module (extensions/tools/*.ts or test/fixtures/*.ts) the same way Pi does, through jiti. */
export async function loadToolModule(relativePath: string): Promise<{createTool: CreateTool}> {
  const jiti = createJiti(import.meta.url, {moduleCache: false, fsCache: false});
  return jiti.import(join(root, relativePath)) as Promise<{createTool: CreateTool}>;
}

export async function createHarness(createTool: CreateTool, {scenario = {}}: {scenario?: Scenario} = {}) {
  const home = await mkdtemp(join(tmpdir(), 'pi-scaffold-harness-'));
  const agentDir = scenario.agentDir ?? join(home, 'agent');
  await mkdir(join(agentDir, 'pi-scaffold'), {recursive: true, mode: 0o700});
  if (scenario.policy) await writeFile(join(agentDir, 'pi-scaffold', 'policy.json'), JSON.stringify(scenario.policy), {mode: 0o600});
  const gh = scenario.gh ?? new FakePiGh();
  const herdr = scenario.herdr ?? {calls: []};
  const git: GitReader = {
    run: async () => ({code: 1, stdout: ''}),
    repoIdentity: async () => ({repoRoot: '/synthetic/repo', gitCommonDir: '/synthetic/repo/.git', origin: scenario.origin ?? 'https://github.com/example/demo.git'}),
    readBlob: async (commit, path) => { const v = scenario.blobs?.[`${commit}:${path}`]; return v === undefined ? undefined : Buffer.from(v); },
  };
  const runtime = createRuntime({agentDir, git, timeoutMs: 2000, ...(scenario.environment ? {environment: () => scenario.environment!} : {}), ...(scenario.herdr && 'tabCreate' in scenario.herdr ? {herdr: () => scenario.herdr as HerdrPort} : {}), ...(scenario.waitMs !== undefined ? {waitMs: scenario.waitMs} : {}), ...(scenario.pollMs !== undefined ? {pollMs: scenario.pollMs} : {}), ...(scenario.budgetMs !== undefined ? {budgetMs: scenario.budgetMs} : {}), ...(scenario.now ? {now: scenario.now} : {})});
  const tool = createTool(runtime);
  let confirmCalls = 0;
  const ctx = {
    cwd: '/synthetic/repo', mode: scenario.interactive === false ? 'print' : 'tui', hasUI: scenario.interactive !== false,
    isProjectTrusted: () => scenario.trusted !== false,
    executeTool: (name: string, args: unknown, options?: {signal?: AbortSignal}) => gh.execute(name, args, options),
    ui: {confirm: async () => { confirmCalls++; const c = scenario.confirm ?? true; return typeof c === 'function' ? c() : c; }},
    tools: (scenario.tools ?? []).map(name => ({name})),
    sessionManager: {getSessionId: () => 'session-harness', getLeafId: () => 'leaf-harness', getEntries: () => scenario.sessionEntries ?? []},
    modelRegistry: {getAvailable: () => (scenario.availableModels ?? []).map(m => ({provider: m.split('/')[0], id: m.split('/').slice(1).join('/')}))},
    model: scenario.model === null ? undefined : (scenario.model ?? {provider: 'example-provider', id: 'planner-1'}),
    thinkingLevel: scenario.thinkingLevel === null ? undefined : (scenario.thinkingLevel ?? 'medium'),
    scopedModels: (scenario.scopedModels ?? []).map(m => ({model: {provider: m.split('/')[0], id: m.split('/').slice(1).join('/')}})),
  };
  const previousChild = process.env.PI_SUBAGENT_CHILD;
  return {
    tool, runtime, gh, herdr, agentDir,
    defaultParams: scenario.defaultParams ?? {},
    async invoke(params: unknown = scenario.defaultParams, signal?: AbortSignal): Promise<Invocation> {
      const inputSchemaValid = Check(tool.parameters, params);
      const inputSchemaErrors = inputSchemaValid ? [] : [...Errors(tool.parameters, params)].map(e => `${e.instancePath} ${e.message}`);
      const writesBefore = gh.writes, herdrBefore = herdr.calls.length, confirmBefore = confirmCalls;
      if (scenario.child) process.env.PI_SUBAGENT_CHILD = '1';
      try {
        const out = await tool.execute('harness-call', params, signal, undefined, ctx);
        return {
          r: out.structuredContent as ScaffoldResult, isError: out.isError, inputSchemaValid, inputSchemaErrors,
          outputSchemaValid: tool.outputSchema ? Check(tool.outputSchema, out.structuredContent) : false,
          ghWrites: gh.writes - writesBefore, herdrCalls: herdr.calls.length - herdrBefore, confirmCalls: confirmCalls - confirmBefore,
        };
      } finally { if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = previousChild; }
    },
    /** Pi's own pipeline: prepareArguments → structuredClone → Value.Convert → schema check → execute. */
    async invokeAsPi(raw: unknown): Promise<{piRejected: true; errors: string[]; ghWrites: number} | (Invocation & {piRejected: false})> {
      const prepared = tool.prepareArguments ? tool.prepareArguments(raw) : raw;
      let args: unknown;
      try { args = validateToolArguments(tool as never, {type: 'toolCall', id: 'pi', name: tool.name, arguments: prepared} as never); }
      catch (e) { return {piRejected: true, errors: [(e as Error).message], ghWrites: 0}; }
      return {...await this.invoke(args), piRejected: false};
    },
    dispose: () => rm(home, {recursive: true, force: true}),
  };
}
