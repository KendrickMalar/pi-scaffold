// #3 scaffold_labels_ensure: compare all 211 managed label definitions with one gh_labels_list read, create the
// missing ones (and, only when asked, update mismatching ones), then read the whole list back before success.
// Only label-create/label-edit (and, with pi-gh's `labels-create-many` feature, batched creation) are used; Issue
// labels are never touched.
import {join} from 'node:path';
import {StrictReader, isRepoRef, isUuid, problem, type Decoded, type Problem, type ScaffoldResult} from '../core/contracts.js';
import {withOperation, type OperationRun, type Reconcile} from '../core/lifecycle.js';
import {taggedDigest} from '../core/digests.js';
import {writeOwnedFile} from '../core/files.js';
import {definitionsDigest, labelDefinitions, type LabelDefinition} from '../core/label-definitions.js';
import type {ToolCall} from '../core/runtime.js';
import type {GhOutcome} from '../ports/pi-gh.js';

export const LABELS_ENSURE = 'scaffold_labels_ensure';
export interface LabelsEnsureInput { repo: string; operationId: string; onMismatch?: 'block' | 'update' }
export interface LabelsEnsureData { created: string[]; updated: string[]; unchanged: string[]; blocked: string[] }
export type LabelState = {state: 'match'} | {state: 'missing'} | {state: 'mismatch'; actual: LabelDefinition};
/** Repository labels keyed by lower-case name (GitHub label names are case-insensitive). */
export type LabelIndex = Map<string, LabelDefinition>;

export function decodeLabelsEnsureInput(value: unknown): Decoded<LabelsEnsureInput> {
  const r = new StrictReader();
  const o = r.object(value, '', ['repo', 'operationId'], ['onMismatch']);
  if (!o) return r.result(undefined as never);
  const input: LabelsEnsureInput = {repo: r.pattern(o.repo, 'repo', isRepoRef, 'OWNER/REPO'), operationId: r.pattern(o.operationId, 'operationId', isUuid, 'a lowercase random UUID')};
  if (o.onMismatch !== undefined) input.onMismatch = r.literal(o.onMismatch, 'onMismatch', ['block', 'update'] as const);
  return r.result(input);
}

function decodeLabelList(d: unknown): LabelIndex | undefined {
  const labels = (d as {labels?: unknown} | null)?.labels;
  if (!Array.isArray(labels)) return undefined;
  const index: LabelIndex = new Map();
  for (const l of labels as {name?: unknown; color?: unknown; description?: unknown}[]) {
    if (!l || typeof l.name !== 'string' || typeof l.color !== 'string' || typeof l.description !== 'string') return undefined;
    const key = l.name.toLowerCase();
    if (index.has(key)) return undefined;
    index.set(key, {name: l.name, color: l.color.toLowerCase(), description: l.description});
  }
  return index;
}

/** One complete read of the repository's labels (pi-gh gh_labels_list). */
export async function readLabels(call: ToolCall, repo: string): Promise<{labels: LabelIndex} | {error: Problem[]}> {
  const r = await call.bridge.call('gh_labels_list', {repo}, decodeLabelList, call.scope);
  if (r.status === 'ok') return {labels: r.data!};
  return {error: r.problems.length ? r.problems : [problem('LABEL_LIST_FAILED', 'labels', 'Repository labels could not be read completely.')]};
}
export function labelState(def: LabelDefinition, labels: LabelIndex): LabelState {
  const actual = labels.get(def.name.toLowerCase());
  if (!actual) return {state: 'missing'};
  return actual.name === def.name && actual.color === def.color && actual.description === def.description ? {state: 'match'} : {state: 'mismatch', actual};
}

async function applyLabel(def: LabelDefinition, existing: LabelDefinition | undefined, call: ToolCall, changePath: string, repo: string): Promise<GhOutcome<true>> {
  const change = existing
    ? {version: 1, repo, operation: 'label-edit', name: existing.name, ...(existing.name !== def.name ? {newName: def.name} : {}), color: def.color, description: def.description}
    : {version: 1, repo, operation: 'label-create', name: def.name, color: def.color, description: def.description};
  await writeOwnedFile(changePath, JSON.stringify(change), {root: call.namespaceRoot});
  return call.bridge.call('gh_labels_apply', {changePath}, () => true as const, call.scope);
}

/** Reads the labels again to decide whether an uncertain create/update took effect. */
function reconcileWith(def: LabelDefinition, call: ToolCall, repo: string, kind: 'create' | 'update'): Reconcile {
  return async () => {
    const read = await readLabels(call, repo);
    if ('error' in read) return 'unknown';
    // The step only needs a decision; whatever the label now looks like is then judged by the normal rules
    // (mismatch → block/update, missing → create) and the final read-back.
    const s = labelState(def, read.labels).state;
    if (kind === 'create') return s === 'missing' ? 'not-applied' : 'applied';
    return s === 'mismatch' ? 'not-applied' : 'applied';
  };
}

/** Labels per label-create-many change: keeps one pi-gh call well inside the call limit. */
export const CREATE_BATCH = 40;
const planStep = (id: number) => `create-many-plan:${id}`, batchStep = (id: number) => `create-many:${id}`;
const plans = (run: OperationRun) => run.record.steps.filter(s => s.name.startsWith('create-many-plan:')).map(s => ({id: Number(s.name.slice('create-many-plan:'.length)), names: s.data as string[]}));
const batchPending = (run: OperationRun, id: number) => run.record.steps.some(s => s.name === batchStep(id) && (s.phase === 'requested' || s.phase === 'unknown'));

async function applyMany(defs: LabelDefinition[], call: ToolCall, changePath: string, repo: string): Promise<GhOutcome<true>> {
  const change = {version: 1, repo, operation: 'label-create-many', labels: defs.map(d => ({name: d.name, color: d.color, description: d.description}))};
  await writeOwnedFile(changePath, JSON.stringify(change), {root: call.namespaceRoot});
  return call.bridge.call('gh_labels_apply', {changePath}, () => true as const, call.scope);
}
/**
 * An uncertain batch is settled from a fresh read: none of its labels exist → not applied (the same batch is sent
 * again); any of them exist → applied (pi-gh stops at the first uncertain write, so the rest are simply still
 * missing and go into a new batch, judged like every other label by the rules and the final read-back).
 */
function reconcileMany(names: string[], call: ToolCall, repo: string): Reconcile {
  return async () => {
    const read = await readLabels(call, repo);
    if ('error' in read) return 'unknown';
    return names.some(n => read.labels.has(n.toLowerCase())) ? 'applied' : 'not-applied';
  };
}

const mismatchProblem = (def: LabelDefinition, actual: LabelDefinition) =>
  problem('LABEL_MISMATCH', `labels.${def.name}`, `Existing label differs: "${actual.name}" #${actual.color} "${actual.description}" (expected "${def.name}" #${def.color} "${def.description}"). It is not overwritten unless onMismatch is "update".`);
const stepKind = (run: OperationRun, def: LabelDefinition): 'create' | 'update' | undefined =>
  (['create', 'update'] as const).find(k => run.record.steps.some(s => s.name === `${k}:${def.name}` && (s.phase === 'requested' || s.phase === 'unknown')));
const slug = (name: string) => name.replace(/[^A-Za-z0-9]+/g, '-');

/**
 * Brings one definition to the expected state inside an operation (shared with #12). `labels` must be a fresh
 * read. An earlier uncertain write for this definition is always reconciled first, even if the label now matches.
 */
export async function ensureLabelDefinition(def: LabelDefinition, labels: LabelIndex, call: ToolCall, run: OperationRun, dir: string, repo: string, onMismatch: 'block' | 'update' = 'block'): Promise<'match' | 'created' | 'updated'> {
  const state = labelState(def, labels);
  const pending = stepKind(run, def);
  if (state.state === 'match' && !pending) return 'match';
  if (state.state === 'mismatch' && onMismatch === 'block' && !pending) run.stop([mismatchProblem(def, state.actual)]);
  const kind = pending ?? (state.state === 'missing' ? 'create' : 'update');
  const existing = state.state === 'mismatch' ? state.actual : undefined;
  await run.write(`${kind}:${def.name}`, () => applyLabel(def, existing, call, join(dir, slug(def.name), `${kind}.json`), repo), {reconcile: reconcileWith(def, call, repo, kind)});
  return kind === 'create' ? 'created' : 'updated';
}

export async function ensureLabels(input: LabelsEnsureInput, call: ToolCall): Promise<ScaffoldResult<LabelsEnsureData>> {
  const operation = LABELS_ENSURE;
  const caps = await call.bridge.requireCapabilities(['gh_labels_list', 'gh_labels_apply'], call.scope);
  if (!caps.ok) return {status: caps.problems.some(p => p.code === 'STALE_SCOPE') ? 'cancelled' : 'blocked', operation, problems: caps.problems};
  // pi-gh 0.7.0+ creates many labels in one change (one listing before and after instead of per label).
  const batching = (await call.bridge.requireCapabilities([], call.scope, ['labels-create-many'])).ok;
  const context = await call.repoContext(input.repo, null);
  if (!context.ok) return {status: 'blocked', operation, problems: context.problems};
  const onMismatch = input.onMismatch ?? 'block';
  const defs = labelDefinitions();
  const dir = join(context.value.workflowStateRoot, 'artifacts', input.operationId);
  const payloadDigest = taggedDigest('labels-ensure', {repo: input.repo, onMismatch, definitions: definitionsDigest()});
  const result = await withOperation({operation, repo: input.repo, workflowId: '_repo', operationId: input.operationId, payloadDigest, journal: call.journal(context.value), scope: call.scope}, async run => {
    const batched = () => new Set(plans(run).filter(p => run.record.steps.some(s => s.name === batchStep(p.id) && s.phase === 'done')).flatMap(p => p.names));
    const done = (kind: 'create' | 'update') => defs.filter(d => run.record.steps.some(s => s.name === `${kind}:${d.name}` && s.phase === 'done') || (kind === 'create' && batched().has(d.name))).map(d => d.name);
    const summary = (labels: LabelIndex): LabelsEnsureData => {
      const created = done('create'), updated = done('update');
      const states = defs.map(d => [d, labelState(d, labels)] as const);
      return {
        created, updated,
        unchanged: states.filter(([d, s]) => s.state === 'match' && !created.includes(d.name) && !updated.includes(d.name)).map(([d]) => d.name),
        blocked: states.filter(([, s]) => s.state === 'mismatch').map(([d]) => d.name),
      };
    };
    // Always start from a fresh, complete read: earlier calls' observations may be stale.
    run.checkpoint();
    const first = await readLabels(call, input.repo);
    if ('error' in first) return run.stop(first.error);
    const mismatches = defs.flatMap(d => { const s = labelState(d, first.labels); return s.state === 'mismatch' && !stepKind(run, d) ? [mismatchProblem(d, s.actual)] : []; });
    if (mismatches.length && onMismatch === 'block') return run.stop(mismatches, summary(first.labels));
    const current = batching ? await createInBatches(first.labels) : first.labels;
    for (const def of defs) {
      const pending = stepKind(run, def);
      if (labelState(def, current).state === 'match' && !pending) continue;
      // Uncertain steps are settled (read-only reconcile first) before the budget can pause the run.
      if (!pending && call.overBudget()) run.pause([problem('CALL_BUDGET_EXHAUSTED', '', 'Progress is recorded; call again with the same operationId to continue.')], summary(current));
      await ensureLabelDefinition(def, current, call, run, dir, input.repo, onMismatch);
    }
    async function createInBatches(start: LabelIndex): Promise<LabelIndex> {
      // Uncertain batches are settled before anything else (and before the budget can pause the run).
      const pendingPlans = plans(run).filter(p => batchPending(run, p.id));
      for (const p of pendingPlans) {
        const planned = p.names.map(n => defs.find(d => d.name === n)!);
        await run.write(batchStep(p.id), () => applyMany(planned, call, join(dir, `create-many-${p.id}.json`), input.repo), {reconcile: reconcileMany(p.names, call, input.repo)});
      }
      let labels = new Map(start);
      if (pendingPlans.length) { run.checkpoint(); const again = await readLabels(call, input.repo); if ('error' in again) return run.stop(again.error); labels = again.labels; }
      // One-by-one steps left uncertain by an older call are settled by the per-label loop; everything else missing is batched.
      const missing = defs.filter(d => labelState(d, labels).state === 'missing' && !stepKind(run, d));
      for (let i = 0; i < missing.length; i += CREATE_BATCH) {
        if (call.overBudget()) run.pause([problem('CALL_BUDGET_EXHAUSTED', '', 'Progress is recorded; call again with the same operationId to continue.')], summary(labels));
        const batch = missing.slice(i, i + CREATE_BATCH), id = Math.max(0, ...plans(run).map(p => p.id)) + 1;
        run.note(planStep(id), batch.map(d => d.name));
        await run.write(batchStep(id), () => applyMany(batch, call, join(dir, `create-many-${id}.json`), input.repo), {reconcile: reconcileMany(batch.map(d => d.name), call, input.repo)});
        for (const d of batch) labels.set(d.name.toLowerCase(), d);
      }
      return labels;
    }
    // Success only after every definition is read back as expected.
    run.checkpoint();
    const final = await readLabels(call, input.repo);
    if ('error' in final) return run.stop(final.error);
    const wrong = defs.filter(d => labelState(d, final.labels).state !== 'match');
    if (wrong.length) return run.stop(wrong.map(d => problem('LABEL_READBACK_MISMATCH', `labels.${d.name}`, 'Read-back does not match the definition (changed concurrently?).')), summary(final.labels));
    const data = summary(final.labels);
    return {status: data.created.length || data.updated.length ? 'applied' : 'noop', data};
  });
  return result as ScaffoldResult<LabelsEnsureData>;
}
