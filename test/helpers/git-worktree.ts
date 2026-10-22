import {execFileSync} from 'node:child_process';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {TestContext} from 'node:test';

/** A real git repository at <tmp>/main with one linked worktree at <tmp>/linked; removed after the test. */
export async function gitRepoWithWorktree(t: TestContext): Promise<{root: string; repo: {main: string; linked: string}}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'active-worktree-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  const main = join(root, 'main'), linked = join(root, 'linked');
  execFileSync('git', ['init', '-q', main]);
  execFileSync('git', ['-C', main, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'feat/x', linked]);
  return {root, repo: {main, linked}};
}
