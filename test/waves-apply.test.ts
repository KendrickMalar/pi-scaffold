import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHarness, loadToolModule, type Scenario} from './helpers/harness.js';
import {FakePiGh} from './helpers/fake-pi-gh.js';
import {renderEpicBlock, renderFeatureBlock} from '../src/core/epic-render.js';
import {parseIssueBody} from '../src/core/body-codec.js';
import {sha256Text, taggedDigest, wavePlanDigest} from '../src/core/digests.js';
import {labelDefinitions} from '../src/core/label-definitions.js';
import {canonicalWavePlan} from '../src/core/wave-plan.js';
import type {EpicDocV1, FeatureDocV1, WavePlan} from '../src/core/contracts.js';
import {populatedDoc, featureDoc} from './helpers/docs.js';

const OP = '12121212-1212-4121-8121-121212121212';
const ISSUES = [11, 12, 13, 14];
const KEY = (n: number) => `F${String(n - 10).padStart(3, '0')}`;
const SCOPE = (n: number) => [`src/f${n}/`];
const dependencyPlan = {version: 1 as const, nodes: ISSUES.map(n => ({featureKey: KEY(n), issue: n, contracts: [], startConditions: [], editScope: SCOPE(n)})), edges: [{from: 11, to: 13, reason: '架空'}]};
const featureSetDigest = taggedDigest('feature-set', ISSUES.map(n => ({issue: n, featureKey: KEY(n)})));
const dependencyDigest = taggedDigest('dependency-plan', dependencyPlan);
const plan = (waves: Record<number, unknown>, over: Partial<WavePlan> = {}): WavePlan => ({version: 1, assignments: Object.entries(waves).map(([i, w]) => ({issue: Number(i), wave: w as number})), dependencyDigest, featureSetDigest, ...over});
const TARGET = {11: 1, 12: 2, 13: 2, 14: 1};
const FEATURE_BASE = ['Type: Scaffold', 'Scope: Feature', 'Stage: BasicDesign'];

function world(opts: {labels?: Record<number, string[]>; savedPlan?: WavePlan | null; epicLabels?: string[]; extraLabels?: Record<number, string[]>; withoutWaveDefs?: boolean} = {}) {
  const defs = labelDefinitions().filter(d => !(opts.withoutWaveDefs && /^Wave: (2|3)$/.test(d.name)));
  const gh = new FakePiGh().seedLabels(defs).enableProposals();
  const epic: EpicDocV1 = {...populatedDoc(), stage: 'basic-design', dependencyPlan, wavePlan: opts.savedPlan ?? null, handoff: null};
  gh.add({number: 10, title: 'Epic', body: '外のメモ\n\n' + renderEpicBlock(epic), labels: opts.epicLabels ?? ['Type: Scaffold', 'Scope: Epic', 'Stage: BasicDesign'], state: 'open', subIssues: [...ISSUES]});
  for (const n of ISSUES) {
    const f: FeatureDocV1 = {...featureDoc(), workflowId: epic.workflowId, featureKey: KEY(n), parentEpic: 10, editScope: SCOPE(n), createOperationId: `eeeeeeee-eeee-4eee-8eee-${String(n).padStart(12, '0')}`};
    gh.add({number: n, title: `F${n}`, body: renderFeatureBlock(f), labels: [...(opts.labels?.[n] ?? FEATURE_BASE), ...(opts.extraLabels?.[n] ?? [])], state: 'open'});
  }
  gh.issues.get(13)!.blockedBy = [11];
  return gh;
}
const epicDoc = (gh: FakePiGh) => (parseIssueBody(gh.issues.get(10)!.body) as {ok: true; value: {doc: EpicDocV1}}).value.doc;
const params = (gh: FakePiGh, p: unknown = plan(TARGET), extra: Record<string, unknown> = {}) => ({
  repo: 'example/demo', epicIssue: 10, operationId: OP, expectedRevision: epicDoc(gh).revision, expectedBodySha256: sha256Text(gh.issues.get(10)!.body), plan: p, ...extra,
});
async function harness(t: {after(fn: () => Promise<void>): void}, gh: FakePiGh, scenario: Scenario = {}) {
  const {createTool} = await loadToolModule('extensions/tools/waves-apply.ts');
  const h = await createHarness(createTool, {scenario: {gh, defaultParams: scenario.defaultParams ?? params(gh), ...scenario}});
  t.after(h.dispose);
  return h;
}
type Data = {appliedIssues: number[]; unchangedIssues: number[]; pendingIssues: number[]; wavePlanDigest: string};
const labelEdits = (gh: FakePiGh) => gh.calls.filter(c => c.name === 'gh_issue_labels_if_current');
const labelCreates = (gh: FakePiGh) => gh.calls.filter(c => c.name === 'gh_labels_apply' || c.name === 'gh_label_create');
const noChange = (gh: FakePiGh, epicBefore: string) => { assert.equal(labelEdits(gh).length, 0); assert.equal(labelCreates(gh).length, 0); assert.equal(gh.issues.get(10)!.body, epicBefore); };
const waveOf = (gh: FakePiGh, n: number) => gh.issues.get(n)!.labels.filter(l => l.startsWith('Wave'));

// ---- rejected before the first change ------------------------------------------------------------

for (const [label, waves] of [
  ['wave 0', {...TARGET, 11: 0}], ['wave 201', {...TARGET, 11: 201}], ['wave 1.5', {...TARGET, 11: 1.5}], ['wave "1"', {...TARGET, 11: '1'}],
  ['a missing Feature', {11: 1, 12: 2, 13: 2}],
] as const) {
  test(`a plan with ${label} is blocked with zero label/Epic changes`, async t => {
    const gh = world(); const before = gh.issues.get(10)!.body;
    const out = await (await harness(t, gh)).invoke(params(gh, plan(waves as Record<number, unknown>)));
    assert.equal(out.r.status, 'blocked', JSON.stringify(out.r));
    noChange(gh, before);
  });
}

test('the same Feature twice is blocked', async t => {
  const gh = world(); const before = gh.issues.get(10)!.body;
  const p = plan(TARGET); p.assignments.push({issue: 11, wave: 3});
  const out = await (await harness(t, gh)).invoke(params(gh, p));
  assert.equal(out.r.status, 'blocked'); noChange(gh, before);
});

for (const [label, over] of [['featureSetDigest', {featureSetDigest: 'e'.repeat(64)}], ['dependencyDigest', {dependencyDigest: 'e'.repeat(64)}]] as const) {
  test(`a stale ${label} is blocked`, async t => {
    const gh = world(); const before = gh.issues.get(10)!.body;
    const out = await (await harness(t, gh)).invoke(params(gh, plan(TARGET, over)));
    assert.equal(out.r.status, 'blocked'); noChange(gh, before);
  });
}

test('a validator conflict (dependent pair in one Wave) is blocked', async t => {
  const gh = world(); const before = gh.issues.get(10)!.body;
  const out = await (await harness(t, gh)).invoke(params(gh, plan({...TARGET, 13: 1})));
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(p => p.code === 'DEPENDENCY_ORDER'), JSON.stringify(out.r.problems));
  noChange(gh, before);
});

for (const [label, extra, code] of [
  ['two Wave labels', ['Wave: 1', 'Wave: 2'], 'DUPLICATE_MANAGED_LABEL'],
  ['an old-style Wave label', ['wave:1'], 'NONCANONICAL_LABEL'],
] as const) {
  test(`a Feature with ${label} is blocked, never cleaned up automatically`, async t => {
    const gh = world({extraLabels: {12: [...extra]}}); const before = gh.issues.get(10)!.body;
    const out = await (await harness(t, gh)).invoke();
    assert.equal(out.r.status, 'blocked');
    assert.ok(out.r.problems.some(p => p.code === code), JSON.stringify(out.r.problems));
    noChange(gh, before);
  });
}

test('a Type: Jig child or a child of another Epic is blocked', async t => {
  const gh = world({labels: {12: ['Type: Jig', 'Scope: Feature', 'Stage: BasicDesign']}}); const before = gh.issues.get(10)!.body;
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'blocked'); noChange(gh, before);
});

test('stage, Blocked and a stale Epic body are blocked', async t => {
  for (const g of [world({epicLabels: ['Type: Scaffold', 'Scope: Epic', 'Stage: BasicDesign', 'Blocked']})]) {
    const before = g.issues.get(10)!.body;
    assert.equal((await (await harness(t, g)).invoke(params(g))).r.status, 'blocked'); noChange(g, before);
  }
  const s = world(); const before = s.issues.get(10)!.body;
  assert.equal((await (await harness(t, s)).invoke(params(s, undefined, {expectedBodySha256: 'f'.repeat(64)}))).r.status, 'blocked'); noChange(s, before);
});

// ---- applying ---------------------------------------------------------------------------------------

test('Wave: 1 → Wave: 2 changes only the Wave label; other labels are kept', async t => {
  const gh = world({labels: {11: [...FEATURE_BASE, 'Wave: 1'], 12: [...FEATURE_BASE, 'Wave: 1', 'Blocked', 'needs-ux'], 13: [...FEATURE_BASE, 'Wave: 2'], 14: [...FEATURE_BASE, 'Wave: 1']}});
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  const edits = labelEdits(gh).map(c => JSON.parse(readFileSync((c.args as {changePath: string}).changePath, 'utf8')));
  assert.equal(edits.length, 1);
  assert.deepEqual([edits[0].issue, edits[0].add, edits[0].remove], [12, ['Wave: 2'], ['Wave: 1']]);
  assert.deepEqual(gh.issues.get(12)!.labels.slice().sort(), [...FEATURE_BASE, 'Blocked', 'Wave: 2', 'needs-ux'].sort());
  const data = out.r.data as Data;
  assert.deepEqual(data.appliedIssues, [12]); assert.deepEqual(data.unchangedIssues, [11, 13, 14]); assert.deepEqual(data.pendingIssues, []);
});

test('labels are applied, the plan is saved in canonical order to the Epic, and the result is verified', async t => {
  const gh = world();
  const reversed = plan(TARGET); reversed.assignments.reverse();
  const out = await (await harness(t, gh)).invoke(params(gh, reversed));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  for (const n of ISSUES) assert.deepEqual(waveOf(gh, n), [`Wave: ${TARGET[n as 11]}`]);
  const doc = epicDoc(gh);
  assert.deepEqual(doc.wavePlan, canonicalWavePlan(plan(TARGET)));
  assert.ok(gh.issues.get(10)!.body.startsWith('外のメモ\n\n'));
  assert.equal((out.r.data as Data).wavePlanDigest, wavePlanDigest(doc));
  assert.ok(gh.count('gh_dependencies_list') >= ISSUES.length, 'the final #13 check read the dependencies');
});

test('missing Wave label definitions are created within the managed range only', async t => {
  const gh = world({withoutWaveDefs: true});
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.ok(gh.labels.has('wave: 2'));
  assert.ok(!gh.labels.has('wave: 3'), 'only the Waves the plan uses are created');
});

test('the same plan again writes nothing', async t => {
  const gh = world();
  const h = await harness(t, gh);
  assert.equal((await h.invoke()).r.status, 'applied');
  const again = await h.invoke();
  assert.equal(again.r.status, 'noop'); assert.equal(again.ghWrites, 0);
  const fresh = await h.invoke(params(gh, plan(TARGET), {operationId: '13131313-1313-4131-8131-131313131313'}));
  assert.equal(fresh.r.status, 'noop', JSON.stringify(fresh.r)); assert.equal(fresh.ghWrites, 0);
});

test('an unknown 3rd label change stops the 4th; resume reconciles without re-applying the first two', async t => {
  const gh = world();
  const real = gh.execute;
  let n = 0;
  gh.overrides.set('gh_issue_labels_if_current', args => {
    if (++n !== 3) return undefined;
    gh.overrides.delete('gh_issue_labels_if_current');
    return real('gh_issue_labels_if_current', args).then(() => ({result: {content: [], structuredContent: {status: 'unknown'}}, isError: true}));
  });
  const h = await harness(t, gh);
  const first = await h.invoke();
  assert.equal(first.r.status, 'unknown', JSON.stringify(first.r));
  assert.deepEqual(waveOf(gh, 14), [], 'no change for the 4th Feature');
  assert.equal(epicDoc(gh).wavePlan, null);
  const editsBefore = labelEdits(gh).length;
  const resumed = await h.invoke();
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.equal(labelEdits(gh).length, editsBefore + 1, 'only the 4th Feature is changed on resume');
});

test('labels all match but the Epic save fails: partial, never applied', async t => {
  const gh = world();
  gh.overrides.set('gh_issue_edit_if_current', () => FakePiGh.err('rejected', 'PRECONDITION_FAILED'));
  const out = await (await harness(t, gh)).invoke();
  assert.notEqual(out.r.status, 'applied');
  assert.equal(out.r.status, 'partial', JSON.stringify(out.r));
  for (const n of ISSUES) assert.deepEqual(waveOf(gh, n), [`Wave: ${TARGET[n as 11]}`]);
});

test('a concurrent label change on a Feature stops the operation (no write over it)', async t => {
  const gh = world();
  let done = false;
  gh.onCall = name => { if (name === 'gh_issue_labels_if_current' && !done) { done = true; gh.issues.get(14)!.labels.push('needs-review'); } };
  const out = await (await harness(t, gh)).invoke();
  assert.notEqual(out.r.status, 'applied');
  assert.ok(!gh.issues.get(14)!.labels.some(l => l.startsWith('Wave')), 'the concurrently changed Feature is not overwritten');
  assert.equal(epicDoc(gh).wavePlan, null);
});

test('labels alone never mean "implementation may start" (the tool reports only Wave application)', async t => {
  const gh = world();
  const out = await (await harness(t, gh)).invoke();
  assert.deepEqual(Object.keys(out.r.data as object).sort(), ['appliedIssues', 'pendingIssues', 'unchangedIssues', 'wavePlanDigest']);
  assert.equal(epicDoc(gh).stage, 'basic-design');
});

// ---- guards proven one by one ---------------------------------------------------------------------

test('a Feature whose labels would need a non-Wave change (missing Stage label) is blocked, not "fixed"', async t => {
  const gh = world({labels: {12: ['Type: Scaffold', 'Scope: Feature']}}); const before = gh.issues.get(10)!.body;
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(p => p.code === 'UNEXPECTED_LABEL_CHANGE'), JSON.stringify(out.r.problems));
  noChange(gh, before);
});

test('a label change reported as applied but not visible is caught by the read-back (pending listed, Epic not saved)', async t => {
  const gh = world();
  gh.overrides.set('gh_issue_labels_if_current', args => {
    const c = JSON.parse(readFileSync((args as {changePath: string}).changePath, 'utf8'));
    return c.issue === 12 ? FakePiGh.ok({issue: 12}, 'applied') : undefined;
  });
  const out = await (await harness(t, gh)).invoke();
  assert.notEqual(out.r.status, 'applied');
  assert.ok(out.r.problems.some(p => p.code === 'LABELS_NOT_SYNCED'), JSON.stringify(out.r.problems));
  assert.deepEqual((out.r.data as Data).pendingIssues, [12]);
  assert.equal(epicDoc(gh).wavePlan, null);
});

test('a dependency appearing after the Epic save fails the final check: never applied', async t => {
  const gh = world();
  let done = false;
  gh.onCall = name => { if (name === 'gh_issue_edit_if_current' && !done) { done = true; gh.issues.get(14)!.blockedBy = [12]; } };
  const out = await (await harness(t, gh)).invoke();
  assert.notEqual(out.r.status, 'applied', JSON.stringify(out.r));
  assert.ok(out.r.problems.some(p => p.code === 'VERIFY_NOT_PASSED'), JSON.stringify(out.r.problems));
});

test('another Wave plan saved meanwhile is not overwritten', async t => {
  const gh = world();
  let done = false;
  const other = plan({11: 1, 12: 3, 13: 2, 14: 1});
  gh.onCall = name => {
    if (name === 'gh_issue_labels_if_current' && !done) { done = true; gh.issues.get(10)!.body = '外のメモ\n\n' + renderEpicBlock({...epicDoc(gh), wavePlan: other}); }
  };
  const out = await (await harness(t, gh)).invoke();
  assert.notEqual(out.r.status, 'applied');
  assert.ok(out.r.problems.some(p => p.code === 'PLAN_CHANGED'), JSON.stringify(out.r.problems));
  assert.deepEqual(epicDoc(gh).wavePlan, other);
});

// ---- review follow-ups --------------------------------------------------------------------------

for (const bad of ['Wave 1', 'Waves-2', 'WAVE:1']) {
  test(`a malformed Wave label "${bad}" is blocked before any change`, async t => {
    const gh = world({extraLabels: {12: [bad]}}); const before = gh.issues.get(10)!.body;
    const out = await (await harness(t, gh)).invoke();
    assert.equal(out.r.status, 'blocked', JSON.stringify(out.r));
    noChange(gh, before);
  });
}

test('an unrelated label that merely starts with "Wave" (Waveform) is left alone and does not block', async t => {
  const gh = world({extraLabels: {12: ['Waveform']}});
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.ok(gh.issues.get(12)!.labels.includes('Waveform'));
  assert.ok(gh.issues.get(12)!.labels.includes('Wave: 2'));
});

test('a concurrent Epic body edit (even outside the managed block) stops the save', async t => {
  const gh = world();
  let done = false;
  gh.onCall = name => { if (name === 'gh_issue_labels_if_current' && !done) { done = true; gh.issues.get(10)!.body += '\n別セッションの追記'; } };
  const out = await (await harness(t, gh)).invoke();
  assert.notEqual(out.r.status, 'applied');
  assert.ok(out.r.problems.some(p => p.code === 'EPIC_MOVED'), JSON.stringify(out.r.problems));
  assert.equal(epicDoc(gh).wavePlan, null);
});
