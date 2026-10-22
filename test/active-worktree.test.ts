import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {activeWorktree, docsCwd, setActiveWorktree} from '../src/core/active-worktree.js';
import {gitRepoWithWorktree} from './helpers/git-worktree.js';

test('setActiveWorktree keeps only two absolute paths; anything else clears it', t => {
  t.after(() => setActiveWorktree(null));
  setActiveWorktree({path: '/w/linked', mainRoot: '/w/main'});
  assert.deepEqual(activeWorktree(), {path: '/w/linked', mainRoot: '/w/main'});
  for (const bad of [null, undefined, {path: null, mainRoot: null}, {path: 'rel', mainRoot: '/w/main'}, {path: '/w/linked'}, 'x']) {
    setActiveWorktree({path: '/w/linked', mainRoot: '/w/main'});
    setActiveWorktree(bad);
    assert.equal(activeWorktree(), undefined, JSON.stringify(bad));
  }
});

test('docsCwd follows a linked worktree of the same repository, keeping a subdirectory', async t => {
  const {repo} = await gitRepoWithWorktree(t);
  const active = {path: repo.linked, mainRoot: repo.main};
  assert.equal(await docsCwd(repo.main, undefined), repo.main);
  assert.equal(await docsCwd(repo.main, active), repo.linked);
  await mkdir(join(repo.main, 'pkg'));
  assert.equal(await docsCwd(join(repo.main, 'pkg'), active), join(repo.linked, 'pkg'));
});

test('docsCwd keeps cwd for another repository, an unlisted directory, or the main worktree itself', async t => {
  const a = await gitRepoWithWorktree(t), b = await gitRepoWithWorktree(t);
  assert.equal(await docsCwd(a.repo.main, {path: b.repo.linked, mainRoot: b.repo.main}), a.repo.main, 'cwd outside the announced main worktree');
  assert.equal(await docsCwd(a.repo.main, {path: b.repo.linked, mainRoot: a.repo.main}), a.repo.main, 'worktree of another repository');
  const plain = join(a.root, 'plain'); await mkdir(plain);
  assert.equal(await docsCwd(a.repo.main, {path: plain, mainRoot: a.repo.main}), a.repo.main, 'not a worktree');
  assert.equal(await docsCwd(a.repo.main, {path: a.repo.main, mainRoot: a.repo.main}), a.repo.main);
  assert.equal(await docsCwd(a.repo.main, {path: join(a.root, 'gone'), mainRoot: a.repo.main}), a.repo.main, 'missing path');
  execFileSync('git', ['-C', a.repo.main, 'worktree', 'remove', a.repo.linked]);
  assert.equal(await docsCwd(a.repo.main, {path: a.repo.linked, mainRoot: a.repo.main}), a.repo.main, 'removed worktree');
});
