// #12 scaffold_waves_apply: apply a basic-design Wave plan. The #13 validator runs on everything first; then the
// needed "Wave: N" definitions are ensured (#3 helper), each Feature's old Wave label is replaced by a conditional
// label change (B2) that touches nothing else, labels are read back, the plan is saved to the Epic (B1) and the
// whole state is checked again read-only. Labels alone never authorize implementation.
import {join} from 'node:path';
import {
  decodeMutationInput, problem,
  type Decoded, type EpicDocV1, type FeatureSnapshot, type MutationInput, type Problem, type ScaffoldResult, type WavePlan,
} from '../core/contracts.js';
import {patchDoc} from '../core/body-codec.js';
import {canonicalJson, dependencyPlanDigest, taggedDigest, wavePlanDigest} from '../core/digests.js';
import {writeOwnedFile} from '../core/files.js';
import {withOperation} from '../core/lifecycle.js';
import {labelDefinitions} from '../core/label-definitions.js';
import {prepareLabelEdit, waveLabelName} from '../core/label-policy.js';
import {canonicalWavePlan, checkWaveLabels, isWaveLike, normalizeScope, validateWavePlan, type WaveEdge} from '../core/wave-plan.js';
import {validateDependencyGraph} from '../core/dependency-graph.js';
import type {ToolCall} from '../core/runtime.js';
import {readIssue} from '../ports/pi-gh.js';
import {readFeatureSet} from '../ports/feature-set.js';
import {ensureLabelDefinition, readLabels} from './labels-ensure.js';
import {verifyWaves} from './waves-verify.js';

export const WAVES_APPLY = 'scaffold_waves_apply';
export type WavesApplyInput = MutationInput & {plan: unknown};
export interface WavesApplyData { appliedIssues: number[]; unchangedIssues: number[]; pendingIssues: number[]; wavePlanDigest: string }

export function decodeWavesApplyInput(value: unknown): Decoded<WavesApplyInput> {
  // The plan's content is judged by the #13 validator (it reports every problem with its path).
  return decodeMutationInput<{plan: unknown}>(value, {plan: {decode: (_r, v) => v}});
}

interface Blocker { number: number; htmlUrl: string }
const decodeBlockers = (d: unknown): Blocker[] | undefined => Array.isArray(d) && d.every(x => typeof x === 'object' && x !== null && typeof (x as Blocker).number === 'number' && typeof (x as {html_url?: unknown}).html_url === 'string')
  ? d.map(x => ({number: (x as Blocker).number, htmlUrl: (x as {html_url: string}).html_url})) : undefined;
const isWave = (l: string) => /^Wave: [1-9][0-9]{0,2}$/.test(l);

export async function applyWaves(input: WavesApplyInput, call: ToolCall): Promise<ScaffoldResult<WavesApplyData>> {
  const operation = WAVES_APPLY;
  const blocked = (problems: Problem[]): ScaffoldResult<WavesApplyData> => ({status: 'blocked', operation, problems});
  const caps = await call.bridge.requireCapabilities(['gh_issue_get', 'gh_subissues_list', 'gh_dependencies_list', 'gh_labels_list', 'gh_labels_apply', 'gh_issue_labels_if_current', 'gh_issue_edit_if_current'], call.scope);
  if (!caps.ok) return blocked(caps.problems);
  const repoOnly = await call.repoContext(input.repo, null);
  if (!repoOnly.ok) return blocked(repoOnly.problems);
  const epicSnap = await readIssue(input.repo, input.epicIssue, call.bridge, call.scope);
  if (!epicSnap.ok) return blocked(epicSnap.problems);
  if (epicSnap.value.doc.kind !== 'epic') return blocked([problem('NOT_AN_EPIC', 'epicIssue', `#${input.epicIssue} is not a Scaffold Epic.`)]);
  const epic = epicSnap.value.doc;
  const context = await call.repoContext(input.repo, epic.workflowId);
  if (!context.ok) return blocked(context.problems);
  const journal = call.journal(context.value);
  const record = await journal.load(input.operationId);
  const started = !!record && record.steps.some(s => !s.note && s.phase !== 'failed');

  // ---- preflight: everything checked before the first change ----------------------------------------
  const pre: Problem[] = [];
  if (epicSnap.value.state !== 'open') pre.push(problem('ISSUE_CLOSED', 'epicIssue', 'The Epic is closed.'));
  if (epic.stage !== 'basic-design') pre.push(problem('STAGE_MISMATCH', 'stage', `Waves are applied during basic design; the Epic is in ${epic.stage}.`));
  if (epicSnap.value.labels.includes('Blocked')) pre.push(problem('EPIC_BLOCKED', 'labels', 'The Epic is Blocked.'));
  if (!started) {
    if (epicSnap.value.bodySha256 !== input.expectedBodySha256) pre.push(problem('STALE_BODY', 'expectedBodySha256', 'The Epic body changed; read it again.'));
    if (epic.revision !== input.expectedRevision) pre.push(problem('STALE_REVISION', 'expectedRevision', `The Epic is at revision ${epic.revision}.`));
  }
  if (epic.dependencyPlan === null) pre.push(problem('DEPENDENCY_PLAN_UNSET', 'dependencyPlan', 'Register dependencies first (scaffold_dependencies_apply).'));
  if (pre.length) return blocked(pre);
  const set = await readFeatureSet(input.repo, input.epicIssue, call.bridge, call.scope, {workflowId: epic.workflowId});
  if (!set.ok) return blocked(set.problems);
  const features = [...set.value.features].sort((a, b) => a.number - b.number);
  const issues = features.map(f => f.number);
  const edges: WaveEdge[] = [];
  for (const to of issues) {
    const r = await call.bridge.call('gh_dependencies_list', {repo: input.repo, issue: to}, decodeBlockers, call.scope);
    if (r.status !== 'ok') return blocked([problem('DEPENDENCIES_INCOMPLETE', `features[#${to}]`, `Dependencies of #${to} could not be read.`), ...r.problems]);
    for (const b of r.data!) {
      if (b.htmlUrl.toLowerCase() !== `https://github.com/${input.repo}/issues/${b.number}`.toLowerCase() || !issues.includes(b.number)) return blocked([problem('EXTERNAL_DEPENDENCY', `features[#${to}]`, `#${to} depends on ${b.htmlUrl}, outside the Feature set.`)]);
      edges.push({from: b.number, to});
    }
  }
  const graph = validateDependencyGraph(edges, epic.dependencyPlan!, features.map(f => ({issue: f.number, featureKey: f.doc.featureKey, editScope: f.doc.editScope})));
  const tree = new Map<string, readonly string[]>();
  for (const scope of new Set(features.flatMap(f => f.doc.editScope.map(normalizeScope).filter((x): x is string => !!x)))) tree.set(scope, (await call.runtime.git.listTree('HEAD', scope, repoOnly.value.repoRoot)) ?? []);
  const check = validateWavePlan(input.plan, features.map(f => ({issue: f.number, featureKey: f.doc.featureKey, editScope: f.doc.editScope, labels: f.labels})), edges,
    {featureSetDigest: set.value.featureSetDigest, dependencyDigest: dependencyPlanDigest(epic.dependencyPlan)}, s => tree.get(s) ?? []);
  if (graph.status !== 'validated' || !check.passed) return blocked([...graph.problems, ...check.problems]);
  const plan = canonicalWavePlan(input.plan as WavePlan);
  const waveOf = new Map(plan.assignments.map(a => [a.issue, a.wave]));
  // Each Feature's label change: only the Wave label; duplicates and non-canonical names stop (never cleaned up here).
  const edits = new Map<number, {feature: FeatureSnapshot; add: string[]; remove: string[]}>();
  const labelProblems: Problem[] = [];
  for (const f of features) {
    const e = prepareLabelEdit(f, {type: 'Scaffold', scope: 'Feature', stage: f.doc.stage, wave: waveOf.get(f.number)!});
    if (!e.ok) { labelProblems.push(...e.problems.map(p => ({...p, path: `features[#${f.number}].${p.path}`}))); continue; }
    if ([...e.value.add, ...e.value.remove].some(l => !isWave(l))) { labelProblems.push(problem('UNEXPECTED_LABEL_CHANGE', `features[#${f.number}].labels`, `#${f.number} would need non-Wave label changes (${[...e.value.add, ...e.value.remove].join(', ')}); they are not made here.`)); continue; }
    if (e.value.add.length || e.value.remove.length) edits.set(f.number, {feature: f, add: e.value.add, remove: e.value.remove});
  }
  // Same Wave-label rules as #13: several Wave-like labels, or one that is not canonical, stop here (never cleaned up).
  labelProblems.push(...checkWaveLabels(plan, features.map(f => ({issue: f.number, featureKey: f.doc.featureKey, editScope: f.doc.editScope, labels: f.labels})))
    .filter(p => p.code === 'WAVE_LABEL_MULTIPLE' || p.code === 'WAVE_LABEL_NONCANONICAL'));
  if (labelProblems.length) return blocked(labelProblems);

  const dir = join(context.value.workflowStateRoot, 'waves', input.operationId);
  const {operationId: _id, ...payload} = input;
  const result = await withOperation<WavesApplyData>({
    operation, repo: input.repo, workflowId: epic.workflowId, operationId: input.operationId,
    payloadDigest: taggedDigest('waves-apply', {...payload, plan}), journal, scope: call.scope,
  }, async run => {
    const seen = (run.done('preflight') as {plan: WavePlan | null; bodySha256: string} | undefined) ?? (run.note('preflight', {plan: epic.wavePlan, bodySha256: epicSnap.value.bodySha256}), {plan: epic.wavePlan, bodySha256: epicSnap.value.bodySha256});
    // 1. Wave label definitions the plan uses (create missing ones inside the managed range only).
    const needed = [...new Set(plan.assignments.map(a => waveLabelName(a.wave)))];
    if (edits.size || run.record.steps.some(s => s.name.startsWith('create:') || s.name.startsWith('update:'))) {
      const labels = await readLabels(call, input.repo);
      if ('error' in labels) return run.stop(labels.error);
      for (const name of needed) await ensureLabelDefinition(labelDefinitions().find(d => d.name === name)!, labels.labels, call, run, join(dir, 'label-defs'), input.repo);
    }
    // 2. One conditional label change per Feature, against the labels read in this call's preflight.
    for (const f of features) {
      const step = `labels:#${f.number}`;
      if (run.done(step) !== undefined) continue;
      const edit = edits.get(f.number);
      const prev = run.record.steps.find(s => s.name === step);
      // Nothing to change now (already as planned, or a failed earlier attempt that is no longer needed): no write.
      if (!edit && (!prev || prev.phase === 'failed')) continue;
      if (call.overBudget()) run.pause([problem('CALL_BUDGET_EXHAUSTED', '', 'Progress is recorded; call again with the same operationId to continue.')]);
      const want = waveLabelName(waveOf.get(f.number)!);
      const changePath = join(dir, `labels-${f.number}.json`);
      if (edit) await writeOwnedFile(changePath, JSON.stringify({version: 1, repo: input.repo, operation: 'issue-labels-if-current', issue: f.number, add: edit.add, remove: edit.remove, expectedLabelsSha256: edit.feature.labelsSha256}), {root: call.namespaceRoot});
      await run.write(step, () => call.bridge.call('gh_issue_labels_if_current', {changePath}, () => true as const, call.scope), {
        reconcile: async () => { const s = await readIssue(input.repo, f.number, call.bridge, call.scope); if (!s.ok) return 'unknown'; const w = s.value.labels.filter(isWaveLike); return w.length === 1 && w[0] === want ? 'applied' : edit && s.value.labelsSha256 === edit.feature.labelsSha256 ? 'not-applied' : 'unknown'; },
      });
    }
    // 3. Read back every Feature's Wave label.
    const pending: number[] = [];
    for (const f of features) {
      const s = await readIssue(input.repo, f.number, call.bridge, call.scope);
      if (!s.ok) return run.stop(s.problems);
      if (checkWaveLabels(plan, [{issue: f.number, featureKey: f.doc.featureKey, editScope: f.doc.editScope, labels: s.value.labels}]).length) pending.push(f.number);
    }
    if (pending.length) return run.stop([problem('LABELS_NOT_SYNCED', 'labels', `#${pending.join(', #')} do not show their planned Wave.`)], {appliedIssues: [], unchangedIssues: [], pendingIssues: pending, wavePlanDigest: ''});
    // 4. Save the plan to the Epic (only over the plan this operation saw, and only while the Epic is where it was).
    if (run.done('epic-body') === undefined) {
      const fresh = await readIssue(input.repo, input.epicIssue, call.bridge, call.scope);
      if (!fresh.ok) return run.stop(fresh.problems);
      const doc = fresh.value.doc as EpicDocV1;
      const moved: Problem[] = [];
      if (fresh.value.bodySha256 !== seen.bodySha256) moved.push(problem('EPIC_MOVED', 'epicIssue', 'The Epic body was changed by someone else meanwhile; the plan is not written over it.'));
      else if (fresh.value.state !== 'open' || doc.stage !== 'basic-design' || fresh.value.labels.includes('Blocked')) moved.push(problem('EPIC_MOVED', 'epicIssue', 'The Epic changed state meanwhile (closed, stage or Blocked); the plan is not saved.'));
      if (canonicalJson(doc.wavePlan === null ? null : canonicalWavePlan(doc.wavePlan)) !== canonicalJson(seen.plan === null ? null : canonicalWavePlan(seen.plan)) && canonicalJson(doc.wavePlan === null ? null : canonicalWavePlan(doc.wavePlan)) !== canonicalJson(plan)) moved.push(problem('PLAN_CHANGED', 'wavePlan', 'Another Wave plan was saved meanwhile; it is not overwritten.'));
      if (canonicalJson(doc.dependencyPlan) !== canonicalJson(epic.dependencyPlan)) moved.push(problem('DEPENDENCIES_CHANGED', 'dependencyPlan', 'The dependency plan changed meanwhile.'));
      if (moved.length) return run.stop(moved);
      if (canonicalJson(doc.wavePlan === null ? null : canonicalWavePlan(doc.wavePlan)) !== canonicalJson(plan)) {
        const edit = patchDoc(fresh.value, {...doc, wavePlan: plan});
        if (!edit.ok) return run.stop(edit.problems);
        const expected = edit.value;
        const changePath = join(dir, 'epic-body.json');
        await writeOwnedFile(changePath, JSON.stringify(expected), {root: call.namespaceRoot});
        await run.write('epic-body', () => call.bridge.call('gh_issue_edit_if_current', {changePath}, () => true as const, call.scope), {
          reconcile: async () => { const s = await readIssue(input.repo, input.epicIssue, call.bridge, call.scope); if (!s.ok) return 'unknown'; const w = (s.value.doc as EpicDocV1).wavePlan; return w !== null && canonicalJson(canonicalWavePlan(w)) === canonicalJson(plan) ? 'applied' : s.value.bodySha256 === expected.expectedBodySha256 ? 'not-applied' : 'unknown'; },
        });
      }
    }
    // 5. #13-equivalent read-only check of the saved plan, labels and dependencies.
    const verified = await verifyWaves({repo: input.repo, epicIssue: input.epicIssue}, call);
    if (!verified.data?.passed) return run.pause([problem('VERIFY_NOT_PASSED', 'waves', 'The final check did not pass yet; call again with the same operationId.'), ...verified.problems]);
    const applied = features.filter(f => run.record.steps.some(s => s.name === `labels:#${f.number}` && s.phase === 'done' && s.data === true)).map(f => f.number);
    const wrote = run.record.steps.some(s => !s.note && s.phase === 'done');
    const finalDoc = (await readIssue(input.repo, input.epicIssue, call.bridge, call.scope));
    const digest = finalDoc.ok ? wavePlanDigest(finalDoc.value.doc as EpicDocV1) : verified.data!.wavePlanDigest ?? '';
    return {status: wrote ? 'applied' : 'noop', data: {appliedIssues: applied, unchangedIssues: issues.filter(n => !applied.includes(n)), pendingIssues: [], wavePlanDigest: digest}};
  });
  return result as ScaffoldResult<WavesApplyData>;
}
