import test from 'node:test';
import * as fsSync from 'node:fs';
import assert from 'node:assert/strict';
import {createHarness, loadToolModule, type Scenario} from './helpers/harness.js';
import {FakePiGh} from './helpers/fake-pi-gh.js';
import {renderEpicBlock, renderFeatureBlock} from '../src/core/epic-render.js';
import {parseIssueBody} from '../src/core/body-codec.js';
import {sha256Text, taggedDigest} from '../src/core/digests.js';
import {labelDefinitions} from '../src/core/label-definitions.js';
import type {DependencyPlan, EpicDocV1, FeatureDocV1} from '../src/core/contracts.js';
import {populatedDoc, featureDoc} from './helpers/docs.js';

const OP = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', PROJECT = 'PVT_fixture1';
const BEFORE = '外のメモ\n\n';
function epicDoc(mutate: (d: EpicDocV1) => void = () => {}): EpicDocV1 {
  const d = populatedDoc();
  d.stage = 'basic-design'; d.revision = 7; d.dependencyPlan = null; d.wavePlan = null; d.handoff = null;
  mutate(d);
  return d;
}
const KEYS: Record<number, string> = {11: 'F001', 12: 'F002', 13: 'F003'};
function world(opts: {epic?: EpicDocV1; closed?: number[]; labels?: string[]} = {}) {
  const gh = new FakePiGh().seedLabels(labelDefinitions()).enableProposals();
  const epic = opts.epic ?? epicDoc();
  gh.add({number: 10, title: 'Epic', body: BEFORE + renderEpicBlock(epic), labels: opts.labels ?? ['Type: Scaffold', 'Scope: Epic', 'Stage: BasicDesign'], state: 'open', subIssues: [11, 12, 13]});
  for (const n of [11, 12, 13]) {
    const f: FeatureDocV1 = {...featureDoc(), workflowId: epic.workflowId, featureKey: KEYS[n]!, parentEpic: 10, editScope: [`src/${KEYS[n]}/`], createOperationId: `eeeeeeee-eeee-4eee-8eee-${String(n).padStart(12, '0')}`};
    gh.add({number: n, title: `Feature ${n}`, body: renderFeatureBlock(f), labels: ['Type: Scaffold', 'Scope: Feature', 'Stage: BasicDesign'], state: opts.closed?.includes(n) ? 'closed' : 'open'});
  }
  gh.projects.set(PROJECT, []);
  return gh;
}
const docOf = (gh: FakePiGh) => (parseIssueBody(gh.issues.get(10)!.body) as {ok: true; value: {doc: EpicDocV1}}).value.doc;
const node = (n: number) => ({featureKey: KEYS[n]!, issue: n, contracts: [`${KEYS[n]}のAPI`], startConditions: n === 11 ? [] : ['先行Featureの契約が確定している'], editScope: [`src/${KEYS[n]}/`]});
const plan = (edges: [number, number][]): DependencyPlan => ({version: 1, nodes: [11, 12, 13].map(node), edges: edges.map(([from, to]) => ({from, to, reason: '架空の理由'}))});
const params = (gh: FakePiGh, edges: [number, number][] = [[11, 12], [12, 13]], extra: Record<string, unknown> = {}) => ({
  repo: 'example/demo', epicIssue: 10, operationId: OP, expectedRevision: docOf(gh).revision, expectedBodySha256: sha256Text(gh.issues.get(10)!.body), plan: plan(edges), ...extra,
});
async function harness(t: {after(fn: () => Promise<void>): void}, gh: FakePiGh, scenario: Scenario = {}) {
  const {createTool} = await loadToolModule('extensions/tools/dependencies-apply.ts');
  const h = await createHarness(createTool, {scenario: {gh, defaultParams: scenario.defaultParams ?? params(gh), ...scenario}});
  t.after(h.dispose);
  return h;
}
type Data = {addedEdges: {from: number; to: number}[]; unchangedEdges: {from: number; to: number}[]; mermaid: string; projectItems: number[]};
const depAdds = (gh: FakePiGh) => gh.calls.filter(c => c.name === 'gh_dependency_add');
const projectCalls = (gh: FakePiGh) => gh.calls.filter(c => c.name.startsWith('gh_project_'));
const noChanges = (gh: FakePiGh, before: string) => { assert.equal(depAdds(gh).length, 0); assert.equal(gh.count('gh_project_add_issue'), 0); assert.equal(gh.issues.get(10)!.body, before); };

for (const [label, edges, code] of [
  ['self edge', [[11, 11]], 'SELF_EDGE'], ['duplicate edge', [[11, 12], [11, 12]], 'DUPLICATE_EDGE'], ['unknown node', [[11, 99]], 'UNKNOWN_NODE'], ['cycle', [[11, 12], [12, 11]], 'CYCLE'],
] as const) {
  test(`plan with ${label} is blocked with zero changes`, async t => {
    const gh = world(); const before = gh.issues.get(10)!.body;
    const out = await (await harness(t, gh)).invoke(params(gh, edges.map(e => [...e] as [number, number])));
    assert.equal(out.r.status, 'blocked');
    assert.ok(out.r.problems.some(p => p.code === code), JSON.stringify(out.r.problems));
    noChanges(gh, before);
  });
}

test('a node of another Epic is blocked', async t => {
  const gh = world(); const before = gh.issues.get(10)!.body;
  const p = params(gh); (p.plan as DependencyPlan).nodes[2] = {...node(13), issue: 20};
  const out = await (await harness(t, gh)).invoke(p);
  assert.equal(out.r.status, 'blocked'); noChanges(gh, before);
});

test('an existing edge plus the desired edges forming a cycle adds nothing', async t => {
  const gh = world(); gh.issues.get(11)!.blockedBy = [13]; // 13 → 11 already on GitHub
  const before = gh.issues.get(10)!.body;
  const out = await (await harness(t, gh)).invoke(params(gh, [[11, 12], [12, 13], [13, 11]]));
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(p => p.code === 'CYCLE'), JSON.stringify(out.r.problems));
  noChanges(gh, before);
});

test('an existing Feature dependency missing from the plan stops (nothing is removed)', async t => {
  const gh = world(); gh.issues.get(13)!.blockedBy = [11];
  const before = gh.issues.get(10)!.body;
  const out = await (await harness(t, gh)).invoke(params(gh, [[11, 12]]));
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(p => p.code === 'UNDECLARED_EDGE'));
  noChanges(gh, before); assert.deepEqual(gh.issues.get(13)!.blockedBy, [11]);
});

test('a dependency on an Issue outside the Feature set stops without removing it', async t => {
  const gh = world(); gh.issues.get(12)!.blockedBy = ['https://github.com/other/repo/issues/5'];
  const before = gh.issues.get(10)!.body;
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(p => p.code === 'EXTERNAL_DEPENDENCY'), JSON.stringify(out.r.problems));
  noChanges(gh, before);
});

test('from=11,to=12 calls the API with issue=12, relatedIssue=11; existing edges are not re-added', async t => {
  const gh = world(); gh.issues.get(13)!.blockedBy = [12]; // 12 → 13 exists
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  const adds = depAdds(gh);
  assert.equal(adds.length, 1);
  const {readFileSync} = await import('node:fs');
  const change = JSON.parse(readFileSync((adds[0]!.args as {changePath: string}).changePath, 'utf8'));
  assert.deepEqual([change.operation, change.issue, change.relatedIssue], ['dependency-add', 12, 11]);
  const data = out.r.data as Data;
  assert.deepEqual(data.addedEdges, [{from: 11, to: 12}]); assert.deepEqual(data.unchangedEdges, [{from: 12, to: 13}]);
  assert.deepEqual(gh.issues.get(12)!.blockedBy, [11]);
});

test('the plan and a safe Mermaid diagram are saved in the Epic; outside bytes kept', async t => {
  const gh = world();
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'applied');
  const doc = docOf(gh);
  assert.deepEqual(doc.dependencyPlan, plan([[11, 12], [12, 13]]));
  assert.equal(doc.revision, 8);
  const body = gh.issues.get(10)!.body;
  assert.ok(body.startsWith(BEFORE));
  assert.ok(body.includes('```mermaid\ngraph LR\n  F001["F001 #11"]'), 'the diagram is shown in the Epic');
  assert.equal((out.r.data as Data).mermaid, 'graph LR\n  F001["F001 #11"]\n  F002["F002 #12"]\n  F003["F003 #13"]\n  F001 --> F002\n  F002 --> F003\n');
});

test('closed Features are part of the set and must be in the plan', async t => {
  const gh = world({closed: [13]});
  const p = params(gh); (p.plan as DependencyPlan).nodes = (p.plan as DependencyPlan).nodes.filter(n => n.issue !== 13); (p.plan as DependencyPlan).edges = [{from: 11, to: 12, reason: 'x'}];
  const out = await (await harness(t, gh)).invoke(p);
  assert.equal(out.r.status, 'blocked'); assert.ok(out.r.problems.some(x => x.code === 'NODE_MISSING'));
});

test('without projectId there is no Project call at all (GraphQL 0)', async t => {
  const gh = world();
  await (await harness(t, gh)).invoke();
  assert.equal(projectCalls(gh).length, 0);
});

test('with projectId, missing Features are added once and read back', async t => {
  const gh = world(); gh.projects.set(PROJECT, [12]);
  const h = await harness(t, gh);
  const out = await h.invoke(params(gh, undefined, {projectId: PROJECT}));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.deepEqual([...gh.projects.get(PROJECT)!].sort(), [11, 12, 13]);
  assert.equal(gh.count('gh_project_add_issue'), 2);
  assert.deepEqual((out.r.data as Data).projectItems, [11, 12, 13]);
});

test('an unknown Project is blocked before any change', async t => {
  const gh = world(); const before = gh.issues.get(10)!.body;
  const out = await (await harness(t, gh)).invoke(params(gh, undefined, {projectId: 'PVT_other'}));
  assert.equal(out.r.status, 'blocked'); noChanges(gh, before);
});

test('a failed edge stops later writes; resume adds nothing twice', async t => {
  const gh = world();
  let n = 0;
  gh.overrides.set('gh_dependency_add', () => (++n === 2 ? FakePiGh.err('rejected', 'GITHUB_WRITE') : undefined));
  const h = await harness(t, gh);
  const p = params(gh, undefined, {projectId: PROJECT});
  const first = await h.invoke(p);
  assert.equal(first.r.status, 'partial', JSON.stringify(first.r));
  assert.equal(gh.count('gh_project_add_issue'), 0, 'no Project change after the failure');
  assert.equal(docOf(gh).dependencyPlan, null, 'the Epic is not saved after the failure');
  const resumed = await h.invoke(p);
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.deepEqual(gh.issues.get(12)!.blockedBy, [11]); assert.deepEqual(gh.issues.get(13)!.blockedBy, [12]);
  assert.equal(gh.count('gh_project_add_issue'), 3);
});

test('an unknown edge outcome is reconciled from the dependency list, not resent', async t => {
  const gh = world();
  const real = gh.execute;
  gh.overrides.set('gh_dependency_add', async args => { gh.overrides.delete('gh_dependency_add'); await real('gh_dependency_add', args); return {result: {content: [], structuredContent: {status: 'unknown'}}, isError: true}; });
  const h = await harness(t, gh);
  assert.equal((await h.invoke()).r.status, 'unknown');
  const before = depAdds(gh).length;
  const resumed = await h.invoke();
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.equal(depAdds(gh).length, before + 1, 'only the second edge is added');
});

test('re-running is a noop; stage/Blocked/stale are blocked', async t => {
  const gh = world();
  const h = await harness(t, gh);
  assert.equal((await h.invoke()).r.status, 'applied');
  const again = await h.invoke();
  assert.equal(again.r.status, 'noop'); assert.equal(again.ghWrites, 0);
  for (const g of [world({epic: epicDoc(d => { d.stage = 'specification'; }), labels: ['Type: Scaffold', 'Scope: Epic', 'Stage: Specification']}), world({labels: ['Type: Scaffold', 'Scope: Epic', 'Stage: BasicDesign', 'Blocked']})]) {
    const before = g.issues.get(10)!.body;
    const out = await (await harness(t, g)).invoke(params(g));
    assert.equal(out.r.status, 'blocked'); noChanges(g, before);
  }
  const s = world(); const before = s.issues.get(10)!.body;
  const stale = await (await harness(t, s)).invoke(params(s, undefined, {expectedBodySha256: 'f'.repeat(64)}));
  assert.equal(stale.r.status, 'blocked'); noChanges(s, before);
});

// ---- review follow-ups --------------------------------------------------------------------------

test('an unknown add that did not land is reconciled as not applied and sent once more (other blockers are not "external")', async t => {
  const gh = world();
  let lose = true;
  gh.overrides.set('gh_dependency_add', args => {
    const {readFileSync} = fsSync;
    const c = JSON.parse(readFileSync((args as {changePath: string}).changePath, 'utf8'));
    if (c.issue === 13 && lose) { lose = false; return {result: {content: [], structuredContent: {status: 'unknown'}}, isError: true}; }
    return undefined;
  });
  const h = await harness(t, gh);
  assert.equal((await h.invoke()).r.status, 'unknown');
  const resumed = await h.invoke();
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.deepEqual(gh.issues.get(13)!.blockedBy, [12]); assert.deepEqual(gh.issues.get(12)!.blockedBy, [11]);
});

test('a resume decides from the current GitHub state: an edge removed by someone else meanwhile is added again', async t => {
  const gh = world(); gh.issues.get(12)!.blockedBy = [11];
  let fail = true;
  gh.overrides.set('gh_dependency_add', () => fail ? (fail = false, FakePiGh.err('rejected', 'GITHUB_WRITE')) : undefined);
  const h = await harness(t, gh);
  assert.notEqual((await h.invoke()).r.status, 'applied');
  gh.issues.get(12)!.blockedBy = []; // removed by a third party
  const resumed = await h.invoke();
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.deepEqual(gh.issues.get(12)!.blockedBy, [11]); assert.deepEqual(gh.issues.get(13)!.blockedBy, [12]);
  assert.deepEqual((resumed.r.data as Data).addedEdges.sort((a, b) => a.from - b.from), [{from: 11, to: 12}, {from: 12, to: 13}]);
});

test('addedEdges lists only edges this operation actually added (a remote noop is not "added")', async t => {
  const gh = world();
  gh.overrides.set('gh_dependency_add', args => {
    const {readFileSync} = fsSync;
    const c = JSON.parse(readFileSync((args as {changePath: string}).changePath, 'utf8'));
    if (c.issue === 12) { gh.issues.get(12)!.blockedBy = [11]; return {result: {content: [], structuredContent: {status: 'noop'}}, isError: false}; }
    return undefined;
  });
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'applied');
  assert.deepEqual((out.r.data as Data).addedEdges, [{from: 12, to: 13}]);
});

test('the Epic is not saved when it moved on while edges were being added (stage, Blocked or a different plan)', async t => {
  for (const change of [
    (gh: FakePiGh) => { const d = docOf(gh); d.stage = 'implementation'; gh.issues.get(10)!.body = BEFORE + renderEpicBlock(d); },
    (gh: FakePiGh) => { gh.issues.get(10)!.labels.push('Blocked'); },
    (gh: FakePiGh) => { const d = docOf(gh); d.dependencyPlan = {...plan([[11, 13]])}; gh.issues.get(10)!.body = BEFORE + renderEpicBlock(d); },
  ]) {
    const gh = world();
    let done = false;
    gh.onCall = name => { if (name === 'gh_dependency_add' && !done) { done = true; change(gh); } };
    const out = await (await harness(t, gh)).invoke();
    assert.notEqual(out.r.status, 'applied', JSON.stringify(out.r));
    assert.notDeepEqual(docOf(gh).dependencyPlan, plan([[11, 12], [12, 13]]), 'the plan is not written over the moved Epic');
  }
});

test('a Feature added to the Epic meanwhile stops the save (the plan no longer covers every Feature)', async t => {
  const gh = world();
  let done = false;
  gh.onCall = name => {
    if (name !== 'gh_dependency_add' || done) return;
    done = true;
    const f: FeatureDocV1 = {...featureDoc(), workflowId: docOf(gh).workflowId, featureKey: 'F004', parentEpic: 10, editScope: ['src/F004/'], createOperationId: 'eeeeeeee-eeee-4eee-8eee-000000000014'};
    gh.add({number: 14, title: 'Feature 14', body: renderFeatureBlock(f), labels: ['Type: Scaffold', 'Scope: Feature', 'Stage: BasicDesign'], state: 'open'});
    gh.issues.get(10)!.subIssues = [11, 12, 13, 14];
  };
  const out = await (await harness(t, gh)).invoke();
  assert.notEqual(out.r.status, 'applied');
  assert.equal(docOf(gh).dependencyPlan, null);
});

// ---- the basic design reference is recorded with the dependency plan (Epic #1 integration) ----------

const DESIGN_COMMIT = '9'.repeat(40), DESIGN_TEXT = '# 基本設計（架空）\n';
const designRef = {path: 'docs/design.md', sha256: sha256Text(DESIGN_TEXT), gitRef: DESIGN_COMMIT};

test('a verified design reference is saved to the Epic together with the plan', async t => {
  const gh = world();
  const h = await harness(t, gh, {blobs: {[`${DESIGN_COMMIT}:docs/design.md`]: DESIGN_TEXT}});
  const input = params(gh, undefined, {design: designRef});
  const out = await h.invoke(input);
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.deepEqual(docOf(gh).design, designRef);
  assert.deepEqual(docOf(gh).dependencyPlan, plan([[11, 12], [12, 13]]));
  const again = await h.invoke(input);
  assert.equal(again.r.status, 'noop', JSON.stringify(again.r.problems)); assert.equal(again.ghWrites, 0);
});

test('a design reference that is missing or has another hash blocks before any change', async t => {
  for (const [blobs, code] of [[{}, 'DESIGN_NOT_FOUND'], [{[`${DESIGN_COMMIT}:docs/design.md`]: DESIGN_TEXT + '改変'}, 'DESIGN_HASH_MISMATCH']] as const) {
    const gh = world(); const before = gh.issues.get(10)!.body;
    const h = await harness(t, gh, {blobs: blobs as Record<string, string>});
    const out = await h.invoke(params(gh, undefined, {design: designRef}));
    assert.equal(out.r.status, 'blocked');
    assert.ok(out.r.problems.some(p => p.code === code), JSON.stringify(out.r.problems));
    noChanges(gh, before);
  }
});

test('without design, an existing design reference is kept as it is', async t => {
  const existing = {path: 'docs/old.md', sha256: 'e'.repeat(64), gitRef: '8'.repeat(40)};
  const gh = world({epic: epicDoc(d => { d.design = existing; })});
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.deepEqual(docOf(gh).design, existing);
});

test('a design saved by another operation meanwhile is not overwritten', async t => {
  const other = {path: 'docs/other.md', sha256: 'e'.repeat(64), gitRef: '7'.repeat(40)};
  const gh = world();
  let done = false;
  gh.onCall = name => { if (name === 'gh_dependency_add' && !done) { done = true; const d = docOf(gh); d.design = other; gh.issues.get(10)!.body = BEFORE + renderEpicBlock(d); } };
  const out = await (await harness(t, gh, {blobs: {[`${DESIGN_COMMIT}:docs/design.md`]: DESIGN_TEXT}})).invoke(params(gh, undefined, {design: designRef}));
  assert.notEqual(out.r.status, 'applied');
  assert.ok(out.r.problems.some(p => p.code === 'DESIGN_CHANGED'), JSON.stringify(out.r.problems));
  assert.deepEqual(docOf(gh).design, other);
});

// ---- digests a Wave plan must carry (#34) -------------------------------------------------------

test('applied and noop results return the dependencyDigest a Wave plan must carry', async t => {
  const gh = world();
  const h = await harness(t, gh);
  const out = await h.invoke();
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  const expected = taggedDigest('dependency-plan', plan([[11, 12], [12, 13]]));
  assert.equal((out.r.data as Data & {dependencyDigest: string}).dependencyDigest, expected);
  // It is the digest of the plan as saved on the Epic (what scaffold_waves_verify/apply compare against).
  assert.equal(expected, taggedDigest('dependency-plan', docOf(gh).dependencyPlan));
  const again = await h.invoke();
  assert.equal(again.r.status, 'noop');
  assert.equal((again.r.data as Data & {dependencyDigest: string}).dependencyDigest, expected);
  // A new operation over the already-saved plan is a noop with the same digest.
  const fresh = await (await harness(t, gh)).invoke(params(gh, [[11, 12], [12, 13]], {operationId: 'dddddddd-dddd-4ddd-8ddd-000000000002'}));
  assert.equal(fresh.r.status, 'noop', JSON.stringify(fresh.r.problems));
  assert.equal((fresh.r.data as Data & {dependencyDigest: string}).dependencyDigest, expected);
});

test('a blocked dependencies_apply returns no digest', async t => {
  const gh = world();
  const out = await (await harness(t, gh)).invoke(params(gh, [[11, 11]]));
  assert.equal(out.r.status, 'blocked');
  assert.equal((out.r.data as {dependencyDigest?: string} | undefined)?.dependencyDigest, undefined);
});
