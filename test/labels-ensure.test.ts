import test from 'node:test';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {labelDefinitions, waveLabelDefinition, FIXED_LABEL_DEFINITIONS} from '../src/core/label-definitions.js';
import {FIXED_LABEL_NAMES} from '../src/core/label-policy.js';
import {createHarness, loadToolModule, type Scenario} from './helpers/harness.js';
import {FakePiGh, PI_GH_020_OPERATIONS} from './helpers/fake-pi-gh.js';
import type {ToolOutcome} from '../src/ports/pi-gh.js';
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

test('a failed label listing never leads to creation', async t => {
  const gh = new FakePiGh();
  gh.overrides.set('gh_labels_list', () => FakePiGh.err('rejected', 'GITHUB_LIMIT'));
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(p => p.code === 'GITHUB_LIMIT'));
  assert.equal(applies(gh), 0);
});

test('the call budget pauses as partial and the same operation resumes without recreating', async t => {
  let clock = 0;
  const gh = new FakePiGh().seedLabels(all().slice(0, 100));
  gh.onCall = () => { clock += 1000; };
  const h = await harness(t, gh, {budgetMs: 30_000, now: () => clock});
  const first = await h.invoke();
  assert.equal(first.r.status, 'partial');
  assert.equal(first.r.resumeToken, OPERATION_ID);
  let last = first;
  for (let i = 0; i < 40 && last.r.status === 'partial'; i++) last = await h.invoke();
  assert.equal(last.r.status, 'applied', JSON.stringify(last.r.problems));
  assert.equal(gh.labelChanges.filter(c => c.operation === 'label-create').length, 111, 'no duplicate creation across calls');
  assert.equal(gh.labels.size, 211);
  assert.equal(gh.count('gh_labels_preview'), 0);
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
  const old = new FakePiGh(); old.operations = old.operations.filter(o => o !== 'gh_labels_apply');
  const out = await (await harness(t, old)).invoke();
  assert.ok(out.r.problems.some(p => p.code === 'CAPABILITY_MISSING'));
  assert.equal(old.count('gh_labels_list'), 0);
});

test('an update that was applied but reported unknown is reconciled, not stuck', async t => {
  const defs = all(); defs[0]!.color = 'ffffff';
  const gh = new FakePiGh().seedLabels(defs);
  let first = true;
  gh.overrides.set('gh_labels_apply', () => { if (!first) return undefined; first = false; gh.labels.set('type: scaffold', {...gh.labels.get('type: scaffold')!, color: '7057ff'}); return {result: {content: [], structuredContent: {status: 'unknown'}}, isError: true} as ToolOutcome; });
  const h = await harness(t, gh);
  assert.equal((await h.invoke(params({onMismatch: 'update'}))).r.status, 'unknown');
  const resumed = await h.invoke(params({onMismatch: 'update'}));
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.equal(applies(gh), 1, 'the uncertain edit is confirmed by reading, not resent');
  const other = await h.invoke(params({operationId: '55555555-5555-4555-8555-555555555555'}));
  assert.equal(other.r.status, 'noop');
});

test('a label created by someone else meanwhile does not dead-end the operation', async t => {
  let clock = 0;
  const gh = new FakePiGh().seedLabels(all().filter(d => !['Wave: 199', 'Wave: 200'].includes(d.name)));
  gh.onCall = name => { if (name === 'gh_labels_apply') clock += 100_000; };
  const h = await harness(t, gh, {budgetMs: 50_000, now: () => clock});
  const first = await h.invoke();
  assert.equal(first.r.status, 'partial');
  gh.seedLabels([labelDefinitions().find(d => d.name === 'Wave: 200')!]);
  const resumed = await h.invoke();
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.equal(applies(gh), 1);
});

test('labels deleted while paused are detected on resume, never reported unchanged', async t => {
  let clock = 0;
  const gh = new FakePiGh().seedLabels(all().filter(d => !['Wave: 199', 'Wave: 200'].includes(d.name)));
  gh.onCall = name => { if (name === 'gh_labels_apply') clock += 100_000; };
  const h = await harness(t, gh, {budgetMs: 50_000, now: () => clock});
  assert.equal((await h.invoke()).r.status, 'partial');
  gh.labels.delete('blocked');
  let resumed = await h.invoke();
  for (let i = 0; i < 5 && resumed.r.status === 'partial'; i++) resumed = await h.invoke();
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  const data = resumed.r.data as {created: string[]; unchanged: string[]};
  assert.ok(data.created.includes('Blocked'));
  assert.ok(!data.unchanged.includes('Blocked'));
  assert.ok(gh.labels.has('blocked'));
});

test('success requires a final read-back of every definition', async t => {
  const gh = new FakePiGh().seedLabels(all().filter(d => d.name !== 'Wave: 1'));
  let lists = 0;
  gh.overrides.set('gh_labels_list', () => { lists++; if (lists === 2) gh.labels.delete('blocked'); return undefined; });
  const out = await (await harness(t, gh)).invoke();
  assert.notEqual(out.r.status, 'applied');
  assert.ok(out.r.problems.some(p => p.code === 'LABEL_READBACK_MISMATCH'));
});

test('pi-gh 0.2.0 without gh_labels_list stops with CAPABILITY_MISSING', async t => {
  const old = new FakePiGh(); old.operations = [...PI_GH_020_OPERATIONS];
  const out = await (await harness(t, old)).invoke();
  assert.ok(out.r.problems.some(p => p.code === 'CAPABILITY_MISSING' && p.path === 'gh_labels_list'));
  assert.equal(old.calls.filter(c => c.name !== 'gh_capabilities').length, 0);
});

test('a paused operation is not dead-ended by a label someone else changed meanwhile', async t => {
  let clock = 0;
  const gh = new FakePiGh().seedLabels(all().filter(d => !['Wave: 199', 'Wave: 200'].includes(d.name)));
  gh.onCall = name => { if (name === 'gh_labels_apply') clock += 100_000; };
  const h = await harness(t, gh, {budgetMs: 50_000, now: () => clock});
  assert.equal((await h.invoke()).r.status, 'partial');
  gh.labels.set('blocked', {...gh.labels.get('blocked')!, color: '000000'});
  const resumed = await h.invoke();
  assert.ok(resumed.r.problems.some(p => p.code === 'LABEL_MISMATCH'));
  const fixParams = params({operationId: '55555555-5555-4555-8555-555555555555', onMismatch: 'update'});
  let fix = await h.invoke(fixParams);
  assert.ok(!fix.r.problems.some(p => p.code === 'WORKFLOW_UNRESOLVED'), 'a definite partial does not hold the namespace');
  for (let i = 0; i < 5 && fix.r.status === 'partial'; i++) fix = await h.invoke(fixParams);
  assert.equal(fix.r.status, 'applied', JSON.stringify(fix.r.problems));
  assert.equal(gh.labels.get('blocked')?.color, 'b60205');
  assert.ok(gh.labels.has('wave: 200'));
});

test('an uncertain create followed by a different same-name label resolves to the mismatch rule', async t => {
  const gh = new FakePiGh().seedLabels(all().filter(d => d.name !== 'Blocked'));
  gh.overrides.set('gh_labels_apply', () => ({result: {content: [], structuredContent: {status: 'unknown'}}, isError: true} as ToolOutcome));
  const h = await harness(t, gh);
  assert.equal((await h.invoke()).r.status, 'unknown');
  gh.overrides.delete('gh_labels_apply');
  gh.seedLabels([{name: 'Blocked', color: '000000', description: '他人が作成'}]);
  const resumed = await h.invoke();
  assert.equal(resumed.r.status, 'partial');
  assert.ok(resumed.r.problems.some(p => p.code === 'LABEL_MISMATCH' || p.code === 'LABEL_READBACK_MISMATCH'));
  assert.ok(!resumed.r.problems.some(p => p.code === 'RECONCILE_REQUIRED'));
  const other = await h.invoke(params({operationId: '55555555-5555-4555-8555-555555555555'}));
  assert.ok(!other.r.problems.some(p => p.code === 'WORKFLOW_UNRESOLVED'));
});

test('uncertain steps are reconciled before the budget pause, so the status is partial, not unknown', async t => {
  let clock = 0;
  const gh = new FakePiGh().seedLabels(all().filter(d => !['Blocked', 'Wave: 200'].includes(d.name)));
  let n = 0;
  gh.overrides.set('gh_labels_apply', () => { n++; if (n === 1) { clock += 100_000; return {result: {content: [], structuredContent: {status: 'unknown'}}, isError: true} as ToolOutcome; } return undefined; });
  const h = await harness(t, gh, {budgetMs: 50_000, now: () => clock});
  assert.equal((await h.invoke()).r.status, 'unknown');
  clock = 0;
  gh.onCall = name => { if (name === 'gh_labels_apply') clock += 100_000; };
  const resumed = await h.invoke();
  assert.equal(resumed.r.status, 'partial');
  assert.ok(!resumed.r.problems.some(p => p.code === 'RECONCILE_REQUIRED'));
});

// pi-gh 0.7.0+ (`labels-create-many`): missing labels are created in batches instead of one change per label.
const batching = () => { const gh = new FakePiGh(); gh.features = [...gh.features, 'labels-create-many']; return gh; };
const perLabelCreates = (gh: FakePiGh) => gh.labelChanges.filter(c => c.operation === 'label-create').length;

test('with labels-create-many, all 211 are created in batches of at most 40, then read back', async t => {
  const gh = batching();
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.equal(gh.labels.size, 211);
  assert.equal(perLabelCreates(gh), 0, 'no one-by-one creation');
  assert.equal(gh.labelBatches.length, 6);
  assert.ok(gh.labelBatches.every(b => b.length >= 1 && b.length <= 40));
  assert.equal(new Set(gh.labelBatches.flat()).size, 211, 'every label is sent exactly once');
  assert.equal((out.r.data as {created: string[]}).created.length, 211);
});

test('batches carry only the missing labels', async t => {
  const gh = batching().seedLabels(all().slice(0, 100));
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.deepEqual(gh.labelBatches.flat().sort(), all().slice(100).map(d => d.name).sort());
  assert.equal((out.r.data as {created: string[]; unchanged: string[]}).unchanged.length, 100);
});

test('an uncertain batch that did not land is reconciled as not applied and sent once more', async t => {
  const gh = batching();
  let calls = 0;
  gh.overrides.set('gh_labels_apply', () => { calls++; return calls === 2 ? {result: {content: [], structuredContent: {status: 'unknown'}}, isError: true} : undefined; });
  const h = await harness(t, gh);
  const first = await h.invoke();
  assert.equal(first.r.status, 'unknown');
  assert.equal(gh.labelBatches.length, 1, 'nothing is sent after the uncertain batch');
  gh.overrides.delete('gh_labels_apply');
  const resumed = await h.invoke();
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.equal(gh.labels.size, 211);
  assert.equal(new Set(gh.labelBatches.flat()).size, 211);
});

test('an uncertain batch that landed partly: the resume creates only the labels still missing', async t => {
  const gh = batching();
  let calls = 0;
  gh.overrides.set('gh_labels_apply', args => {
    calls++;
    if (calls !== 2) return undefined;
    const change = JSON.parse(readFileSync((args as {changePath: string}).changePath, 'utf8')) as {labels: {name: string; color: string; description: string}[]};
    for (const l of change.labels.slice(0, 10)) gh.labels.set(l.name.toLowerCase(), {...l, id: gh.labels.size + 1});
    return {result: {content: [], structuredContent: {status: 'unknown'}}, isError: true};
  });
  const h = await harness(t, gh);
  assert.equal((await h.invoke()).r.status, 'unknown');
  gh.overrides.delete('gh_labels_apply');
  const resumed = await h.invoke();
  assert.equal(resumed.r.status, 'applied', JSON.stringify(resumed.r.problems));
  assert.equal(gh.labels.size, 211);
  // labelBatches[0] is the first batch; the uncertain second one was answered by the override (never recorded).
  const sentAfter = gh.labelBatches.slice(1).flat();
  assert.equal(sentAfter.length, 211 - 40 - 10, 'the 10 that landed are not sent again');
  assert.equal(new Set(sentAfter).size, sentAfter.length);
});

test('the call budget pauses between batches and the same operation finishes the rest', async t => {
  let clock = 0;
  const gh = batching();
  gh.onCall = () => { clock += 5_000; };
  const h = await harness(t, gh, {budgetMs: 30_000, now: () => clock});
  const first = await h.invoke();
  assert.equal(first.r.status, 'partial');
  assert.ok(gh.labelBatches.length >= 1, 'each call makes progress before pausing');
  let last = first;
  for (let i = 0; i < 20 && last.r.status === 'partial'; i++) last = await h.invoke();
  assert.equal(last.r.status, 'applied', JSON.stringify(last.r.problems));
  assert.equal(gh.labels.size, 211);
  assert.equal(new Set(gh.labelBatches.flat()).size, gh.labelBatches.flat().length, 'no label is sent twice');
});

test('a mismatching label with onMismatch=update is still edited one by one while missing ones are batched', async t => {
  const defs = all();
  const gh = batching().seedLabels([{...defs[0]!, color: '000000'}, ...defs.slice(1, 50)]);
  const out = await (await harness(t, gh, {defaultParams: params({onMismatch: 'update'})})).invoke();
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.equal(gh.labelChanges.filter(c => c.operation === 'label-edit').length, 1);
  assert.equal(gh.labelBatches.flat().length, 161);
  assert.deepEqual((out.r.data as {updated: string[]}).updated, [defs[0]!.name]);
});

test('without the labels-create-many feature (pi-gh 0.6.0 and older) labels are created one by one as before', async t => {
  const gh = new FakePiGh().seedLabels(all().slice(0, 205));
  const out = await (await harness(t, gh)).invoke();
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.equal(perLabelCreates(gh), 6);
  assert.equal(gh.labelBatches.length, 0);
});
