// Pi entry helpers: TypeBox schemas and the adapter from Pi's tool context to the node-only services.
import {Type, type TSchema} from '@earendil-works/pi-ai';
import type {ExtensionToolContext, ToolDefinition} from '@earendil-works/pi-coding-agent';
import {problem, type Decoded, type ScaffoldResult} from '../dist/src/core/contracts.js';
import {createCallScope} from '../dist/src/core/lifecycle.js';
import {toToolResult} from '../dist/src/core/result.js';
import {ToolCall, type ScaffoldRuntime, type ToolEnv} from '../dist/src/core/runtime.js';

const STATUS = ['validated', 'prepared', 'applied', 'noop', 'blocked', 'partial', 'unknown', 'cancelled'] as const;
export const scaffoldOutputSchema = Type.Object({
  status: Type.Union(STATUS.map(s => Type.Literal(s))),
  operation: Type.String(),
  data: Type.Optional(Type.Unknown()),
  problems: Type.Array(Type.Object({code: Type.String(), path: Type.String(), message: Type.String()}, {additionalProperties: false})),
  resumeToken: Type.Optional(Type.String()),
}, {additionalProperties: false});

/** Common MutationInput fields; each tool extends this with additionalProperties:false. */
export const mutationInputFields = {
  repo: Type.String({pattern: '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$'}),
  epicIssue: Type.Integer({minimum: 1}),
  operationId: Type.String({pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'}),
  expectedRevision: Type.Integer({minimum: 1}),
  expectedBodySha256: Type.String({pattern: '^[0-9a-f]{64}$'}),
};

export function toolEnv(ctx: ExtensionToolContext): ToolEnv {
  const child = !!process.env.PI_SUBAGENT_CHILD;
  return {
    cwd: ctx.cwd,
    isProjectTrusted: () => ctx.isProjectTrusted(),
    executeTool: (name, args, options) => ctx.executeTool(name, args, options),
    approvalUi: {interactive: ctx.mode === 'tui' && ctx.hasUI && !child, confirm: (title, message, options) => ctx.ui.confirm(title, message, options?.signal ? {signal: options.signal} : undefined)},
    identity: () => ({sessionId: ctx.sessionManager.getSessionId(), leafId: ctx.sessionManager.getLeafId() ?? ''}),
    sessionEntries: () => ctx.sessionManager.getEntries(),
    availableModels: () => ctx.modelRegistry.getAvailable().map(m => `${m.provider}/${m.id}`),
    scopedModels: () => ctx.scopedModels.map(s => `${s.model.provider}/${s.model.id}`),
    currentModel: () => ctx.model && ctx.thinkingLevel ? {model: `${ctx.model.provider}/${ctx.model.id}`, thinking: ctx.thinkingLevel} : undefined,
  };
}

export interface ScaffoldToolSpec<I> {
  name: string; label: string; description: string; parameters: TSchema;
  /** Only #13 (read-only) is parallel; every changing tool is sequential. */
  executionMode: 'sequential' | 'parallel';
  readOnly: boolean;
  decode(raw: unknown): Decoded<I>;
  run(input: I, call: ToolCall): Promise<ScaffoldResult>;
}

const TYPE_CODES = new Set(['INVALID_TYPE', 'INVALID_INTEGER', 'INVALID_FORMAT', 'INVALID_VALUE', 'INVALID_WAVE']);
/** Replaces the value at a decoder path (`a.b[0]`) with one Pi's Value.Convert cannot coerce into the schema type. */
function poison(root: unknown, path: string): void {
  const keys = path.match(/[^.[\]]+/g) ?? [];
  if (!keys.length || typeof root !== 'object' || root === null) return;
  let node = root as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    if (typeof next !== 'object' || next === null) return;
    node = next as Record<string, unknown>;
  }
  node[keys.at(-1)!] = {invalidInput: 'This value has the wrong type and is not converted.'};
}
/**
 * Pi converts tool arguments to the schema types (42 → "42", "1" → 1) after prepareArguments and before
 * validation. Type errors found on the raw arguments are made unconvertible here, so Pi rejects the call and the
 * tool never runs on coerced input.
 */
export function strictArguments<I>(decode: (raw: unknown) => Decoded<I>) {
  return (raw: unknown): unknown => {
    const decoded = decode(raw);
    if (decoded.ok || typeof raw !== 'object' || raw === null) return raw;
    const copy = structuredClone(raw);
    for (const p of decoded.problems) if (TYPE_CODES.has(p.code)) poison(copy, p.path);
    return copy;
  };
}

export function defineScaffoldTool<I>(runtime: ScaffoldRuntime, spec: ScaffoldToolSpec<I>): ToolDefinition {
  return {
    prepareArguments: strictArguments(spec.decode),
    name: spec.name, label: spec.label, description: spec.description, parameters: spec.parameters, outputSchema: scaffoldOutputSchema,
    exposure: 'direct', executionMode: spec.executionMode,
    annotations: {readOnlyHint: spec.readOnly, destructiveHint: !spec.readOnly, idempotentHint: spec.readOnly, openWorldHint: true},
    async execute(_id: string, params: unknown, signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionToolContext) {
      const env = toolEnv(ctx);
      const scope = createCallScope(runtime.scope, env.identity, signal);
      const work = async (): Promise<ScaffoldResult> => {
        const input = spec.decode(params);
        if (!input.ok) return {status: 'blocked', operation: spec.name, problems: input.problems};
        return spec.run(input.value, new ToolCall(runtime, env, scope));
      };
      try {
        return toToolResult(spec.executionMode === 'sequential' ? await runtime.scope.runExclusive(work) : await work()) as never;
      } catch (error) {
        return toToolResult({status: scope.isCurrent() ? 'blocked' : 'cancelled', operation: spec.name, problems: [problem('INTERNAL_ERROR', '', (error as Error)?.message ?? 'Tool failed.')]}) as never;
      } finally { scope.dispose(); }
    },
  } as unknown as ToolDefinition;
}
