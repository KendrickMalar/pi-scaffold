import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness, loadToolModule, type Scenario} from './helpers/harness.js';
import {FakePiGh} from './helpers/fake-pi-gh.js';
import {renderEpicBlock, renderFeatureBlock} from '../src/core/epic-render.js';
import {taggedDigest} from '../src/core/digests.js';
import {labelDefinitions} from '../src/core/label-definitions.js';
import type {EpicDocV1, FeatureDocV1, WavePlan} from '../src/core/contracts.js';
import {populatedDoc, featureDoc} from './helpers/docs.js';
import * as parse from '../src/core/body-codec.js';

const KEYS: Record<number, string> = {11: 'F001', 12: 'F002', 13: 'F003'};
const SCOPES: Record<number, string[]> = {11: ['src/a/'], 12: ['src/b/'], 13: ['src/c/']};
const dependencyPlan = {version: 1 as const, nodes: [11, 12, 13].map(n => ({featureKey: KEYS[n]!, issue: n, contracts: [], startConditions: [], editScope: SCOPES[n]!})), edges: [{from: 11, to: 13, reason: '架空'}]};
const featureSetDigest = taggedDigest('feature-set', [11, 12, 13].map(n => ({issue: n, featureKey: KEYS[n]!})));
const dependencyDigest = taggedDigest('dependency-plan', dependencyPlan);
const plan = (waves: Record<number, number>, over: Partial<WavePlan> = {}): WavePlan => ({version: 1, assignments: Object.entries(waves).map(([i, w]) => ({issue: Number(i), wave: w})), dependencyDigest, featureSetDigest, ...over});
const WAVES = {11: 1, 12: 1, 13: 2};

function world(opts: {saved?: WavePlan | null; labels?: Record<number, string[]>; closed?: number[]; extraChild?: boolean} = {}) {
  const gh = new FakePiGh().seedLabels(labelDefinitions()).enableProposals();
  const epic: EpicDocV1 = {...populatedDoc(), stage: 'basic-design', dependencyPlan, wavePlan: opts.saved === undefined ? plan(WAVES) : opts.saved, handoff: null};
  gh.add({number: 10, title: 'Epic', body: renderEpicBlock(epic), labels: ['Type: Scaffold', 'Scope: Epic', 'Stage: BasicDesign'], state: 'open', subIssues: [11, 12, 13]});
  for (const n of [11, 12, 13]) {
    const f: FeatureDocV1 = {...featureDoc(), workflowId: epic.workflowId, featureKey: KEYS[n]!, parentEpic: 10, editScope: SCOPES[n]!};
    gh.add({number: n, title: `F${n}`, body: renderFeatureBlock(f), labels: ['Type: Scaffold', 'Scope: Feature', 'Stage: BasicDesign', ...(opts.labels?.[n] ?? [`Wave: ${WAVES[n as 11]}`])], state: opts.closed?.includes(n) ? 'closed' : 'open'});
  }
  gh.issues.get(13)!.blockedBy = [11];
  if (opts.extraChild) { gh.add({number: 14, title: 'stray', body: 'no managed block', labels: [], state: 'open'}); gh.issues.get(10)!.subIssues!.push(14); }
  return gh;
}
async function harness(t: {after(fn: () => Promise<void>): void}, gh: FakePiGh, scenario: Scenario = {}) {
  const {createTool} = await loadToolModule('extensions/tools/waves-verify.ts');
  const h = await createHarness(createTool, {scenario: {gh, defaultParams: {repo: 'example/demo', epicIssue: 10}, ...scenario}});
  t.after(h.dispose);
  return h;
}
type Data = {passed: boolean; checks: string[]; featureSetDigest: string; wavePlanDigest: string | null};
const writes = (gh: FakePiGh) => gh.writes;

test('a consistent saved plan, labels and dependencies pass with zero writes', async t => {
  const gh = world();
  const out = await (await harness(t, gh)).invoke();
  const d = out.r.data as Data;
  assert.equal(d.passed, true, JSON.stringify(out.r.problems));
  assert.deepEqual(out.r.problems, []);
  assert.equal(d.featureSetDigest, featureSetDigest);
  assert.equal(writes(gh), 0);
});

test('an input plan is checked instead of the saved one', async t => {
  const gh = world({saved: null});
  const out = await (await harness(t, gh)).invoke({repo: 'example/demo', epicIssue: 10, plan: plan(WAVES)});
  assert.equal((out.r.data as Data).passed, true, JSON.stringify(out.r.problems));
});

for (const [label, labels, code] of [
  ['no Wave label', {11: []}, 'WAVE_LABEL_MISSING'],
  ['two Wave labels', {11: ['Wave: 1', 'Wave: 2']}, 'WAVE_LABEL_MULTIPLE'],
  ['an old-style name', {11: ['wave: 1']}, 'WAVE_LABEL_NONCANONICAL'],
] as const) {
  test(`a Feature with ${label} does not pass`, async t => {
    const gh = world({labels: labels as unknown as Record<number, string[]>});
    const out = await (await harness(t, gh)).invoke();
    assert.equal((out.r.data as Data).passed, false);
    assert.ok(out.r.problems.some(p => p.code === code), JSON.stringify(out.r.problems));
    assert.equal(writes(gh), 0);
  });
}

for (const [label, wave] of [['0', 0], ['201', 201], ['1.5', 1.5], ['"1"', '1']] as const) {
  test(`an input plan with wave ${label} does not pass`, async t => {
    const gh = world();
    const p = plan(WAVES) as unknown as {assignments: {issue: number; wave: unknown}[]};
    p.assignments[0]!.wave = wave;
    const out = await (await harness(t, gh)).invoke({repo: 'example/demo', epicIssue: 10, plan: p});
    assert.equal((out.r.data as Data | undefined)?.passed, false, JSON.stringify(out.r));
    assert.equal(writes(gh), 0);
  });
}

test('no saved plan does not pass', async t => {
  const gh = world({saved: null});
  const out = await (await harness(t, gh)).invoke();
  assert.equal((out.r.data as Data).passed, false); assert.ok(out.r.problems.some(p => p.code === 'PLAN_UNSET'));
});

test('a closed Feature stays in the checked set', async t => {
  const gh = world({closed: [12], saved: plan({11: 1, 13: 2})});
  const out = await (await harness(t, gh)).invoke();
  assert.equal((out.r.data as Data).passed, false);
  assert.ok(out.r.problems.some(p => p.code === 'UNASSIGNED_FEATURE' && p.path.includes('#12')), JSON.stringify(out.r.problems));
});

test('a same-Wave dependency fails and names the edge', async t => {
  const gh = world({saved: plan({11: 1, 12: 1, 13: 1}), labels: {13: ['Wave: 1']}});
  const out = await (await harness(t, gh)).invoke();
  assert.equal((out.r.data as Data).passed, false);
  assert.ok(out.r.problems.some(p => p.code === 'DEPENDENCY_ORDER' && /#11 → #13/.test(p.message)));
});

test('an unexpected child of the Epic does not pass', async t => {
  const gh = world({extraChild: true});
  const out = await (await harness(t, gh)).invoke();
  assert.equal((out.r.data as Data).passed, false);
});

test('GitHub dependencies that differ from the saved dependency plan do not pass', async t => {
  const gh = world(); gh.issues.get(12)!.blockedBy = [11];
  const out = await (await harness(t, gh)).invoke();
  assert.equal((out.r.data as Data).passed, false);
  assert.ok(out.r.problems.some(p => p.code === 'DEPENDENCIES_DIFFER'), JSON.stringify(out.r.problems));
});

for (const [label, change] of [
  ['a label', (gh: FakePiGh) => { gh.issues.get(12)!.labels = gh.issues.get(12)!.labels.filter(l => !l.startsWith('Wave')).concat('Wave: 2'); }],
  ['the Feature set', (gh: FakePiGh) => { gh.issues.get(10)!.subIssues = [11, 12]; }],
  ['a dependency', (gh: FakePiGh) => { gh.issues.get(12)!.blockedBy = [11]; }],
] as const) {
  test(`${label} changing while reading never passes`, async t => {
    const gh = world();
    let reads = 0, changed = false;
    gh.onCall = name => { if (name === 'gh_issue_get' && ++reads === 4 && !changed) { changed = true; change(gh); } };
    const out = await (await harness(t, gh)).invoke();
    assert.equal((out.r.data as Data | undefined)?.passed ?? false, false, JSON.stringify(out.r));
    assert.equal(writes(gh), 0);
  });
}

test('the input never accepts operationId/force; the tool is read-only', async t => {
  const gh = world();
  const h = await harness(t, gh);
  for (const extra of [{operationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff'}, {force: true}]) {
    const out = await h.invoke({repo: 'example/demo', epicIssue: 10, ...extra});
    assert.equal(out.inputSchemaValid, false); assert.equal(out.r.status, 'blocked');
  }
  assert.equal((h.tool as unknown as {annotations: {readOnlyHint: boolean}}).annotations.readOnlyHint, true);
  assert.equal(writes(gh), 0);
});

test('a concurrent, self-consistent update during reading (plan and label move together) still never passes', async t => {
  const gh = world();
  let reads = 0, changed = false;
  gh.onCall = name => {
    if (name !== 'gh_issue_get' || ++reads !== 3 || changed) return;
    changed = true;
    // Like a concurrent scaffold_waves_apply: #12 moves to Wave 2 in both the saved plan and its label.
    const body = gh.issues.get(10)!.body;
    const {parseIssueBody} = parse;
    const doc = (parseIssueBody(body) as {ok: true; value: {doc: EpicDocV1}}).value.doc;
    gh.issues.get(10)!.body = renderEpicBlock({...doc, wavePlan: plan({11: 1, 12: 2, 13: 2})});
    gh.issues.get(12)!.labels = gh.issues.get(12)!.labels.filter(l => !l.startsWith('Wave')).concat('Wave: 2');
  };
  const out = await (await harness(t, gh)).invoke();
  assert.equal((out.r.data as Data | undefined)?.passed ?? false, false, JSON.stringify(out.r));
  assert.ok(out.r.problems.some(p => p.code === 'CHANGED_DURING_READ'), JSON.stringify(out.r.problems));
});
