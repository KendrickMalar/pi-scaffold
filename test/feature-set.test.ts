import test from 'node:test';
import assert from 'node:assert/strict';
import {readFeatureSet} from '../src/ports/feature-set.js';
import {PiGhBridge} from '../src/ports/pi-gh.js';
import {renderEpicBlock, renderFeatureBlock} from '../src/core/epic-render.js';
import {LIMITS, type FeatureDocV1} from '../src/core/contracts.js';
import {FakePiGh, type FakeIssue} from './helpers/fake-pi-gh.js';
import {makeScope} from './helpers/scope.js';
import {initialDoc, featureDoc, WORKFLOW_ID} from './helpers/docs.js';

function feature(number: number, key: string, patch: Partial<FeatureDocV1> = {}, extra: Partial<FakeIssue> = {}): FakeIssue {
  const doc = {...featureDoc(), featureKey: key, ...patch};
  return {number, title: `Feature ${key}`, body: renderFeatureBlock(doc), labels: ['Type: Scaffold', 'Scope: Feature', 'Stage: BasicDesign'], state: 'open', ...extra};
}
function world(children: FakeIssue[]) {
  const gh = new FakePiGh();
  gh.add({number: 10, title: 'Epic', body: renderEpicBlock(initialDoc()), labels: ['Type: Scaffold', 'Scope: Epic'], state: 'open', subIssues: children.map(c => c.number)});
  for (const c of children) gh.add(c);
  return {gh, bridge: new PiGhBridge(gh.execute)};
}
const read = (bridge: PiGhBridge, extra: object = {}) => readFeatureSet('example/demo', 10, bridge, makeScope(), {workflowId: WORKFLOW_ID, ...extra});

test('native children are the feature set, including closed ones', async () => {
  const {bridge} = world([feature(11, 'F001'), feature(12, 'F002', {}, {state: 'closed'})]);
  const r = await read(bridge);
  assert.ok(r.ok, JSON.stringify(r.ok ? [] : r.problems));
  assert.deepEqual(r.value.features.map(f => [f.number, f.state]), [[11, 'open'], [12, 'closed']]);
  assert.deepEqual(r.value.unattached, []);
});

test('more than 50 children blocks without reading them', async () => {
  const children = Array.from({length: LIMITS.features + 1}, (_, i) => feature(100 + i, `F${String(i + 1).padStart(3, '0')}`));
  const {gh, bridge} = world(children);
  const r = await read(bridge);
  assert.ok(!r.ok && r.problems.some(p => p.code === 'LIMIT_EXCEEDED'));
  assert.equal(gh.count('gh_issue_get'), 0);
  const ok = world(children.slice(0, LIMITS.features));
  assert.equal((await read(ok.bridge)).ok, true);
});

test('an incomplete child listing blocks', async () => {
  const {gh, bridge} = world([feature(11, 'F001')]);
  gh.overrides.set('gh_subissues_list', () => FakePiGh.err('rejected', 'GITHUB_LIMIT'));
  const r = await read(bridge);
  assert.ok(!r.ok && r.problems.some(p => p.code === 'FEATURE_SET_INCOMPLETE'));
});

test('children from another workflow/parent, other kinds or wrong labels block', async () => {
  for (const child of [
    feature(11, 'F001', {workflowId: '44444444-4444-4444-8444-444444444444'}),
    feature(11, 'F001', {parentEpic: 99}),
    feature(11, 'F001', {}, {labels: ['Type: Scaffold', 'Scope: Task']}),
    feature(11, 'F001', {}, {labels: ['Type: Jig', 'Scope: Feature']}),
    {number: 11, title: 'plain', body: 'no managed block', labels: [], state: 'open' as const},
    {number: 11, title: 'epic', body: renderEpicBlock(initialDoc()), labels: ['Type: Scaffold', 'Scope: Feature'], state: 'open' as const},
  ]) {
    const r = await read(world([child]).bridge);
    assert.equal(r.ok, false, child.title + JSON.stringify(child.labels));
  }
});

test('duplicate feature keys block', async () => {
  const r = await read(world([feature(11, 'F001'), feature(12, 'F001')]).bridge);
  assert.ok(!r.ok && r.problems.some(p => p.code === 'DUPLICATE_ID'));
});

test('journal-known created Issues that are not attached yet are matched by createOperationId', async () => {
  const pending = feature(13, 'F003', {createOperationId: '55555555-5555-4555-8555-555555555555'});
  const {gh, bridge} = world([feature(11, 'F001')]);
  gh.add(pending);
  const r = await read(bridge, {knownCreated: [{number: 13, createOperationId: '55555555-5555-4555-8555-555555555555'}]});
  assert.ok(r.ok);
  assert.deepEqual(r.value.unattached.map(f => f.number), [13]);
  const wrong = await read(bridge, {knownCreated: [{number: 13, createOperationId: '66666666-6666-4666-8666-666666666666'}]});
  assert.ok(!wrong.ok && wrong.problems.some(p => p.code === 'CREATE_OPERATION_MISMATCH'));
});

test('feature set digest depends only on membership', async () => {
  const a = await read(world([feature(11, 'F001'), feature(12, 'F002')]).bridge);
  const b = await read(world([feature(12, 'F002', {}, {labels: ['Type: Scaffold', 'Scope: Feature', 'Wave: 3']}), feature(11, 'F001')]).bridge);
  const c = await read(world([feature(11, 'F001')]).bridge);
  assert.ok(a.ok && b.ok && c.ok);
  assert.equal(a.value.featureSetDigest, b.value.featureSetDigest);
  assert.notEqual(a.value.featureSetDigest, c.value.featureSetDigest);
});

test('a sub-issue from another repository is never mistaken for a local Issue', async () => {
  const {gh, bridge} = world([feature(11, 'F001')]);
  gh.overrides.set('gh_subissues_list', () => FakePiGh.ok([{...gh.github(gh.issues.get(11)!), html_url: 'https://github.com/example/other/issues/11', repository_url: 'https://api.github.com/repos/example/other'}]));
  const r = await read(bridge);
  assert.ok(!r.ok && r.problems.some(p => p.code === 'FOREIGN_CHILD'));
});
