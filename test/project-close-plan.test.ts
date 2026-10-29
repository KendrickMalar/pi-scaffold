import test from 'node:test';
import assert from 'node:assert/strict';
import {planProjectClose} from '../src/core/project-close-plan.js';
import type {TreeIssue} from '../src/ports/epic-tree.js';

const REPO = 'example/demo';
const tree: TreeIssue[] = [{number: 10, state: 'closed', parent: null}, {number: 11, state: 'closed', parent: 10}, {number: 13, state: 'closed', parent: 11}];
const issue = (number: number, repo = REPO) => ({id: `PVTI_${number}`, content: {__typename: 'Issue', id: `I_${number}`, number, state: 'CLOSED', repository: {nameWithOwner: repo}}});

test('no projectIds gives a not-recorded skip', () => {
  for (const ids of [undefined, []]) assert.deepEqual(planProjectClose(ids, tree, REPO, []), {close: [], alreadyClosed: [], skipped: [{projectId: null, reason: 'not-recorded'}]});
});
test('only tree issues of the repo gives close', () => {
  assert.deepEqual(planProjectClose(['PVT_a'], tree, REPO, [{projectId: 'PVT_a', closed: false, repositories: [REPO], items: [issue(10), issue(11, 'Example/Demo'), issue(13)]}]), {close: ['PVT_a'], alreadyClosed: [], skipped: []});
});
test('an issue outside the tree makes the Project foreign', () => {
  assert.deepEqual(planProjectClose(['PVT_a'], tree, REPO, [{projectId: 'PVT_a', closed: false, repositories: [REPO], items: [issue(11), issue(99)]}]), {close: [], alreadyClosed: [], skipped: [{projectId: 'PVT_a', reason: 'foreign-items'}]});
});
test('a pull request or draft item makes the Project foreign', () => {
  for (const extra of [{id: 'PVTI_pr', content: {__typename: 'PullRequest', number: 11, repository: {nameWithOwner: REPO}}}, {id: 'PVTI_d', content: {__typename: 'DraftIssue', title: 'x'}}, {id: 'PVTI_n', content: null}])
    assert.deepEqual(planProjectClose(['PVT_a'], tree, REPO, [{projectId: 'PVT_a', closed: false, repositories: [REPO], items: [issue(11), extra]}]).skipped, [{projectId: 'PVT_a', reason: 'foreign-items'}]);
});
test('an issue of another repo makes the Project foreign', () => {
  assert.deepEqual(planProjectClose(['PVT_a'], tree, REPO, [{projectId: 'PVT_a', closed: false, repositories: [REPO], items: [issue(11, 'other/repo')]}]).skipped, [{projectId: 'PVT_a', reason: 'foreign-items'}]);
});
test('a closed Project goes to alreadyClosed', () => {
  assert.deepEqual(planProjectClose(['PVT_a', 'PVT_b'], tree, REPO, [{projectId: 'PVT_b', closed: false, repositories: [REPO], items: [issue(10)]}, {projectId: 'PVT_a', closed: true, repositories: [REPO], items: [issue(99)]}]), {close: ['PVT_b'], alreadyClosed: ['PVT_a'], skipped: []});
});
test('a Project not linked to the repo is skipped as not-linked', () => {
  assert.deepEqual(planProjectClose(['PVT_a'], tree, REPO, [{projectId: 'PVT_a', closed: false, repositories: ['other/repo'], items: [issue(10)]}]), {close: [], alreadyClosed: [], skipped: [{projectId: 'PVT_a', reason: 'not-linked'}]});
  assert.deepEqual(planProjectClose(['PVT_a'], tree, REPO, [{projectId: 'PVT_a', closed: false, repositories: [], items: [issue(10), issue(99)]}]).skipped, [{projectId: 'PVT_a', reason: 'not-linked'}]);
  assert.deepEqual(planProjectClose(['PVT_a'], tree, REPO, [{projectId: 'PVT_a', closed: false, repositories: ['Example/Demo'], items: [issue(10)]}]).close, ['PVT_a']);
  assert.deepEqual(planProjectClose(['PVT_a'], tree, REPO, [{projectId: 'PVT_a', closed: true, repositories: [], items: [issue(10)]}]).alreadyClosed, ['PVT_a']);
});
