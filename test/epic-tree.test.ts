import test from 'node:test';
import assert from 'node:assert/strict';
import {readEpicTree} from '../src/ports/epic-tree.js';
import {PiGhBridge} from '../src/ports/pi-gh.js';
import {FakePiGh, type FakeIssue} from './helpers/fake-pi-gh.js';
import {makeScope} from './helpers/scope.js';

const issue = (number: number, extra: Partial<FakeIssue> = {}): FakeIssue => ({number, title: `Issue ${number}`, body: '', labels: [], state: 'open', ...extra});

test('reads the Epic, its Features and their Tasks with state', async () => {
  const gh = new FakePiGh();
  gh.add(issue(10, {subIssues: [11, 12]})).add(issue(11, {subIssues: [13, 14], state: 'closed'})).add(issue(12)).add(issue(13, {state: 'closed'})).add(issue(14));
  const r = await readEpicTree('example/demo', 10, new PiGhBridge(gh.execute), makeScope());
  assert.ok(r.ok, JSON.stringify(r.ok ? [] : r.problems));
  assert.deepEqual(r.value, [
    {number: 10, state: 'open', parent: null},
    {number: 11, state: 'closed', parent: 10}, {number: 13, state: 'closed', parent: 11}, {number: 14, state: 'open', parent: 11},
    {number: 12, state: 'open', parent: 10},
  ]);
});

test('a sub-issue of another repository is ignored: not traversed, not counted', async () => {
  const gh = new FakePiGh();
  gh.add(issue(10, {subIssues: [11]})).add(issue(11, {state: 'closed'})).add(issue(5));
  gh.overrides.set('gh_subissues_list', args => (args as {issue: number}).issue === 11 ? FakePiGh.ok([{number: 5, state: 'open', html_url: 'https://github.com/other/repo/issues/5'}]) : undefined);
  const r = await readEpicTree('example/demo', 10, new PiGhBridge(gh.execute), makeScope());
  assert.ok(r.ok, JSON.stringify(r.ok ? [] : r.problems));
  assert.deepEqual(r.value, [{number: 10, state: 'open', parent: null}, {number: 11, state: 'closed', parent: 10}]);
  assert.equal(gh.calls.filter(c => c.name === 'gh_subissues_list' && (c.args as {issue: number}).issue === 5).length, 0, 'a foreign child is not traversed');
});

test('an Epic without Features returns only itself', async () => {
  const gh = new FakePiGh();
  gh.add(issue(10));
  const r = await readEpicTree('example/demo', 10, new PiGhBridge(gh.execute), makeScope());
  assert.ok(r.ok);
  assert.deepEqual(r.value, [{number: 10, state: 'open', parent: null}]);
});
