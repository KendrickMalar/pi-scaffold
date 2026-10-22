// The linked worktree this session redirects its file and bash tools to. Another extension (dotfiles'
// enforce-worktree) announces it on pi.events as "worktree:active" { path, mainRoot }, because ctx.cwd stays at
// the main worktree. Only the pinned-doc check follows it; every other tool keeps ctx.cwd.
import {execFile} from 'node:child_process';
import {realpath} from 'node:fs/promises';
import {isAbsolute, join, relative} from 'node:path';
import {promisify} from 'node:util';

export const ACTIVE_WORKTREE_CHANNEL = 'worktree:active';
export interface ActiveWorktree { path: string; mainRoot: string }

let current: ActiveWorktree | undefined;

/** Accepts the event payload; anything but two absolute paths (e.g. path null) clears it. */
export function setActiveWorktree(data: unknown): void {
  const o = data as {path?: unknown; mainRoot?: unknown} | null | undefined;
  current = typeof o?.path === 'string' && typeof o.mainRoot === 'string' && isAbsolute(o.path) && isAbsolute(o.mainRoot)
    ? {path: o.path, mainRoot: o.mainRoot} : undefined;
}

export function activeWorktree(): ActiveWorktree | undefined { return current; }

const run = promisify(execFile);

/**
 * The directory to read pinned docs from: the same relative place in the active worktree when cwd lies in its main
 * worktree and git lists it as a linked worktree of that repository; otherwise cwd itself.
 */
export async function docsCwd(cwd: string, active: ActiveWorktree | undefined = current): Promise<string> {
  if (!active) return cwd;
  try {
    const [here, main, target] = await Promise.all([realpath(cwd), realpath(active.mainRoot), realpath(active.path)]);
    const rel = relative(main, here);
    if (rel.startsWith('..') || isAbsolute(rel)) return cwd;
    const {stdout} = await run('git', ['-C', main, 'worktree', 'list', '--porcelain'], {timeout: 5000});
    const listed = await Promise.all(stdout.split('\n').filter(l => l.startsWith('worktree ')).map(l => realpath(l.slice(9)).catch(() => '')));
    if (target === main || !listed.includes(target)) return cwd;
    return rel ? join(target, rel) : target;
  } catch {
    return cwd;
  }
}
