import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWavePlan, checkWaveLabels, normalizeScope, type WaveFeature} from '../src/core/wave-plan.js';
import {SHA_A, SHA_B} from './helpers/docs.js';
import type {WavePlan} from '../src/core/contracts.js';

const feat = (issue: number, editScope: string[], labels: string[] = []): WaveFeature => ({issue, featureKey: `F${String(issue).padStart(3, '0')}`, editScope, labels});
const digests = {featureSetDigest: SHA_A, dependencyDigest: SHA_B};
const planOf = (assignments: [number, unknown][], over: Record<string, unknown> = {}) => ({version: 1, assignments: assignments.map(([issue, wave]) => ({issue, wave})), ...digests, ...over});
const three = [feat(11, ['src/a/']), feat(12, ['src/b/']), feat(13, ['src/c/'])];
const codes = (c: {problems: {code: string}[]}) => c.problems.map(p => p.code);

test('independent paths, strict dependency order and one Wave per Feature pass', () => {
  const c = validateWavePlan(planOf([[11, 1], [12, 1], [13, 2]]), three, [{from: 11, to: 13}], digests);
  assert.equal(c.passed, true, JSON.stringify(c.problems));
  assert.deepEqual(c.problems, []);
});

for (const [label, wave] of [['0', 0], ['201', 201], ['1.5', 1.5], ['"1"', '1']] as const) {
  test(`wave ${label} fails`, () => {
    const c = validateWavePlan(planOf([[11, wave], [12, 1], [13, 2]]), three, [], digests);
    assert.equal(c.passed, false);
    assert.ok(c.problems.length > 0);
  });
}

test('a null plan fails (not set yet)', () => {
  const c = validateWavePlan(null, three, [], digests);
  assert.equal(c.passed, false); assert.ok(codes(c).includes('PLAN_UNSET'));
});

test('a missing, duplicated or unknown assignment fails; closed Features are not dropped', () => {
  const fifty = Array.from({length: 50}, (_, i) => feat(100 + i, [`src/f${i}/`]));
  const missingOne = validateWavePlan(planOf(fifty.slice(0, 49).map(f => [f.issue, 1])), fifty, [], digests);
  assert.equal(missingOne.passed, false); assert.ok(codes(missingOne).includes('UNASSIGNED_FEATURE'));
  assert.ok(missingOne.problems.some(p => p.path.includes('#149')), JSON.stringify(missingOne.problems));
  assert.ok(codes(validateWavePlan(planOf([[11, 1], [11, 2], [12, 1], [13, 1]]), three, [], digests)).includes('DUPLICATE_ASSIGNMENT'));
  assert.ok(codes(validateWavePlan(planOf([[11, 1], [12, 1], [13, 1], [99, 1]]), three, [], digests)).includes('UNKNOWN_FEATURE'));
});

test('a dependency with wave(from) >= wave(to) fails and names the edge', () => {
  for (const [wf, wt] of [[1, 1], [2, 1]]) {
    const c = validateWavePlan(planOf([[11, wf], [12, 1], [13, wt]]), three, [{from: 11, to: 13}], digests);
    assert.equal(c.passed, false);
    assert.ok(c.problems.some(p => p.code === 'DEPENDENCY_ORDER' && /#11 → #13/.test(p.message)), JSON.stringify(c.problems));
  }
});

test('stale digests fail', () => {
  assert.ok(codes(validateWavePlan(planOf([[11, 1], [12, 1], [13, 1]], {featureSetDigest: SHA_B}), three, [], digests)).includes('FEATURE_SET_CHANGED'));
  assert.ok(codes(validateWavePlan(planOf([[11, 1], [12, 1], [13, 1]], {dependencyDigest: SHA_A}), three, [], digests)).includes('DEPENDENCIES_CHANGED'));
});

for (const [label, a, b] of [
  ['a/ and a/b.ts', ['a/'], ['a/b.ts']],
  ['the same file', ['src/x.ts'], ['./src//x.ts']],
  ['two package.json in different places', ['packages/a/package.json'], ['packages/b/package.json']],
  ['a lockfile and tsconfig', ['pnpm-lock.yaml'], ['tsconfig.build.json']],
  ['two migrations', ['db/migrations/001.sql'], ['services/x/migrations/']],
  ['two workflows', ['.github/workflows/ci.yml'], ['.github/workflows/release.yml']],
] as const) {
  test(`same Wave with ${label} conflicts and names both Issues`, () => {
    const c = validateWavePlan(planOf([[11, 1], [12, 1]]), [feat(11, [...a]), feat(12, [...b])], [], digests);
    assert.equal(c.passed, false);
    assert.ok(c.problems.some(p => p.code === 'EDIT_CONFLICT' && /#11/.test(p.message) && /#12/.test(p.message)), JSON.stringify(c.problems));
  });
}

test('conflicting paths in different Waves are fine', () => {
  const c = validateWavePlan(planOf([[11, 1], [12, 2]]), [feat(11, ['package.json']), feat(12, ['package.json'])], [], digests);
  assert.equal(c.passed, true, JSON.stringify(c.problems));
});

for (const [label, scope] of [['empty', []], ['root', ['.']], ['glob', ['src/**']], ['parent', ['../x']], ['absolute', ['/etc/x']], ['backslash', ['src\\x']]] as const) {
  test(`an undecidable edit scope (${label}) never passes`, () => {
    const c = validateWavePlan(planOf([[11, 1], [12, 2]]), [feat(11, [...scope]), feat(12, ['src/b/'])], [], digests);
    assert.equal(c.passed, false);
    assert.ok(codes(c).includes('UNKNOWN_SCOPE'), JSON.stringify(c.problems));
  });
}

test('scope normalization is repo-relative and stable', () => {
  assert.equal(normalizeScope('./src//a/'), 'src/a');
  assert.equal(normalizeScope('src/a'), 'src/a');
  assert.equal(normalizeScope('src/**'), undefined);
});

test('labels: exactly one canonical "Wave: N" matching the plan', () => {
  const plan = planOf([[11, 1], [12, 2], [13, 2]]) as unknown as WavePlan;
  const ok = checkWaveLabels(plan, [feat(11, [], ['Wave: 1']), feat(12, [], ['Wave: 2', 'Type: Scaffold']), feat(13, [], ['Wave: 2'])]);
  assert.deepEqual(ok, []);
  const bad = checkWaveLabels(plan, [feat(11, [], []), feat(12, [], ['Wave: 2', 'Wave: 3']), feat(13, [], ['wave: 2'])]);
  assert.deepEqual(bad.map(p => p.code).sort(), ['WAVE_LABEL_MISSING', 'WAVE_LABEL_MULTIPLE', 'WAVE_LABEL_NONCANONICAL'].sort());
  assert.deepEqual(checkWaveLabels(plan, [feat(11, [], ['Wave: 3']), feat(12, [], ['Wave: 2']), feat(13, [], ['Wave: 2'])]).map(p => p.code), ['WAVE_LABEL_MISMATCH']);
  assert.deepEqual(checkWaveLabels(plan, [feat(11, [], ['Wave:1']), feat(12, [], ['Wave: 2']), feat(13, [], ['Wave: 2'])]).map(p => p.code), ['WAVE_LABEL_NONCANONICAL']);
});
