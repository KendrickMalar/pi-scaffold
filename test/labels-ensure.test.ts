import test from 'node:test';
import assert from 'node:assert/strict';
import {labelDefinitions, waveLabelDefinition, FIXED_LABEL_DEFINITIONS} from '../src/core/label-definitions.js';
import {FIXED_LABEL_NAMES} from '../src/core/label-policy.js';
import {createHarness, loadToolModule, type Scenario} from './helpers/harness.js';
import {FakePiGh, PI_GH_020_OPERATIONS} from './helpers/fake-pi-gh.js';
import {OPERATION_ID} from './helpers/docs.js';

const params = (extra: Record<string, unknown> = {}) => ({repo: 'example/demo', operationId: OPERATION_ID, ...extra});
const all = () => labelDefinitions().map(d => ({...d}));
async function harness(t: {after(fn: () => Promise<void>): void}, gh: FakePiGh, scenario: Scenario = {}) {
  const {createTool} = await loadToolModule('extensions/tools/labels-ensure.ts');
  const h = await createHarness(createTool, {scenario: {gh, defaultParams: params(), ...scenario}});
  t.after(h.dispose);
  return h;
}
const applies = (gh: FakePiGh) => gh.count('gh_labels_apply');

test('211 definitions: 11 fixed names and Wave 1..200, each once', () => {
  const defs = labelDefinitions();
  assert.equal(defs.length, 211);
  assert.equal(new Set(defs.map(d => d.name)).size, 211);
  assert.equal(new Set(defs.map(d => d.name.toLowerCase())).size, 211);
  assert.deepEqual(FIXED_LABEL_DEFINITIONS.map(d => d.name), FIXED_LABEL_NAMES);
  for (let n = 1; n <= 200; n++) assert.equal(defs.filter(d => d.name === `Wave: ${n}`).length, 1);
  assert.deepEqual(waveLabelDefinition(1), {name: 'Wave: 1', color: '9e9e9e', description: '実行Wave 1'});
  assert.equal(waveLabelDefinition(200).name, 'Wave: 200');
  for (const bad of [0, 201, 1.5, '1']) assert.throws(() => waveLabelDefinition(bad as number), String(bad));
  for (const d of defs) { assert.match(d.color, /^[0-9a-f]{6}$/); assert.ok(Array.from(d.description).length <= 100); }
});

test('all 211 already match: no writes and noop', async t => {
  const gh = new FakePiGh().seedLabels(all());
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'noop', JSON.stringify(out.r.problems));
  assert.equal(out.ghWrites, 0);
  assert.equal((out.r.data as {unchanged: string[]}).unchanged.length, 211);
  assert.equal(out.outputSchemaValid, true);
});

test('missing labels are created, others kept; every definition reads back; no Issue label changes', async t => {
  const gh = new FakePiGh().seedLabels(all().filter(d => !['Blocked', 'Wave: 7'].includes(d.name))).seedLabels([{name: 'bug', color: 'd73a4a', description: '不具合'}]);
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.deepEqual((out.r.data as {created: string[]}).created.sort(), ['Blocked', 'Wave: 7']);
  assert.equal(applies(gh), 2);
  for (const d of labelDefinitions()) assert.deepEqual({name: gh.labels.get(d.name.toLowerCase())?.name, color: gh.labels.get(d.name.toLowerCase())?.color, description: gh.labels.get(d.name.toLowerCase())?.description}, d);
  assert.ok(gh.labels.has('bug'));
  assert.ok(gh.labelChanges.every(c => c.operation === 'label-create'));
  const again = await (await harness(t, gh, {})).invoke(params({operationId: '55555555-5555-4555-8555-555555555555'}));
  assert.equal(again.r.status, 'noop'); assert.equal(again.ghWrites, 0);
});

for (const [label, patch] of [['color', {color: 'ffffff'}], ['description', {description: '別の説明'}], ['case', {name: 'type: scaffold'}]] as const) {
  test(`a ${label} difference blocks by default without overwriting anything`, async t => {
    const defs = all(); Object.assign(defs[0]!, patch);
    const gh = new FakePiGh().seedLabels(defs.filter(d => d.name !== 'Wave: 9'));
    const out = await (await harness(t, gh)).invoke();
    assert.equal(out.r.status, 'blocked');
    assert.ok(out.r.problems.some(p => p.code === 'LABEL_MISMATCH' && p.path.includes('Type: Scaffold')));
    assert.equal(applies(gh), 0, 'nothing is created or updated while a mismatch blocks');
  });
}

test('onMismatch=update edits only the mismatching definition', async t => {
  const defs = all(); defs[0]!.color = 'ffffff'; defs[1]!.name = 'type: jig';
  const gh = new FakePiGh().seedLabels(defs);
  const out = await (await harness(t, gh)).invoke(params({onMismatch: 'update'}));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.deepEqual((out.r.data as {updated: string[]}).updated.sort(), ['Type: Jig', 'Type: Scaffold']);
  assert.deepEqual(gh.labelChanges.map(c => c.operation), ['label-edit', 'label-edit']);
  assert.equal(gh.labels.get('type: jig')?.name, 'Type: Jig');
  assert.equal(gh.labels.get('type: scaffold')?.color, '7057ff');
});

test('update without approval/permission changes nothing', async t => {
  const defs = all(); defs[0]!.color = 'ffffff';
  const gh = new FakePiGh().seedLabels(defs);
  gh.overrides.set('gh_labels_apply', () => FakePiGh.err('rejected', 'APPROVAL_UI_REQUIRED'));
  const out = await (await harness(t, gh)).invoke(params({onMismatch: 'update'}));
  assert.equal(out.r.status, 'blocked');
  assert.equal(gh.labels.get('type: scaffold')?.color, 'ffffff');
});

test('a preview error other than LABEL_MISSING never leads to creation', async t => {
  const gh = new FakePiGh();
  gh.overrides.set('gh_labels_preview', () => FakePiGh.err('rejected', 'GITHUB_READ'));
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(p => p.code === 'GITHUB_READ'));
  assert.equal(applies(gh), 0);
});

test('the call budget pauses as partial and the same operation resumes without rechecking or recreating', async t => {
  let clock = 0;
  const gh = new FakePiGh().seedLabels(all().slice(0, 100));
  gh.onCall = () => { clock += 1000; };
  const h = await harness(t, gh, {budgetMs: 30_000, now: () => clock});
  const first = await h.invoke();
  assert.equal(first.r.status, 'partial');
  assert.equal(first.r.resumeToken, OPERATION_ID);
  assert.equal(applies(gh), 0, 'nothing is created before every definition is checked');
  const other = await h.invoke(params({operationId: '55555555-5555-4555-8555-555555555555'}));
  assert.ok(other.r.problems.some(p => p.code === 'WORKFLOW_UNRESOLVED'));
  let last = first;
  for (let i = 0; i < 40 && last.r.status === 'partial'; i++) last = await h.invoke();
  assert.equal(last.r.status, 'applied', JSON.stringify(last.r.problems));
  assert.equal(gh.count('gh_labels_preview'), 211, 'each definition is previewed exactly once across calls');
  assert.equal(applies(gh), 111);
  assert.equal(gh.labels.size, 211);
});

test('an unknown create stops later applies and is reconciled on resume', async t => {
  const gh = new FakePiGh().seedLabels(all().slice(0, 205));
  let creates = 0;
  gh.overrides.set('gh_labels_apply', () => { creates++; return creates === 3 ? {result: {content: [], structuredContent: {status: 'unknown'}}, isError: true} : undefined; });
  const h = await harness(t, gh);
  const first = await h.invoke();
  assert.equal(first.r.status, 'unknown');
  assert.equal(applies(gh), 3, 'no apply after the uncertain one');
  gh.overrides.delete('gh_labels_apply');
  const resumed = await h.invoke();
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.equal(gh.labels.size, 211);
  assert.equal(gh.labelChanges.filter(c => c.operation === 'label-create').length, 6, 'the uncertain label is checked before it is created again');
});

test('a label created concurrently (LABEL_EXISTS) is not treated as success', async t => {
  const gh = new FakePiGh().seedLabels(all().slice(0, 210));
  gh.overrides.set('gh_labels_apply', () => FakePiGh.err('rejected', 'LABEL_EXISTS'));
  const out = await (await harness(t, gh)).invoke();
  assert.notEqual(out.r.status, 'applied');
  assert.ok(out.r.problems.some(p => p.code === 'LABEL_EXISTS'));
});

test('input is strict: no partial wave selection, unknown keys or modes', async t => {
  const gh = new FakePiGh();
  const h = await harness(t, gh);
  for (const bad of [params({waves: [1, 2]}), params({onMismatch: 'replace'}), params({approved: true}), {repo: 'example/demo'}, params({operationId: 'x'})]) {
    const out = await h.invoke(bad);
    assert.equal(out.r.status, 'blocked', JSON.stringify(bad));
    assert.equal(out.inputSchemaValid, false);
    assert.equal(gh.calls.length, 0);
  }
});

test('untrusted projects and missing pi-gh label tools stop before any GitHub call', async t => {
  const gh = new FakePiGh();
  assert.ok((await (await harness(t, gh, {trusted: false})).invoke()).r.problems.some(p => p.code === 'UNTRUSTED_PROJECT'));
  const old = new FakePiGh(); old.operations = PI_GH_020_OPERATIONS.filter(o => o !== 'gh_labels_apply');
  const out = await (await harness(t, old)).invoke();
  assert.ok(out.r.problems.some(p => p.code === 'CAPABILITY_MISSING'));
  assert.equal(old.count('gh_labels_preview'), 0);
});
