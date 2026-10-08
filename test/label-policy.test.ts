import test from 'node:test';
import assert from 'node:assert/strict';
import {planManagedLabelDelta, prepareLabelEdit, waveLabelName, stageLabelName, FIXED_LABEL_NAMES, type LabelTarget} from '../src/core/label-policy.js';
import {buildSnapshot, type RawIssue} from '../src/core/body-codec.js';
import {renderEpicBlock} from '../src/core/epic-render.js';
import type {IssueSnapshot, Stage} from '../src/core/contracts.js';
import {initialDoc} from './helpers/docs.js';

function snapshot(labels: string[], stage: Stage = 'setup'): IssueSnapshot {
  const doc = initialDoc(); doc.stage = stage;
  const raw: RawIssue = {repo: 'example/demo', number: 10, title: 't', body: renderEpicBlock(doc), labels, state: 'open'};
  const s = buildSnapshot(raw); assert.ok(s.ok); return s.value;
}
const epic = (stage: LabelTarget['stage'], extra: Partial<LabelTarget> = {}): LabelTarget => ({type: 'Scaffold', scope: 'Epic', stage, ...extra});
const codes = (r: {problems: {code: string}[]}) => r.problems.map(p => p.code);

test('canonical fixed names are shared with #1/#3', () => {
  assert.deepEqual(FIXED_LABEL_NAMES, ['Type: Scaffold', 'Type: Jig', 'Scope: Epic', 'Scope: Feature', 'Scope: Task', 'Stage: Specification', 'Stage: BasicDesign', 'Stage: Implementation', 'Stage: Verification', 'Stage: Completed', 'Blocked']);
  assert.equal(stageLabelName('setup'), undefined);
  assert.equal(stageLabelName('basic-design'), 'Stage: BasicDesign');
});

test('setup adds Type and Scope but no Stage', () => {
  const r = planManagedLabelDelta(snapshot([]), epic('setup'));
  assert.deepEqual(r, {add: ['Type: Scaffold', 'Scope: Epic'], remove: [], problems: []});
});

test('stage transition replaces exactly one old Stage and keeps unrelated labels', () => {
  const r = planManagedLabelDelta(snapshot(['Type: Scaffold', 'Scope: Epic', 'Stage: Specification', 'Wave: 3', 'bug'], 'basic-design'), epic('basic-design'));
  assert.deepEqual(r, {add: ['Stage: BasicDesign'], remove: ['Stage: Specification'], problems: []});
  const fromSetup = planManagedLabelDelta(snapshot(['Type: Scaffold', 'Scope: Epic'], 'setup'), epic('specification'));
  assert.deepEqual(fromSetup, {add: ['Stage: Specification'], remove: [], problems: []});
});

test('already-correct labels produce an empty delta', () => {
  const r = planManagedLabelDelta(snapshot(['Type: Scaffold', 'Scope: Epic', 'Stage: Specification'], 'specification'), epic('specification'));
  assert.deepEqual(r, {add: [], remove: [], problems: []});
});

test('duplicate Type/Scope/Stage/Wave labels block', () => {
  for (const labels of [
    ['Type: Scaffold', 'Type: Jig', 'Scope: Epic'],
    ['Type: Scaffold', 'Scope: Epic', 'Scope: Feature'],
    ['Type: Scaffold', 'Scope: Epic', 'Stage: Specification', 'Stage: BasicDesign'],
    ['Type: Scaffold', 'Scope: Epic', 'Wave: 1', 'Wave: 2'],
  ]) {
    const r = planManagedLabelDelta(snapshot(labels, 'specification'), epic('specification'));
    assert.ok(codes(r).includes('DUPLICATE_MANAGED_LABEL'), labels.join());
    assert.deepEqual([r.add, r.remove], [[], []]);
  }
});

test('non-canonical spellings block instead of being normalized', () => {
  for (const label of ['stage: specification', 'Wave:1', 'wave: 1', 'Type: scaffold', 'blocked', 'Wave: 01']) {
    const r = planManagedLabelDelta(snapshot(['Type: Scaffold', 'Scope: Epic', label], 'specification'), epic('specification'));
    assert.ok(codes(r).includes('NONCANONICAL_LABEL'), label);
  }
});

test('Type: Jig is never changed automatically', () => {
  const r = planManagedLabelDelta(snapshot(['Type: Jig', 'Scope: Epic']), epic('setup'));
  assert.ok(codes(r).includes('TYPE_CONFLICT'));
  assert.deepEqual([r.add, r.remove], [[], []]);
  const jig = planManagedLabelDelta(snapshot([]), {...epic('setup'), type: 'Jig'});
  assert.ok(codes(jig).includes('TYPE_NOT_ALLOWED'));
});

test('Blocked is preserved and stops stage progress', () => {
  const r = planManagedLabelDelta(snapshot(['Type: Scaffold', 'Scope: Epic', 'Stage: Specification', 'Blocked'], 'specification'), epic('basic-design'));
  assert.ok(codes(r).includes('BLOCKED'));
  assert.deepEqual([r.add, r.remove], [[], []]);
  const keep = planManagedLabelDelta(snapshot(['Type: Scaffold', 'Scope: Epic', 'Stage: Specification', 'Blocked'], 'specification'), epic('specification'));
  assert.deepEqual(keep, {add: [], remove: [], problems: []});
  const explicitRelease = planManagedLabelDelta(snapshot(['Type: Scaffold', 'Scope: Epic', 'Stage: Specification', 'Blocked'], 'specification'), epic('specification', {blocked: false}));
  assert.deepEqual(explicitRelease, {add: [], remove: ['Blocked'], problems: []});
  const releaseWithTransition = planManagedLabelDelta(snapshot(['Type: Scaffold', 'Scope: Epic', 'Stage: Specification', 'Blocked'], 'specification'), epic('basic-design', {blocked: false}));
  assert.ok(codes(releaseWithTransition).includes('BLOCKED_RELEASE_WITH_TRANSITION'));
});

test('Wave 1 and 200 are allowed; 0, 201, 1.5 and strings are rejected', () => {
  assert.equal(waveLabelName(1), 'Wave: 1');
  assert.equal(waveLabelName(200), 'Wave: 200');
  for (const wave of [0, 201, 1.5, '1', NaN]) assert.throws(() => waveLabelName(wave as number), /wave/i, String(wave));
  const base = ['Type: Scaffold', 'Scope: Epic', 'Stage: BasicDesign', 'Wave: 1'];
  const r = planManagedLabelDelta(snapshot(base, 'basic-design'), epic('basic-design', {wave: 200}));
  assert.deepEqual(r, {add: ['Wave: 200'], remove: ['Wave: 1'], problems: []});
  for (const wave of [0, 201]) assert.ok(codes(planManagedLabelDelta(snapshot(base, 'basic-design'), epic('basic-design', {wave}))).includes('INVALID_WAVE'));
});

test('scope and stage must agree with the managed body', () => {
  assert.ok(codes(planManagedLabelDelta(snapshot([]), {type: 'Scaffold', scope: 'Feature', stage: 'setup'})).includes('BODY_MISMATCH'));
  assert.ok(codes(planManagedLabelDelta(snapshot(['Type: Scaffold', 'Scope: Epic', 'Stage: Implementation'], 'specification'), epic('basic-design'))).includes('BODY_MISMATCH'));
  assert.ok(codes(planManagedLabelDelta(snapshot(['Type: Scaffold', 'Scope: Epic', 'Stage: Specification'], 'specification'), epic('setup'))).includes('STAGE_REGRESSION'));
});

test('prepared label edit binds to the label snapshot hash and is withheld on problems', () => {
  const s = snapshot(['Type: Scaffold', 'Scope: Epic'], 'specification');
  const r = prepareLabelEdit(s, epic('specification'));
  assert.ok(r.ok);
  assert.deepEqual(r.value, {version: 1, repo: 'example/demo', operation: 'issue-labels-if-current', issue: 10, add: ['Stage: Specification'], remove: [], expectedLabelsSha256: s.labelsSha256});
  const stale = {...s, labels: [...s.labels, 'Blocked']};
  const r2 = prepareLabelEdit(stale, epic('specification'));
  assert.equal(r2.ok, false);
  assert.ok(!r2.ok && r2.problems.some(p => p.code === 'STALE_SNAPSHOT'));
  const blocked = prepareLabelEdit(snapshot(['Type: Jig']), epic('setup'));
  assert.equal(blocked.ok, false);
});
