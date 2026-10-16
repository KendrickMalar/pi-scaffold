// Which local worktree holds an Epic's branch (`epic/<N>-<slug>`), from `git worktree list --porcelain`.
export interface WorktreeEntry { path: string; branch: string | null }

export function parseWorktreePorcelain(text: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let cur: WorktreeEntry | undefined;
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) { cur = {path: line.slice('worktree '.length), branch: null}; out.push(cur); }
    else if (cur && line.startsWith('branch refs/heads/')) cur.branch = line.slice('branch refs/heads/'.length);
  }
  return out;
}

/** The single worktree on `epic/<epicIssue>-*`; undefined when there is none or more than one. */
export function pickEpicWorktree(list: readonly WorktreeEntry[], epicIssue: number): string | undefined {
  const hits = list.filter(w => w.branch !== null && new RegExp(`^epic/${epicIssue}-[a-z0-9-]+$`).test(w.branch));
  return hits.length === 1 ? hits[0]!.path : undefined;
}
