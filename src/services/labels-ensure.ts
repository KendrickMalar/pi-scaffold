// #3 scaffold_labels_ensure: check all 211 managed label definitions, then create missing ones (and, only when
// asked, update mismatching ones). Only label-create/label-edit are used; Issue labels are never touched.
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
export type LabelCheck = {state: 'match'} | {state: 'missing'} | {state: 'mismatch'; actual: LabelDefinition};

export function decodeLabelsEnsureInput(value: unknown): Decoded<LabelsEnsureInput> {
  const r = new StrictReader();
  const o = r.object(value, '', ['repo', 'operationId'], ['onMismatch']);
  if (!o) return r.result(undefined as never);
  const input: LabelsEnsureInput = {repo: r.pattern(o.repo, 'repo', isRepoRef, 'OWNER/REPO'), operationId: r.pattern(o.operationId, 'operationId', isUuid, 'a lowercase random UUID')};
  if (o.onMismatch !== undefined) input.onMismatch = r.literal(o.onMismatch, 'onMismatch', ['block', 'update'] as const);
  return r.result(input);
}

const sameLabel = (a: LabelDefinition, b: LabelDefinition) => a.name === b.name && a.color === b.color && a.description === b.description;
function decodePreviewBefore(d: unknown): LabelDefinition | undefined {
  const before = (d as {before?: {name?: unknown; color?: unknown; description?: unknown}} | null)?.before;
  if (!before || typeof before.name !== 'string' || typeof before.color !== 'string' || (before.description !== null && typeof before.description !== 'string')) return undefined;
  return {name: before.name, color: before.color.toLowerCase(), description: (before.description as string | null) ?? ''};
}

/** Reads one label through gh_labels_preview(label-edit). Only LABEL_MISSING means absent; any other error stops. */
export async function checkLabel(def: LabelDefinition, call: ToolCall, changePath: string, repo: string): Promise<LabelCheck | {error: Problem[]}> {
  await writeOwnedFile(changePath, JSON.stringify({version: 1, repo, operation: 'label-edit', name: def.name, color: def.color, description: def.description}), {root: call.namespaceRoot});
  const r = await call.bridge.call('gh_labels_preview', {changePath}, decodePreviewBefore, call.scope);
  if (r.status === 'ok') return sameLabel(r.data!, def) ? {state: 'match'} : {state: 'mismatch', actual: r.data!};
  if (r.status === 'blocked' && r.problems.some(p => p.code === 'LABEL_MISSING')) return {state: 'missing'};
  return {error: r.problems.length ? r.problems : [problem('LABEL_PREVIEW_FAILED', `labels.${def.name}`, 'Label state could not be confirmed.')]};
}

async function applyLabel(def: LabelDefinition, existing: LabelDefinition | undefined, call: ToolCall, changePath: string, repo: string): Promise<GhOutcome<true>> {
  const change = existing
    ? {version: 1, repo, operation: 'label-edit', name: existing.name, ...(existing.name !== def.name ? {newName: def.name} : {}), color: def.color, description: def.description}
    : {version: 1, repo, operation: 'label-create', name: def.name, color: def.color, description: def.description};
  await writeOwnedFile(changePath, JSON.stringify(change), {root: call.namespaceRoot});
  return call.bridge.call('gh_labels_apply', {changePath}, () => true as const, call.scope);
}

function reconcileWith(def: LabelDefinition, call: ToolCall, path: string, repo: string, kind: 'create' | 'update'): Reconcile {
  return async () => {
    const c = await checkLabel(def, call, path, repo);
    if ('error' in c) return 'unknown';
    if (c.state === 'match') return 'applied';
    if (kind === 'create') return c.state === 'missing' ? 'not-applied' : 'unknown';
    return c.state === 'mismatch' ? 'not-applied' : 'unknown';
  };
}

/**
 * Makes one definition exist exactly once (shared with #12). Must run inside an operation: the check is a note,
 * the change is a journaled write that is reconciled before any resend.
 */
export async function ensureLabelDefinition(def: LabelDefinition, call: ToolCall, run: OperationRun, dir: string, repo: string, onMismatch: 'block' | 'update' = 'block'): Promise<'match' | 'created' | 'updated'> {
  const key = `check:${def.name}`;
  let check = run.done(key) as LabelCheck | undefined;
  if (!check || check.state === 'mismatch') {
    run.checkpoint();
    const c = await checkLabel(def, call, join(dir, 'check.json'), repo);
    if ('error' in c) run.stop(c.error);
    check = c as LabelCheck;
    run.note(key, check);
  }
  if (check.state === 'match') return 'match';
  if (check.state === 'mismatch' && onMismatch === 'block') run.stop([mismatchProblem(def, check.actual)]);
  const kind = check.state === 'missing' ? 'create' : 'update';
  const path = join(dir, `${kind}.json`);
  await run.write(`${kind}:${def.name}`, () => applyLabel(def, check.state === 'mismatch' ? check.actual : undefined, call, path, repo), {reconcile: reconcileWith(def, call, path, repo, kind)});
  run.note(key, {state: 'match'});
  return kind === 'create' ? 'created' : 'updated';
}

const mismatchProblem = (def: LabelDefinition, actual: LabelDefinition) =>
  problem('LABEL_MISMATCH', `labels.${def.name}`, `Existing label differs: "${actual.name}" #${actual.color} "${actual.description}" (expected "${def.name}" #${def.color} "${def.description}"). It is not overwritten unless onMismatch is "update".`);

export async function ensureLabels(input: LabelsEnsureInput, call: ToolCall): Promise<ScaffoldResult<LabelsEnsureData>> {
  const operation = LABELS_ENSURE;
  const caps = await call.bridge.requireCapabilities(['gh_labels_preview', 'gh_labels_apply'], call.scope);
  if (!caps.ok) return {status: caps.problems.some(p => p.code === 'STALE_SCOPE') ? 'cancelled' : 'blocked', operation, problems: caps.problems};
  const context = await call.repoContext(input.repo, null);
  if (!context.ok) return {status: 'blocked', operation, problems: context.problems};
  const onMismatch = input.onMismatch ?? 'block';
  const defs = labelDefinitions();
  const dir = join(context.value.workflowStateRoot, 'artifacts', input.operationId);
  const payloadDigest = taggedDigest('labels-ensure', {repo: input.repo, onMismatch, definitions: definitionsDigest()});
  const summary = (run: OperationRun): LabelsEnsureData => {
    const steps = run.record.steps.filter(s => s.phase === 'done');
    const created = defs.filter(d => steps.some(s => s.name === `create:${d.name}`)).map(d => d.name);
    const updated = defs.filter(d => steps.some(s => s.name === `update:${d.name}`)).map(d => d.name);
    const unchanged = defs.filter(d => (run.done(`check:${d.name}`) as LabelCheck | undefined)?.state === 'match' && !created.includes(d.name) && !updated.includes(d.name)).map(d => d.name);
    const blocked = defs.filter(d => (run.done(`check:${d.name}`) as LabelCheck | undefined)?.state === 'mismatch').map(d => d.name);
    return {created, updated, unchanged, blocked};
  };
  const budget = (run: OperationRun) => {
    if (call.overBudget()) run.pause([problem('CALL_BUDGET_EXHAUSTED', '', 'Progress is recorded; call again with the same operationId to continue.')], summary(run));
  };
  const result = await withOperation({operation, repo: input.repo, workflowId: '_repo', operationId: input.operationId, payloadDigest, journal: call.journal(context.value), scope: call.scope}, async run => {
    // Phase 1: read every definition before changing anything.
    for (const def of defs) {
      const seen = run.done(`check:${def.name}`) as LabelCheck | undefined;
      if (seen && seen.state !== 'mismatch') continue;
      budget(run);
      run.checkpoint();
      const c = await checkLabel(def, call, join(dir, 'check.json'), input.repo);
      if ('error' in c) run.stop(c.error, summary(run));
      run.note(`check:${def.name}`, c);
    }
    const mismatches = defs.flatMap(d => { const c = run.done(`check:${d.name}`) as LabelCheck; return c.state === 'mismatch' ? [{def: d, actual: c.actual}] : []; });
    if (mismatches.length && onMismatch === 'block') run.stop(mismatches.map(m => mismatchProblem(m.def, m.actual)), summary(run));
    // Phase 2: one journaled write per missing (or, with update, mismatching) definition.
    for (const def of defs) {
      const c = run.done(`check:${def.name}`) as LabelCheck;
      if (c.state === 'match') continue;
      budget(run);
      await ensureLabelDefinition(def, call, run, join(dir, def.name.replace(/[^A-Za-z0-9]+/g, '-')), input.repo, onMismatch);
    }
    const data = summary(run);
    return {status: data.created.length || data.updated.length ? 'applied' : 'noop', data};
  });
  return result as ScaffoldResult<LabelsEnsureData>;
}
