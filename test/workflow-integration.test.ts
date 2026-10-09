// Cross-cutting acceptance for the whole tool set (Epic #1): registry, import graph and the shared failure rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHarness, loadToolModule} from './helpers/harness.js';
import {FakePiGh} from './helpers/fake-pi-gh.js';
import {FakeHerdr} from './helpers/fake-herdr.js';
import {OPERATION_ID, SHA_A} from './helpers/docs.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const environment = {HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w9', HERDR_PANE_ID: 'w9:pA', HERDR_SOCKET_PATH: '/synthetic/herdr.sock'};
const COMMIT = 'c'.repeat(40);
const mutation = {repo: 'example/demo', epicIssue: 10, operationId: OPERATION_ID, expectedRevision: 1, expectedBodySha256: SHA_A};
const binding = {model: 'example-provider/m-1', thinking: 'medium', reason: '架空'};

/** One schema-valid input per tool (contents need not pass the tool's own checks). */
const INPUTS: Record<string, Record<string, unknown>> = {
  scaffold_labels_ensure: {repo: 'example/demo', operationId: OPERATION_ID},
  scaffold_epic_draft_create: {repo: 'example/demo', operationId: OPERATION_ID, title: 'タイトル', purpose: '目的', originalRequest: {text: '依頼', sourceRefs: []}},
  scaffold_handoff_specification: {...mutation, expectedStage: 'setup', nextStage: 'specification'},
  scaffold_specification_update: {...mutation, facts: [], requirements: [], criteria: [], decisions: []},
  scaffold_research_begin: {...mutation, researchIds: ['R001']},
  scaffold_research_resolve: {...mutation, resolutions: [{researchId: 'R001', claimOperationId: OPERATION_ID, conclusion: '結論', evidenceRefs: ['https://example.com/e'], limitations: [], disposition: 'resolved'}]},
  scaffold_handoff_basic_design: {...mutation},
  scaffold_feature_create: {...mutation, featureKey: 'F001', title: 'F', purpose: '目的', editScope: ['src/'], outOfScope: [], designRef: {path: 'docs/d.md', sha256: SHA_A, gitRef: COMMIT},
    criteria: [{id: 'AC101', requirementIds: ['REQ001'], verification: 'v', expectedResult: 'e'}], bindings: {'coding-manager': binding, coder: binding, tester: binding}},
  scaffold_dependencies_apply: {...mutation, plan: {version: 1, nodes: [], edges: []}},
  scaffold_waves_verify: {repo: 'example/demo', epicIssue: 10},
  scaffold_waves_apply: {...mutation, plan: {version: 1, assignments: [], dependencyDigest: SHA_A, featureSetDigest: SHA_A}},
  scaffold_handoff_implementation: {...mutation},
  scaffold_handoff_verification: {...mutation, integrationRef: COMMIT, evidenceRefs: [{relativePath: 'r.json', sha256: SHA_A}]},
  scaffold_epic_complete: {...mutation, verifiedRef: COMMIT, finalEvidenceRefs: [{relativePath: 'r.json', sha256: SHA_A}]},
};

async function allTools() {
  const {TOOL_FACTORIES} = await loadToolModule('extensions/register-tools.ts') as unknown as {TOOL_FACTORIES: ((r: unknown) => {name: string; annotations: {readOnlyHint: boolean}})[]};
  return TOOL_FACTORIES;
}

test('exactly 14 tools are registered, with unique names, and only the verifier is read-only', async () => {
  const {createRuntime} = await import('../src/core/runtime.js');
  const tools = (await allTools()).map(f => f(createRuntime({agentDir: '/synthetic/agent'})));
  const names = tools.map(t => t.name);
  assert.equal(names.length, 14);
  assert.equal(new Set(names).size, 14);
  assert.deepEqual([...names].sort(), Object.keys(INPUTS).sort());
  assert.deepEqual(tools.filter(t => t.annotations.readOnlyHint).map(t => t.name), ['scaffold_waves_verify']);
});

test('no circular runtime imports in src/ and extensions/', () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
  walk(join(root, 'src')); walk(join(root, 'extensions'));
  const edges = new Map<string, string[]>();
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const deps: string[] = [];
    // Type-only imports are erased at runtime and cannot form a load cycle.
    for (const m of text.matchAll(/^import\s+(?!type\b)[^'"]*?from\s+'(\.[^']+)'/gm)) {
      let target = resolve(dirname(f), m[1]!).replace(/\/dist\/src\//, '/src/').replace(/\.js$/, '.ts');
      if (!target.endsWith('.ts')) target += '.ts';
      deps.push(target);
    }
    edges.set(f, deps);
  }
  const state = new Map<string, 1 | 2>();
  const cycle = (n: string, stack: string[]): string[] | undefined => {
    state.set(n, 1); stack.push(n);
    for (const m of edges.get(n) ?? []) {
      if (state.get(m) === 1) return [...stack.slice(stack.indexOf(m)), m];
      if (!state.has(m) && edges.has(m)) { const c = cycle(m, stack); if (c) return c; }
    }
    stack.pop(); state.set(n, 2); return undefined;
  };
  for (const f of files) if (!state.has(f)) { const c = cycle(f, []); assert.equal(c, undefined, `cycle: ${c?.map(x => relative(root, x)).join(' → ')}`); }
});

for (const name of Object.keys(INPUTS)) {
  const module = 'extensions/tools/' + {
    scaffold_labels_ensure: 'labels-ensure', scaffold_epic_draft_create: 'epic-draft', scaffold_handoff_specification: 'handoff-specification',
    scaffold_specification_update: 'specification-update', scaffold_research_begin: 'research-begin', scaffold_research_resolve: 'research-resolve',
    scaffold_handoff_basic_design: 'handoff-basic-design', scaffold_feature_create: 'feature-create', scaffold_dependencies_apply: 'dependencies-apply',
    scaffold_waves_verify: 'waves-verify', scaffold_waves_apply: 'waves-apply', scaffold_handoff_implementation: 'handoff-implementation',
    scaffold_handoff_verification: 'handoff-verification', scaffold_epic_complete: 'epic-complete',
  }[name]! + '.ts';

  test(`${name}: a missing pi-gh capability blocks with zero writes and zero tabs`, async t => {
    const gh = new FakePiGh(); gh.operations = [];
    const herdr = new FakeHerdr();
    const {createTool} = await loadToolModule(module);
    const h = await createHarness(createTool, {scenario: {gh, herdr, environment}});
    t.after(h.dispose);
    const out = await h.invoke(INPUTS[name]);
    assert.equal(out.inputSchemaValid, true, out.inputSchemaErrors.join('; '));
    assert.equal(out.r.status, 'blocked', JSON.stringify(out.r));
    assert.ok(out.r.problems.some(p => p.code === 'CAPABILITY_MISSING'), JSON.stringify(out.r.problems));
    assert.equal(gh.writes, 0); assert.equal(herdr.tabCreates, 0); assert.equal(out.isError, true);
  });

  test(`${name}: a call cancelled before it starts is "cancelled" with zero writes and zero tabs`, async t => {
    const gh = new FakePiGh(); const herdr = new FakeHerdr();
    const {createTool} = await loadToolModule(module);
    const h = await createHarness(createTool, {scenario: {gh, herdr, environment}});
    t.after(h.dispose);
    const controller = new AbortController(); controller.abort();
    const out = await h.invoke(INPUTS[name], controller.signal);
    assert.equal(out.r.status, 'cancelled', JSON.stringify(out.r));
    assert.equal(gh.writes, 0); assert.equal(herdr.tabCreates, 0); assert.equal(out.isError, true);
  });

  test(`${name}: approval-like flags in the input are rejected`, async t => {
    const gh = new FakePiGh();
    const {createTool} = await loadToolModule(module);
    const h = await createHarness(createTool, {scenario: {gh, environment}});
    t.after(h.dispose);
    for (const flag of ['approved', 'force']) {
      const out = await h.invoke({...INPUTS[name], [flag]: true});
      assert.equal(out.inputSchemaValid, false); assert.equal(out.r.status, 'blocked');
    }
    assert.equal(gh.writes, 0);
  });
}
