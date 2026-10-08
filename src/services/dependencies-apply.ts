// #11 scaffold_dependencies_apply: validate the Feature dependency plan against the complete native Feature set and the
// current GitHub dependencies, add only missing edges (never remove), optionally add Features to an existing Project, and
// save the plan (with a fixed-ID Mermaid diagram) into the Epic. Each change is journaled and reconciled before any resend.
import {join} from 'node:path';
import {
  decodeMutationInput, problem, readDependencyPlan,
  type Decoded, type DependencyPlan, type EpicDocV1, type IssueSnapshot, type MutationInput, type Problem, type ScaffoldResult,
} from '../core/contracts.js';
import {patchDoc} from '../core/body-codec.js';
import {canonicalJson, taggedDigest} from '../core/digests.js';
import {writeOwnedFile} from '../core/files.js';
import {withOperation} from '../core/lifecycle.js';
import {renderDependencyMermaid, validateDependencyGraph, type Edge} from '../core/dependency-graph.js';
import type {ToolCall} from '../core/runtime.js';
import {readIssue} from '../ports/pi-gh.js';
import {readFeatureSet} from '../ports/feature-set.js';

export const DEPENDENCIES_APPLY = 'scaffold_dependencies_apply';
export type DependenciesApplyInput = MutationInput & {plan: DependencyPlan; projectId?: string};
export interface DependenciesApplyData { addedEdges: Edge[]; unchangedEdges: Edge[]; mermaid: string; projectItems: number[] }
const PROJECT_RE = /^PVT_[A-Za-z0-9_-]{1,200}$/;

export function decodeDependenciesApplyInput(value: unknown): Decoded<DependenciesApplyInput> {
  return decodeMutationInput<{plan: DependencyPlan; projectId?: string}>(value, {
    plan: {decode: (r, v, p) => readDependencyPlan(r, v, p)},
    projectId: {optional: true, decode: (r, v, p) => r.pattern(v, p, x => typeof x === 'string' && PROJECT_RE.test(x), 'a Projects V2 node id (PVT_…)')},
  });
}

interface Blocker { number: number; htmlUrl: string }
const decodeBlockers = (d: unknown): Blocker[] | undefined => {
  if (!Array.isArray(d)) return undefined;
  const out: Blocker[] = [];
  for (const x of d) {
    const o = x as {number?: unknown; html_url?: unknown};
    if (typeof x !== 'object' || x === null || typeof o.number !== 'number' || typeof o.html_url !== 'string') return undefined;
    out.push({number: o.number, htmlUrl: o.html_url});
  }
  return out;
};
const decodeItems = (repo: string) => (d: unknown): number[] | undefined => {
  const items = (d as {items?: unknown} | null)?.items;
  if (!Array.isArray(items)) return undefined;
  return items.flatMap(i => {
    const c = (i as {content?: {__typename?: unknown; number?: unknown; repository?: {nameWithOwner?: unknown}} | null})?.content;
    return c && c.__typename === 'Issue' && typeof c.number === 'number' && String(c.repository?.nameWithOwner ?? '').toLowerCase() === repo.toLowerCase() ? [c.number] : [];
  });
};

export async function applyDependencies(input: DependenciesApplyInput, call: ToolCall): Promise<ScaffoldResult<DependenciesApplyData>> {
  const operation = DEPENDENCIES_APPLY;
  const blocked = (problems: Problem[]): ScaffoldResult<DependenciesApplyData> => ({status: 'blocked', operation, problems});
  const tools = ['gh_issue_get', 'gh_subissues_list', 'gh_dependencies_list', 'gh_dependency_add', 'gh_issue_edit_if_current', ...(input.projectId ? ['gh_project_items', 'gh_project_add_issue'] : [])];
  const caps = await call.bridge.requireCapabilities(tools, call.scope);
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
  // Once anything may have changed on GitHub, a resume continues from the journal instead of re-judging the caller's view.
  const started = !!record && record.steps.some(s => !s.note && s.phase !== 'failed');

  const readEdges = async (issues: number[]): Promise<{edges: Edge[]; problems: Problem[]}> => {
    const edges: Edge[] = [], problems: Problem[] = [];
    for (const to of issues) {
      const r = await call.bridge.call('gh_dependencies_list', {repo: input.repo, issue: to}, decodeBlockers, call.scope);
      if (r.status !== 'ok') { problems.push(problem('DEPENDENCIES_INCOMPLETE', `features[#${to}]`, `Dependencies of #${to} could not be read.`), ...r.problems); continue; }
      for (const b of r.data!) {
        const local = b.htmlUrl.toLowerCase() === `https://github.com/${input.repo}/issues/${b.number}`.toLowerCase();
        if (!local || !issues.includes(b.number)) problems.push(problem('EXTERNAL_DEPENDENCY', `features[#${to}]`, `#${to} depends on ${b.htmlUrl}, which is not a Feature of this Epic; it is left as is and nothing is changed.`));
        else edges.push({from: b.number, to});
      }
    }
    return {edges, problems};
  };

  // ---- preflight (zero side effects) --------------------------------------------------------------
  const pre: Problem[] = [];
  if (epicSnap.value.state !== 'open') pre.push(problem('ISSUE_CLOSED', 'epicIssue', 'The Epic is closed.'));
  if (epic.stage !== 'basic-design') pre.push(problem('STAGE_MISMATCH', 'stage', `Dependencies are planned during basic design; the Epic is in ${epic.stage}.`));
  if (epicSnap.value.labels.includes('Blocked')) pre.push(problem('EPIC_BLOCKED', 'labels', 'The Epic is Blocked.'));
  if (!started) {
    if (epicSnap.value.bodySha256 !== input.expectedBodySha256) pre.push(problem('STALE_BODY', 'expectedBodySha256', 'The Epic body changed; read it again.'));
    if (epic.revision !== input.expectedRevision) pre.push(problem('STALE_REVISION', 'expectedRevision', `The Epic is at revision ${epic.revision}.`));
  }
  if (pre.length) return blocked(pre);
  const knownCreated = (await journal.list()).filter(r => r.operation === 'scaffold_feature_create' && !r.abandonedAt)
    .flatMap(r => { const n = (r.steps.find(s => s.name === 'submit' && s.phase === 'done')?.data ?? r.steps.find(s => s.name === 'found')?.data) as {number?: number} | undefined; return n?.number ? [{number: n.number, createOperationId: r.operationId}] : []; });
  const set = await readFeatureSet(input.repo, input.epicIssue, call.bridge, call.scope, {workflowId: epic.workflowId, knownCreated});
  if (!set.ok) return blocked(set.problems);
  if (set.value.unattached.length) return blocked(set.value.unattached.map(f => problem('FEATURE_UNATTACHED', `features[#${f.number}]`, `#${f.number} was created but is not attached to the Epic yet; finish scaffold_feature_create first.`)));
  const features = set.value.features.map(f => ({issue: f.number, featureKey: f.doc.featureKey, editScope: f.doc.editScope}));
  const issues = features.map(f => f.issue);
  const current = await readEdges(issues);
  if (current.problems.length) return blocked(current.problems);
  // On resume our own added edges are now "current"; they are part of the plan, so the check still holds.
  const gate = validateDependencyGraph(current.edges, input.plan, features);
  if (gate.status !== 'validated') return blocked(gate.problems);
  let projectBefore: number[] | undefined;
  if (input.projectId) {
    const items = await call.bridge.call('gh_project_items', {projectId: input.projectId}, decodeItems(input.repo), call.scope);
    if (items.status !== 'ok') return blocked([problem('PROJECT_UNREADABLE', 'projectId', 'The Project could not be read (it must already exist; it is never created here).'), ...items.problems]);
    projectBefore = items.data!;
  }

  const has = (edges: Edge[], e: Edge) => edges.some(x => x.from === e.from && x.to === e.to);
  const plannedEdges = input.plan.edges.map(e => ({from: e.from, to: e.to}));
  const dir = join(context.value.workflowStateRoot, 'dependencies', input.operationId);
  const {operationId: _id, ...payload} = input;
  const mermaid = renderDependencyMermaid(input.plan);
  const result = await withOperation<DependenciesApplyData>({
    operation, repo: input.repo, workflowId: epic.workflowId, operationId: input.operationId,
    payloadDigest: taggedDigest('dependencies-apply', payload), journal, scope: call.scope,
  }, async run => {
    // The edges that existed before this operation's first change are its "unchanged" ones.
    const baseline = (run.done('baseline') as {edges: Edge[]} | undefined)?.edges ?? (run.note('baseline', {edges: current.edges}), current.edges);
    const added: Edge[] = [];
    for (const e of plannedEdges) {
      if (has(baseline, e)) continue;
      const step = `edge:${e.from}->${e.to}`;
      added.push(e);
      if (run.done(step) !== undefined) continue;
      if (call.overBudget()) run.pause([problem('CALL_BUDGET_EXHAUSTED', '', 'Progress is recorded; call again with the same operationId to continue.')]);
      const changePath = join(dir, `edge-${e.from}-${e.to}.json`);
      await writeOwnedFile(changePath, JSON.stringify({version: 1, repo: input.repo, operation: 'dependency-add', issue: e.to, relatedIssue: e.from}), {root: call.namespaceRoot});
      await run.write(step, () => call.bridge.call('gh_dependency_add', {changePath}, () => true as const, call.scope), {
        reconcile: async () => { const r = await readEdges([e.to, e.from]); const present = r.edges.some(x => x.from === e.from && x.to === e.to); return present ? 'applied' : r.problems.length ? 'unknown' : 'not-applied'; },
      });
    }
    let projectItems: number[] = [];
    if (input.projectId) {
      for (const n of issues) {
        if (projectBefore!.includes(n)) continue;
        const step = `project:#${n}`;
        if (run.done(step) !== undefined) continue;
        const changePath = join(dir, `project-${n}.json`);
        await writeOwnedFile(changePath, JSON.stringify({version: 1, repo: input.repo, operation: 'project-add-issue', issue: n, projectId: input.projectId}), {root: call.namespaceRoot});
        await run.write(step, () => call.bridge.call('gh_project_add_issue', {changePath}, () => true as const, call.scope), {
          reconcile: async () => { const r = await call.bridge.call('gh_project_items', {projectId: input.projectId}, decodeItems(input.repo), call.scope); return r.status !== 'ok' ? 'unknown' : r.data!.includes(n) ? 'applied' : 'not-applied'; },
        });
      }
      const after = await call.bridge.call('gh_project_items', {projectId: input.projectId}, decodeItems(input.repo), call.scope);
      if (after.status !== 'ok') return run.stop(after.problems);
      const missing = issues.filter(n => !after.data!.includes(n));
      if (missing.length) return run.stop([problem('PROJECT_ITEM_MISSING', 'projectId', `#${missing.join(', #')} are not in the Project.`)]);
      projectItems = [...issues].sort((a, b) => a - b);
    }
    // Save the plan into the Epic last, from a fresh read (conditional on that body).
    if (run.done('epic-body') === undefined) {
      const fresh = await readIssue(input.repo, input.epicIssue, call.bridge, call.scope);
      if (!fresh.ok) return run.stop(fresh.problems);
      const doc = fresh.value.doc as EpicDocV1;
      const changePath = join(dir, 'epic-body.json');
      if (canonicalJson(doc.dependencyPlan) !== canonicalJson(input.plan)) {
        const edit = patchDoc(fresh.value, {...doc, dependencyPlan: input.plan});
        if (!edit.ok) return run.stop(edit.problems);
        const expected = edit.value;
        await writeOwnedFile(changePath, JSON.stringify(expected), {root: call.namespaceRoot});
        await run.write('epic-body', () => call.bridge.call('gh_issue_edit_if_current', {changePath}, () => true as const, call.scope), {
          reconcile: async () => { const s = await readIssue(input.repo, input.epicIssue, call.bridge, call.scope); if (!s.ok) return 'unknown'; return canonicalJson((s.value.doc as EpicDocV1).dependencyPlan) === canonicalJson(input.plan) ? 'applied' : s.value.bodySha256 === expected.expectedBodySha256 ? 'not-applied' : 'unknown'; },
        });
      }
    }
    const final = await readIssue(input.repo, input.epicIssue, call.bridge, call.scope);
    if (!final.ok) return run.stop(final.problems);
    if (canonicalJson((final.value.doc as EpicDocV1).dependencyPlan) !== canonicalJson(input.plan)) return run.stop([problem('PLAN_NOT_SAVED', 'epicIssue', 'The Epic does not show this dependency plan.')]);
    const wrote = run.record.steps.some(s => !s.note && s.phase === 'done');
    return {status: wrote ? 'applied' : 'noop', data: {addedEdges: added, unchangedEdges: plannedEdges.filter(e => has(baseline, e)), mermaid, projectItems}};
  });
  return result as ScaffoldResult<DependenciesApplyData>;
}
