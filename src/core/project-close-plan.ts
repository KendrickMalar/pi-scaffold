// Which recorded Projects scaffold_epic_complete closes: only those holding nothing but Issues of the Epic's tree in this repo.
import type {TreeIssue} from '../ports/epic-tree.js';

export interface ProjectClosePlan { close: string[]; alreadyClosed: string[]; skipped: {projectId: string | null; reason: 'not-recorded' | 'foreign-items'}[] }

export function planProjectClose(projectIds: string[] | undefined, tree: TreeIssue[], repo: string, projects: {projectId: string; closed: boolean; items: unknown[]}[]): ProjectClosePlan {
  const plan: ProjectClosePlan = {close: [], alreadyClosed: [], skipped: []};
  if (!projectIds?.length) return {...plan, skipped: [{projectId: null, reason: 'not-recorded'}]};
  const numbers = new Set(tree.map(i => i.number));
  const ours = (item: unknown) => {
    const c = (item as {content?: {__typename?: unknown; number?: unknown; repository?: {nameWithOwner?: unknown}} | null} | null)?.content;
    return c?.__typename === 'Issue' && typeof c.number === 'number' && numbers.has(c.number) && String(c.repository?.nameWithOwner ?? '').toLowerCase() === repo.toLowerCase();
  };
  for (const id of projectIds) {
    const p = projects.find(x => x.projectId === id)!;
    if (p.closed) plan.alreadyClosed.push(id);
    else if (p.items.every(ours)) plan.close.push(id);
    else plan.skipped.push({projectId: id, reason: 'foreign-items'});
  }
  return plan;
}
