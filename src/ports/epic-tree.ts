// The tree of an Epic: the Epic, its native sub-issues (Features) and theirs (Tasks), each with its state.
import {failed, okValue, problem, type CallScope, type Decoded} from '../core/contracts.js';
import {PiGhBridge} from './pi-gh.js';

export interface TreeIssue { number: number; state: 'open' | 'closed'; parent: number | null }

interface Child { number: number; state: 'open' | 'closed'; htmlUrl: string }
function decodeChildren(d: unknown): Child[] | undefined {
  if (!Array.isArray(d)) return undefined;
  const out: Child[] = [];
  for (const x of d) {
    const c = x as {number?: unknown; state?: unknown; html_url?: unknown};
    if (typeof x !== 'object' || x === null || typeof c.number !== 'number' || !Number.isSafeInteger(c.number) || c.number < 1 || (c.state !== 'open' && c.state !== 'closed') || typeof c.html_url !== 'string') return undefined;
    out.push({number: c.number, state: c.state, htmlUrl: c.html_url});
  }
  return out;
}

async function listChildren(repo: string, issue: number, bridge: PiGhBridge, scope: CallScope): Promise<Decoded<Child[]>> {
  const listed = await bridge.call('gh_subissues_list', {repo, issue}, decodeChildren, scope);
  if (listed.status !== 'ok') return failed([problem('TREE_INCOMPLETE', `tree[#${issue}]`, `The sub-issues of #${issue} could not be read completely.`), ...listed.problems]);
  const foreign = listed.data!.filter(c => c.htmlUrl.toLowerCase() !== `https://github.com/${repo}/issues/${c.number}`.toLowerCase());
  if (foreign.length) return failed(foreign.map(c => problem('FOREIGN_CHILD', `tree[${c.htmlUrl}]`, `${c.htmlUrl} is not an Issue of ${repo}; cross-repository children are not supported.`)));
  return okValue(listed.data!);
}

/** Reads the Epic, its Features and their Tasks (closed included) with their states. */
export async function readEpicTree(repo: string, epicIssue: number, bridge: PiGhBridge, scope: CallScope): Promise<Decoded<TreeIssue[]>> {
  const epic = await bridge.call('gh_issue_get', {repo, issue: epicIssue}, (d: unknown) => (d as {state?: unknown} | null)?.state === 'open' || (d as {state?: unknown} | null)?.state === 'closed' ? (d as {state: 'open' | 'closed'}).state : undefined, scope);
  if (epic.status !== 'ok') return failed([problem('TREE_INCOMPLETE', `tree[#${epicIssue}]`, `Epic #${epicIssue} could not be read.`), ...epic.problems]);
  const tree: TreeIssue[] = [{number: epicIssue, state: epic.data!, parent: null}];
  const features = await listChildren(repo, epicIssue, bridge, scope);
  if (!features.ok) return features;
  for (const f of features.value) {
    tree.push({number: f.number, state: f.state, parent: epicIssue});
    const tasks = await listChildren(repo, f.number, bridge, scope);
    if (!tasks.ok) return tasks;
    for (const t of tasks.value) tree.push({number: t.number, state: t.state, parent: f.number});
  }
  return okValue(tree);
}
