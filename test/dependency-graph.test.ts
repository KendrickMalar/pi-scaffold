import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDependencyGraph, renderDependencyMermaid} from '../src/core/dependency-graph.js';
import type {DependencyPlan} from '../src/core/contracts.js';

const features = [
  {issue: 11, featureKey: 'F001', editScope: ['src/a/']},
  {issue: 12, featureKey: 'F002', editScope: ['src/b/']},
  {issue: 13, featureKey: 'F003', editScope: ['src/c/']},
];
const node = (issue: number, featureKey: string, editScope: string[]) => ({featureKey, issue, contracts: [`${featureKey}の公開API（架空）`], startConditions: [], editScope});
const plan = (edges: [number, number][], over: Partial<DependencyPlan> = {}): DependencyPlan => ({
  version: 1, nodes: features.map(f => node(f.issue, f.featureKey, f.editScope)), edges: edges.map(([from, to]) => ({from, to, reason: '架空の理由'})), ...over,
});
const codes = (g: {problems: {code: string}[]}) => g.problems.map(p => p.code);

test('a DAG over exactly the Feature set is valid', () => {
  const g = validateDependencyGraph([], plan([[11, 12], [12, 13]]), features);
  assert.equal(g.status, 'validated', JSON.stringify(g.problems));
});

for (const [label, edges, code] of [
  ['a self edge', [[11, 11]], 'SELF_EDGE'],
  ['the same edge twice', [[11, 12], [11, 12]], 'DUPLICATE_EDGE'],
  ['1→2→1', [[11, 12], [12, 11]], 'CYCLE'],
  ['an edge to an unknown node', [[11, 99]], 'UNKNOWN_NODE'],
] as const) {
  test(`${label} is blocked`, () => {
    const g = validateDependencyGraph([], plan(edges.map(e => [...e] as [number, number])), features);
    assert.equal(g.status, 'blocked');
    assert.ok(codes(g).includes(code), JSON.stringify(g.problems));
  });
}

test('a desired DAG that closes a cycle with an existing edge is blocked', () => {
  // GitHub already has 13→11; the plan keeps it (as required) and adds 11→12→13, which closes a cycle.
  const desired = plan([[11, 12], [12, 13], [13, 11]]);
  assert.equal(validateDependencyGraph([], plan([[11, 12], [12, 13]]), features).status, 'validated', 'the new edges alone are a DAG');
  const g = validateDependencyGraph([{from: 13, to: 11}], desired, features);
  assert.equal(g.status, 'blocked');
  assert.ok(codes(g).includes('CYCLE'), JSON.stringify(g.problems));
});

test('an existing edge missing from the plan is blocked (never removed silently)', () => {
  const g = validateDependencyGraph([{from: 11, to: 13}], plan([[11, 12]]), features);
  assert.equal(g.status, 'blocked');
  assert.ok(codes(g).includes('UNDECLARED_EDGE'), JSON.stringify(g.problems));
});

test('nodes must be exactly the Feature set with matching keys and edit scopes', () => {
  assert.ok(codes(validateDependencyGraph([], plan([], {nodes: plan([]).nodes.slice(0, 2)}), features)).includes('NODE_MISSING'));
  assert.ok(codes(validateDependencyGraph([], plan([], {nodes: [...plan([]).nodes, node(99, 'F009', [])]}), features)).includes('UNKNOWN_NODE'));
  assert.ok(codes(validateDependencyGraph([], plan([], {nodes: [node(11, 'F009', ['src/a/']), ...plan([]).nodes.slice(1)]}), features)).includes('NODE_MISMATCH'));
  assert.ok(codes(validateDependencyGraph([], plan([], {nodes: [node(11, 'F001', ['src/other/']), ...plan([]).nodes.slice(1)]}), features)).includes('EDIT_SCOPE_MISMATCH'));
  assert.ok(codes(validateDependencyGraph([], plan([], {nodes: [...plan([]).nodes, node(11, 'F001', ['src/a/'])]}), features)).includes('DUPLICATE_ID'));
});

test('the Mermaid diagram uses only fixed safe IDs; text from the plan never becomes syntax', () => {
  const evil = plan([[11, 12]]);
  evil.edges[0]!.reason = 'x"]; click F001 "javascript:alert(1)" %%{init:{}}%%\n graph TD';
  evil.nodes[0]!.contracts = ['"]-->F003; style F001 fill:#f00'];
  const m = renderDependencyMermaid(evil);
  assert.equal(m, 'graph LR\n  F001["F001 #11"]\n  F002["F002 #12"]\n  F003["F003 #13"]\n  F001 --> F002\n');
  assert.ok(!/click|javascript|style|%%|"\]-->/.test(m));
});

test('the Mermaid renderer refuses a node ID that bypassed decoding (defense in depth)', () => {
  const bad = plan([[11, 12]]);
  bad.nodes[0]!.featureKey = 'F001"]; click F001 "javascript:x';
  const m = renderDependencyMermaid(bad);
  assert.ok(!/click|javascript/.test(m), m);
  assert.match(m, /INVALID\["INVALID #11"\]/);
});
