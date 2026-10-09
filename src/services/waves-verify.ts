// #13 scaffold_waves_verify (read-only): check the native Feature set, the Wave plan (input or the Epic's), GitHub
// dependencies and Wave labels. Everything is read twice; any change in between means "not passed, read again".
// Never fixes anything, creates labels or touches Projects.
import {StrictReader, isRepoRef, problem, type Decoded, type EpicDocV1, type FeatureSnapshot, type Problem, type ScaffoldResult} from '../core/contracts.js';
import {canonicalJson, taggedDigest, wavePlanDigest} from '../core/digests.js';
import {canonicalWavePlan, checkWaveLabels, normalizeScope, validateWavePlan, type WaveEdge, type WaveFeature} from '../core/wave-plan.js';
import {validateDependencyGraph} from '../core/dependency-graph.js';
import type {ToolCall} from '../core/runtime.js';
import {readIssue} from '../ports/pi-gh.js';
import {readFeatureSet} from '../ports/feature-set.js';

export const WAVES_VERIFY = 'scaffold_waves_verify';
export interface WavesVerifyInput { repo: string; epicIssue: number; plan?: unknown }
export interface WavesVerifyData { passed: boolean; checks: string[]; featureSetDigest: string | null; wavePlanDigest: string | null; matchesSavedPlan: boolean }

export function decodeWavesVerifyInput(value: unknown): Decoded<WavesVerifyInput> {
  const r = new StrictReader();
  const o = r.object(value, '', ['repo', 'epicIssue'], ['plan']);
  if (!o) return r.result(undefined as never);
  const input: WavesVerifyInput = {repo: r.pattern(o.repo, 'repo', isRepoRef, 'OWNER/REPO'), epicIssue: r.int(o.epicIssue, 'epicIssue')};
  // The plan's own content is judged by the validator (a bad plan is "not passed", not an input error).
  if (o.plan !== undefined) input.plan = o.plan;
  return r.result(input);
}

interface Blocker { number: number; htmlUrl: string }
const decodeBlockers = (d: unknown): Blocker[] | undefined => Array.isArray(d) && d.every(x => typeof x === 'object' && x !== null && typeof (x as Blocker).number === 'number' && typeof (x as {html_url?: unknown}).html_url === 'string')
  ? d.map(x => ({number: (x as Blocker).number, htmlUrl: (x as {html_url: string}).html_url})) : undefined;

interface Reading { epic: EpicDocV1; epicBodySha: string; snapshots: FeatureSnapshot[]; features: WaveFeature[]; featureSetDigest: string; edges: WaveEdge[]; problems: Problem[]; fingerprint: string }

async function readAll(input: WavesVerifyInput, call: ToolCall): Promise<Reading | Problem[]> {
  const snap = await readIssue(input.repo, input.epicIssue, call.bridge, call.scope);
  if (!snap.ok) return snap.problems;
  if (snap.value.doc.kind !== 'epic') return [problem('NOT_AN_EPIC', 'epicIssue', `#${input.epicIssue} is not a Scaffold Epic.`)];
  const epic = snap.value.doc;
  const set = await readFeatureSet(input.repo, input.epicIssue, call.bridge, call.scope, {workflowId: epic.workflowId});
  if (!set.ok) return set.problems;
  const all = [...set.value.features].sort((a, b) => a.number - b.number);
  const features = all.map(f => ({issue: f.number, featureKey: f.doc.featureKey, editScope: f.doc.editScope, labels: f.labels}));
  const issues = features.map(f => f.issue);
  const edges: WaveEdge[] = [], problems: Problem[] = [];
  for (const to of issues) {
    const r = await call.bridge.call('gh_dependencies_list', {repo: input.repo, issue: to}, decodeBlockers, call.scope);
    if (r.status !== 'ok') return [problem('DEPENDENCIES_INCOMPLETE', `features[#${to}]`, `Dependencies of #${to} could not be read.`), ...r.problems];
    for (const b of r.data!) {
      const local = b.htmlUrl.toLowerCase() === `https://github.com/${input.repo}/issues/${b.number}`.toLowerCase();
      if (!local || !issues.includes(b.number)) problems.push(problem('EXTERNAL_DEPENDENCY', `features[#${to}]`, `#${to} depends on ${b.htmlUrl}, outside the Feature set.`));
      else edges.push({from: b.number, to});
    }
  }
  edges.sort((a, b) => a.from - b.from || a.to - b.to);
  const fingerprint = taggedDigest('waves-reading', {epic: snap.value.bodySha256, features: all.map(f => ({n: f.number, body: f.bodySha256, labels: f.labelsSha256, state: f.state})), edges});
  return {epic, epicBodySha: snap.value.bodySha256, snapshots: all, features, featureSetDigest: set.value.featureSetDigest, edges, problems, fingerprint};
}

export async function verifyWaves(input: WavesVerifyInput, call: ToolCall): Promise<ScaffoldResult<WavesVerifyData>> {
  return (await verifyWavesReading(input, call)).result;
}

/** verifyWaves plus the consistent reading it judged (for callers that must decide on exactly the same Features). */
export async function verifyWavesReading(input: WavesVerifyInput, call: ToolCall): Promise<{result: ScaffoldResult<WavesVerifyData>; reading?: {epicBodySha: string; snapshots: FeatureSnapshot[]; featureSetDigest: string}}> {
  const r = await verifyWavesInner(input, call);
  return r;
}

async function verifyWavesInner(input: WavesVerifyInput, call: ToolCall): Promise<{result: ScaffoldResult<WavesVerifyData>; reading?: {epicBodySha: string; snapshots: FeatureSnapshot[]; featureSetDigest: string}}> {
  const wrap = (result: ScaffoldResult<WavesVerifyData>, reading?: Reading) => ({result, ...(reading ? {reading: {epicBodySha: reading.epicBodySha, snapshots: reading.snapshots, featureSetDigest: reading.featureSetDigest}} : {})});
  const operation = WAVES_VERIFY;
  const notPassed = (problems: Problem[], extra: Partial<WavesVerifyData> = {}): ScaffoldResult<WavesVerifyData> =>
    ({status: 'blocked', operation, problems, data: {passed: false, checks: [], featureSetDigest: null, wavePlanDigest: null, matchesSavedPlan: false, ...extra}});
  const caps = await call.bridge.requireCapabilities(['gh_issue_get', 'gh_subissues_list', 'gh_dependencies_list'], call.scope);
  if (!caps.ok) return wrap(notPassed(caps.problems));
  const repoOnly = await call.repoContext(input.repo, null);
  if (!repoOnly.ok) return wrap(notPassed(repoOnly.problems));
  const first = await readAll(input, call);
  if (Array.isArray(first)) return wrap(notPassed(first));
  const second = await readAll(input, call);
  if (Array.isArray(second)) return wrap(notPassed(second));
  if (first.fingerprint !== second.fingerprint) return wrap(notPassed([problem('CHANGED_DURING_READ', '', 'The Epic, its Features, labels or dependencies changed while reading; read again.')]));
  const {epic, features, edges} = second;
  const problems = [...second.problems];
  if (epic.dependencyPlan === null) problems.push(problem('DEPENDENCY_PLAN_UNSET', 'dependencyPlan', 'The Epic has no dependency plan yet (scaffold_dependencies_apply).'));
  else {
    const saved = epic.dependencyPlan.edges.map(e => ({from: e.from, to: e.to})).sort((a, b) => a.from - b.from || a.to - b.to);
    if (canonicalJson(saved) !== canonicalJson(edges)) problems.push(problem('DEPENDENCIES_DIFFER', 'dependencyPlan', 'GitHub dependencies differ from the Epic\'s saved dependency plan.'));
    // The saved dependency plan must still describe exactly these Features (keys and edit scopes).
    const graph = validateDependencyGraph(edges, epic.dependencyPlan, features.map(f => ({issue: f.issue, featureKey: f.featureKey, editScope: f.editScope})));
    problems.push(...graph.problems.filter(p => p.code !== 'UNDECLARED_EDGE'));
  }
  // Directory scopes are expanded with the local repository so shared manifests/state inside them count.
  const tree = new Map<string, readonly string[]>();
  for (const scope of new Set(features.flatMap(f => f.editScope.map(normalizeScope).filter((x): x is string => !!x)))) {
    tree.set(scope, (await call.runtime.git.listTree('HEAD', scope, repoOnly.value.repoRoot)) ?? []);
  }
  const rawPlan = input.plan !== undefined ? input.plan : epic.wavePlan;
  const check = validateWavePlan(rawPlan, features, edges, {featureSetDigest: second.featureSetDigest, dependencyDigest: taggedDigest('dependency-plan', epic.dependencyPlan)}, s => tree.get(s) ?? []);
  problems.push(...check.problems);
  const checks = [...check.checks];
  let digest: string | null = null, matchesSavedPlan = false;
  if (check.checks.includes('plan-format')) {
    const plan = canonicalWavePlan(rawPlan as Parameters<typeof checkWaveLabels>[0]);
    digest = wavePlanDigest({...epic, wavePlan: plan});
    matchesSavedPlan = epic.wavePlan !== null && digest === wavePlanDigest({...epic, wavePlan: canonicalWavePlan(epic.wavePlan)});
    problems.push(...checkWaveLabels(plan, features)); checks.push('labels');
  }
  const data = {passed: problems.length === 0, checks, featureSetDigest: second.featureSetDigest, wavePlanDigest: digest, matchesSavedPlan};
  return wrap(problems.length ? {status: 'blocked', operation, problems, data} : {status: 'validated', operation, problems: [], data}, second);
}
