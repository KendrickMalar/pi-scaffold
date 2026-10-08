// #11 dependency graph (pure). Edges point from the earlier Feature (from) to the later one (to); on GitHub the later
// Issue is "blocked by" the earlier one. The plan must cover exactly the Feature set, and the existing edges must be in it.
import {problem, type DependencyPlan, type GateResult, type Problem} from './contracts.js';
import {taggedDigest} from './digests.js';

export interface GraphFeature { issue: number; featureKey: string; editScope: readonly string[] }
export interface Edge { from: number; to: number }
const key = (e: Edge) => `${e.from}->${e.to}`;

export function validateDependencyGraph(current: readonly Edge[], plan: DependencyPlan, features: readonly GraphFeature[]): GateResult {
  const problems: Problem[] = [];
  const byIssue = new Map(features.map(f => [f.issue, f]));
  const seen = new Set<number>();
  plan.nodes.forEach((n, i) => {
    const at = `plan.nodes[${i}]`;
    if (seen.has(n.issue)) problems.push(problem('DUPLICATE_ID', `${at}.issue`, `#${n.issue} is listed twice.`));
    seen.add(n.issue);
    const f = byIssue.get(n.issue);
    if (!f) return problems.push(problem('UNKNOWN_NODE', `${at}.issue`, `#${n.issue} is not a Feature of this Epic.`));
    if (f.featureKey !== n.featureKey) problems.push(problem('NODE_MISMATCH', `${at}.featureKey`, `#${n.issue} is ${f.featureKey}, not ${n.featureKey}.`));
    if (JSON.stringify([...f.editScope]) !== JSON.stringify(n.editScope)) problems.push(problem('EDIT_SCOPE_MISMATCH', `${at}.editScope`, `${f.featureKey}'s edit scope differs from the Feature Issue.`));
  });
  for (const f of features) if (!seen.has(f.issue)) problems.push(problem('NODE_MISSING', 'plan.nodes', `${f.featureKey} (#${f.issue}) is missing; the plan must cover every Feature (closed included).`));
  const edges = new Set<string>();
  plan.edges.forEach((e, i) => {
    const at = `plan.edges[${i}]`;
    if (e.from === e.to) problems.push(problem('SELF_EDGE', at, `#${e.from} cannot depend on itself.`));
    for (const end of [e.from, e.to]) if (!byIssue.has(end) || !seen.has(end)) problems.push(problem('UNKNOWN_NODE', at, `#${end} is not a node of the plan.`));
    if (edges.has(key(e))) problems.push(problem('DUPLICATE_EDGE', at, `#${e.from} → #${e.to} is given twice.`));
    edges.add(key(e));
  });
  for (const e of current) if (!edges.has(key(e))) problems.push(problem('UNDECLARED_EDGE', 'plan.edges', `GitHub already has #${e.from} → #${e.to}; include it in the plan (dependencies are never removed here).`));
  const cycle = findCycle([...current, ...plan.edges.filter(e => e.from !== e.to)]);
  if (cycle) problems.push(problem('CYCLE', 'plan.edges', `Dependencies form a cycle: ${cycle.map(n => '#' + n).join(' → ')}.`));
  return {status: problems.length ? 'blocked' : 'validated', problems, artifactDigests: {dependencyPlan: taggedDigest('dependency-plan', plan)}};
}

function findCycle(edges: readonly Edge[]): number[] | undefined {
  const next = new Map<number, number[]>();
  for (const e of edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const state = new Map<number, 1 | 2>(), stack: number[] = [];
  const visit = (n: number): number[] | undefined => {
    state.set(n, 1); stack.push(n);
    for (const m of next.get(n) ?? []) {
      if (state.get(m) === 1) return [...stack.slice(stack.indexOf(m)), m];
      if (!state.has(m)) { const c = visit(m); if (c) return c; }
    }
    stack.pop(); state.set(n, 2);
    return undefined;
  };
  for (const n of next.keys()) if (!state.has(n)) { const c = visit(n); if (c) return c; }
  return undefined;
}

/** Mermaid from fixed, validated IDs only (featureKey F\d+ and Issue numbers); no plan text becomes syntax. */
export function renderDependencyMermaid(plan: DependencyPlan): string {
  const id = new Map(plan.nodes.map(n => [n.issue, n.featureKey]));
  const safe = (k: string) => /^F[0-9]{3,}$/.test(k) ? k : 'INVALID';
  const lines = ['graph LR', ...plan.nodes.map(n => `  ${safe(n.featureKey)}["${safe(n.featureKey)} #${Math.trunc(n.issue)}"]`),
    ...plan.edges.map(e => `  ${safe(id.get(e.from) ?? '')} --> ${safe(id.get(e.to) ?? '')}`)];
  return lines.join('\n') + '\n';
}
