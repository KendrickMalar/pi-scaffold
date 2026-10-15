import test from 'node:test';
import assert from 'node:assert/strict';
import {parseWorktreePorcelain, pickEpicWorktree} from '../src/core/epic-worktree.js';

const PORCELAIN = [
  'worktree /r/main', 'HEAD aaaa', 'branch refs/heads/main', '',
  'worktree /w/epic-2', 'HEAD bbbb', 'branch refs/heads/epic/2-cloud-castle', '',
  'worktree /w/epic-20', 'HEAD cccc', 'branch refs/heads/epic/20-other', '',
  'worktree /w/detached', 'HEAD dddd', 'detached', '',
].join('\n');

test('parseWorktreePorcelain reads path and branch, null for detached', () => {
  assert.deepEqual(parseWorktreePorcelain(PORCELAIN), [
    {path: '/r/main', branch: 'main'}, {path: '/w/epic-2', branch: 'epic/2-cloud-castle'},
    {path: '/w/epic-20', branch: 'epic/20-other'}, {path: '/w/detached', branch: null},
  ]);
});

test('pickEpicWorktree matches the Epic number exactly, not by prefix', () => {
  const list = parseWorktreePorcelain(PORCELAIN);
  assert.equal(pickEpicWorktree(list, 2), '/w/epic-2');
  assert.equal(pickEpicWorktree(list, 20), '/w/epic-20');
  assert.equal(pickEpicWorktree(list, 7), undefined);
});

test('pickEpicWorktree returns undefined when two worktrees claim the same Epic', () => {
  const list = [{path: '/a', branch: 'epic/3-x'}, {path: '/b', branch: 'epic/3-y'}];
  assert.equal(pickEpicWorktree(list, 3), undefined);
});
