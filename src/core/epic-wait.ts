// Whether an Epic waits for the orchestrator's plan: the scaffold:plan-pending mark, or a blocked-by on an open Epic of
// the same repository. Closed blockers, non-Epic blockers and blockers in other repositories never make an Epic wait.
import {problem, type Decoded, type IssueSnapshot, type Problem} from './contracts.js';
import type {ToolCall} from './runtime.js';

export const PLAN_PENDING_LABEL = 'scaffold:plan-pending';
export interface EpicWait { planPending: boolean; openBlockers: number[] }
interface RawBlocker { number: number; htmlUrl: string; state: string; labels: string[] }

const decodeBlockers = (d: unknown): RawBlocker[] | undefined => {
  if (!Array.isArray(d)) return undefined;
  const out: RawBlocker[] = [];
  for (const x of d) {
    if (typeof x !== 'object' || x === null) return undefined;
    const o = x as {number?: unknown; html_url?: unknown; state?: unknown; labels?: unknown};
    if (typeof o.number !== 'number' || typeof o.html_url !== 'string' || typeof o.state !== 'string' || !Array.isArray(o.labels)) return undefined;
    const labels: string[] = [];
    for (const l of o.labels) {
      const name = typeof l === 'string' ? l : (l as {name?: unknown} | null)?.name;
      if (typeof name !== 'string') return undefined;
      labels.push(name);
    }
    out.push({number: o.number, htmlUrl: o.html_url, state: o.state, labels});
  }
  return out;
};

export const hasPlanPending = (labels: readonly string[]) => labels.some(l => l.toLowerCase() === PLAN_PENDING_LABEL);

/** Reads the mark from the snapshot and the blocked-by list through gh_dependencies_list. */
export async function readEpicWait(repo: string, snapshot: IssueSnapshot, call: ToolCall): Promise<Decoded<EpicWait>> {
  const planPending = hasPlanPending(snapshot.labels);
  const r = await call.bridge.call('gh_dependencies_list', {repo, issue: snapshot.number}, decodeBlockers, call.scope);
  if (r.status !== 'ok') {
    return {ok: false, problems: [problem('DEPENDENCIES_UNREADABLE', 'blockedBy', `The blocked-by list of #${snapshot.number} could not be read.`), ...r.problems] as Problem[]};
  }
  const openBlockers = r.data!
    .filter(b => b.htmlUrl.toLowerCase() === `https://github.com/${repo}/issues/${b.number}`.toLowerCase())
    .filter(b => b.state.toLowerCase() === 'open')
    .filter(b => b.labels.some(l => l.toLowerCase() === 'scope: epic'))
    .map(b => b.number)
    .sort((a, b) => a - b);
  return {ok: true, value: {planPending, openBlockers: [...new Set(openBlockers)]}};
}

/** The handoff gate's problems: PLAN_PENDING first, then EPIC_WAITING naming every open Epic blocker. */
export function epicWaitProblems(wait: EpicWait): Problem[] {
  return [
    ...(wait.planPending ? [problem('PLAN_PENDING', 'labels', `The Epic is labelled ${PLAN_PENDING_LABEL}; it waits for the orchestrator's plan.`)] : []),
    ...(wait.openBlockers.length ? [problem('EPIC_WAITING', 'blockedBy', `The Epic waits for open Epics: ${wait.openBlockers.map(n => `#${n}`).join(', ')}.`)] : []),
  ];
}
