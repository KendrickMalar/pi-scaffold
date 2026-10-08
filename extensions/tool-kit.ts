// Pi entry helpers: TypeBox schemas and the adapter from Pi's tool context to the node-only services.
import {Type, validateToolArguments, type TSchema} from '@earendil-works/pi-ai';
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
    toolNames: () => (ctx.tools ?? []).map(t => t.name),
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

/** Paths of primitive values (incl. null) that Pi's own argument pipeline would rewrite (e.g. 42 → "42", null → "null"). */
function coercedPaths(raw: unknown, converted: unknown, path: (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(raw)) return Array.isArray(converted) ? raw.flatMap((v, i) => coercedPaths(v, converted[i], [...path, i])) : [path];
  if (raw !== null && typeof raw === 'object') {
    if (converted === null || typeof converted !== 'object' || Array.isArray(converted)) return [path];
    // A key Pi removed (an optional null) is not a coercion.
    return Object.entries(raw).flatMap(([k, v]) => Object.hasOwn(converted, k) ? coercedPaths(v, (converted as Record<string, unknown>)[k], [...path, k]) : []);
  }
  return Object.is(raw, converted) ? [] : [path];
}
/**
 * Pi converts tool arguments to the schema types after prepareArguments and before validation. Values that this
 * conversion would rewrite are replaced by an unconvertible marker, so Pi rejects the call and the tool never runs
 * on coerced input. Everything else (format/semantic errors) reaches the decoder and comes back as a ScaffoldResult.
 */
export function strictArguments(parameters: TSchema, name: string) {
  return (raw: unknown): unknown => {
    let converted: unknown;
    try { converted = validateToolArguments({name, description: '', parameters} as never, {type: 'toolCall', id: 'strict', name, arguments: raw} as never); }
    catch { return raw; }
    const paths = coercedPaths(raw, converted);
    if (!paths.length) return raw;
    const copy = structuredClone(raw) as Record<string | number, unknown>;
    for (const p of paths) {
      if (!p.length) return {invalidInput: 'Arguments have the wrong type and are not converted.'};
      let node = copy;
      for (const k of p.slice(0, -1)) node = node[k] as Record<string | number, unknown>;
      const original = node[p.at(-1)!];
      node[p.at(-1)!] = {invalidInput: original === '' ? 'An empty string is not allowed here (it would be silently turned into null); omit the field or give a value.' : `${original === null ? 'null' : typeof original} ${JSON.stringify(original)} has the wrong type and is not converted.`};
    }
    return copy;
  };
}

export function defineScaffoldTool<I>(runtime: ScaffoldRuntime, spec: ScaffoldToolSpec<I>): ToolDefinition {
  return {
    prepareArguments: strictArguments(spec.parameters, spec.name),
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
        const r = spec.executionMode === 'sequential' ? await runtime.scope.runExclusive(work) : await work();
        // Nothing changed and the call was aborted or the session moved on (reload/tree/fork): report it as cancelled.
        return toToolResult(r.status === 'blocked' && !scope.isCurrent() ? {...r, status: 'cancelled'} : r) as never;
      } catch (error) {
        return toToolResult({status: scope.isCurrent() ? 'blocked' : 'cancelled', operation: spec.name, problems: [problem('INTERNAL_ERROR', '', (error as Error)?.message ?? 'Tool failed.')]}) as never;
      } finally { scope.dispose(); }
    },
  } as unknown as ToolDefinition;
}
