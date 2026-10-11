import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWavePlan, checkWaveLabels, normalizeScope, editScopeProblems, readScopeContents, type WaveFeature} from '../src/core/wave-plan.js';
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

for (const [label, scope] of [['empty', []], ['blank entry', ['  ']], ['parent', ['../x']], ['parent glob', ['src/../**']], ['absolute', ['/etc/x']], ['absolute glob', ['/src/**']], ['backslash', ['src\\x']]] as const) {
  test(`an undecidable edit scope (${label}) never passes`, () => {
    const c = validateWavePlan(planOf([[11, 1], [12, 2]]), [feat(11, [...scope]), feat(12, ['src/b/'])], [], digests);
    assert.equal(c.passed, false);
    assert.ok(codes(c).includes('UNKNOWN_SCOPE'), JSON.stringify(c.problems));
  });
}

test('scope normalization is repo-relative and stable', () => {
  assert.equal(normalizeScope('./src//a/'), 'src/a');
  assert.equal(normalizeScope('src/a'), 'src/a');
  assert.equal(normalizeScope('src/**'), 'src/**');
  assert.equal(normalizeScope('./src//**/*.ts'), 'src/**/*.ts');
  for (const root of ['.', './', './/']) assert.equal(normalizeScope(root), '.');
  assert.equal(normalizeScope('**'), '**');
  for (const bad of ['', ' ', '/x', '../x', 'a/../b', 'a\\b', 'src/*.', 'src/a /b']) assert.equal(normalizeScope(bad), undefined, bad);
});

for (const [label, scope] of [['root', ['.']], ['root slash', ['./']], ['all', ['**']], ['glob', ['src/**']], ['glob ext', ['src/**/*.ts']], ['char class', ['src/[ab].ts']], ['brace', ['src/{a,b}/x.ts']], ['question', ['src/?.ts']]] as const) {
  test(`a ${label} edit scope is judgeable`, () => {
    assert.deepEqual(editScopeProblems([...scope], 'editScope'), []);
    const c = validateWavePlan(planOf([[11, 1], [12, 2]]), [feat(11, [...scope]), feat(12, ['src/b/'])], [], digests);
    assert.ok(!codes(c).includes('UNKNOWN_SCOPE'), JSON.stringify(c.problems));
  });
}

test('UNKNOWN_SCOPE messages no longer mention glob or root', () => {
  const p = editScopeProblems(['../x'], 'editScope');
  assert.equal(p.length, 1);
  assert.doesNotMatch(p[0]!.message, /glob|root/);
  const c = validateWavePlan(planOf([[11, 1], [12, 2]]), [feat(11, ['/x']), feat(12, ['src/b/'])], [], digests);
  assert.doesNotMatch(c.problems.find(x => x.code === 'UNKNOWN_SCOPE')!.message, /glob|root/);
});

// ---- glob / root overlap --------------------------------------------------------------------------

const sameWave = (a: readonly string[], b: readonly string[], contents?: (s: string) => readonly string[]) => validateWavePlan(planOf([[11, 1], [12, 1]]), [feat(11, [...a]), feat(12, [...b])], [], digests, contents);
const conflict = (c: {problems: {code: string; message: string}[]}) => c.problems.find(p => p.code === 'EDIT_CONFLICT');

for (const [label, a, b] of [
  ['a glob and a disjoint directory', ['src/a/**/*.ts'], ['lib/b/']],
  ['a glob and a disjoint glob', ['src/a/**/*.ts'], ['lib/**/*.ts']],
  ['two globs with different extensions', ['src/**/*.ts'], ['src/**/*.css']],
  ['nested globs with different extensions', ['src/**/*.ts'], ['src/ui/*.css']],
] as const) {
  test(`same Wave with ${label} passes`, () => {
    const c = sameWave(a, b);
    assert.equal(c.passed, true, JSON.stringify(c.problems));
  });
}

for (const [label, a, b] of [
  ['src/** and src/a.ts', ['src/**'], ['src/a.ts']],
  ['src/*.ts and src/**', ['src/*.ts'], ['src/**']],
  ['src/** and its own directory', ['src/**'], ['src']],
  ['a directory above a glob', ['src'], ['src/ui/**/*.ts']],
  ['the same glob', ['src/**/*.ts'], ['src/**/*.ts']],
  ['suffixes that end with each other', ['src/**/*.ts'], ['src/**/*.d.ts']],
  ['a brace glob and a literal it matches', ['src/{a,b}.ts'], ['src/b.ts']],
  ['case-folded glob and literal', ['SRC/*.TS'], ['src/a.ts']],
  ['root and a file', ['.'], ['docs/x.md']],
  ['root slash and a glob', ['./'], ['docs/**/*.md']],
  ['** and a file', ['**'], ['docs/x.md']],
] as const) {
  test(`same Wave with ${label} conflicts`, () => {
    const c = sameWave(a, b);
    assert.equal(c.passed, false, JSON.stringify(c.problems));
    assert.ok(conflict(c), JSON.stringify(c.problems));
  });
}

test('a literal under a glob prefix that does not match is disjoint only when the repository shows it is a file', () => {
  const file = (s: string) => s === 'src/styles/a.css' ? ['src/styles/a.css'] : [];
  assert.equal(sameWave(['src/**/*.ts'], ['src/styles/a.css'], file).passed, true, 'a non-matching file is disjoint');
  assert.ok(conflict(sameWave(['src/**/*.ts'], ['src/styles/a.css'])), 'unknown on disk: it may be a directory holding matches');
  const dir = (s: string) => s === 'src/styles' ? ['src/styles/a.css', 'src/styles/b.ts'] : [];
  assert.ok(conflict(sameWave(['src/**/*.ts'], ['src/styles'], dir)), 'a directory under the prefix may hold matches');
  const inDir = (s: string) => s === 'src/a.d/x.ts' ? ['src/a.d/x.ts'] : [];
  assert.ok(conflict(sameWave(['src/*.d'], ['src/a.d/x.ts'], inDir)), 'a glob matching a directory covers what it holds');
});

test('glob scopes count shared manifests/state they may touch', () => {
  const lock = (s: string) => s === 'pnpm-lock.yaml' ? ['pnpm-lock.yaml'] : [];
  const m = sameWave(['**/package.json'], ['pnpm-lock.yaml'], lock);
  assert.equal(m.passed, false);
  assert.match(conflict(m)!.message, /manifests/);
  assert.ok(conflict(sameWave(['packages/*/package.json'], ['tools/x/Cargo.toml'])), 'manifest by name');
  assert.ok(conflict(sameWave(['config/*.json'], ['tsconfig.json'])), 'an extension glob can match a manifest');
  assert.ok(conflict(sameWave(['tools/x*'], ['package.json'])), 'a free-form manifest name (x.csproj)');
  const existing = (s: string) => s === 'packages/*-ui' ? ['packages/web-ui/package.json'] : s === 'packages/b/package.json' ? [s] : [];
  assert.ok(conflict(sameWave(['packages/*-ui'], ['packages/b/package.json'], existing)), 'an existing manifest the glob covers');
  assert.equal(sameWave(['packages/*-ui'], ['packages/b/package.json'], s => s === 'packages/b/package.json' ? [s] : []).passed, true, 'no manifest under the glob');
  assert.match(conflict(sameWave(['db/**/*.sql'], ['prisma/migrations/1.sql']))!.message, /state/);
  assert.ok(conflict(sameWave(['db/*/*.sql'], ['prisma/migrations/'])), 'a glob segment can match migrations');
  assert.match(conflict(sameWave(['.github/**'], ['ops/migrations/']))!.message, /state/, 'workflows');
  const sql = (s: string) => s === 'db/migrations/1.sql' ? ['db/migrations/1.sql'] : [];
  assert.match(conflict(sameWave(['*.md'], ['db/migrations/1.sql'], sql))!.message, /state/, 'a root-level glob can touch state');
  assert.ok(conflict(sameWave(['.'], ['package.json'])), 'root touches everything');
  assert.equal(sameWave(['src/**/*.ts'], ['lib/**/*.css']).passed, true, 'ordinary globs stay parallel');
});

test('readScopeContents lists each scope once at its literal prefix (the repository root as ".") and filters globs', async () => {
  const listed: string[] = [];
  const files: Record<string, string[]> = {
    '.': ['README.md', 'docs/a.md', '.github/workflows/ci.yml', 'src/a.ts'],
    src: ['src/a.ts', 'src/ui/b.ts', 'src/ui/c.css', 'src/a.d/x.css'],
    'src/a.ts': ['src/a.ts'],
  };
  const tree = await readScopeContents([['src/**/*.ts', 'src/a.ts', '.'], ['./src//**/*.ts', '**/*.yml', 'src/*.d', '../bad']], async path => { listed.push(path); return files[path]; });
  assert.deepEqual([...listed].sort(), ['.', 'src', 'src/a.ts'], 'each listing path is read once');
  assert.deepEqual(tree.get('src/**/*.ts'), ['src/a.ts', 'src/ui/b.ts']);
  assert.deepEqual(tree.get('src/a.ts'), ['src/a.ts']);
  assert.deepEqual(tree.get('.'), files['.']);
  assert.deepEqual(tree.get('**/*.yml'), ['.github/workflows/ci.yml']);
  assert.deepEqual(tree.get('src/*.d'), ['src/a.d/x.css']);
  assert.equal(tree.has('../bad'), false);
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

// ---- review follow-ups --------------------------------------------------------------------------

for (const [label, a, b] of [
  ['case difference', ['src/A.ts'], ['src/a.ts']],
  ['manifest case difference', ['Package.json'], ['package.json']],
  ['NFC/NFD', ['docs/café.md'], ['docs/café.md']],
  ['go.work.sum in different places', ['a/go.work.sum'], ['b/go.work.sum']],
  ['.npmrc and yarn config', ['.npmrc'], ['tools/.yarnrc.yml']],
  ['NuGet and flake lockfiles', ['src/App/packages.lock.json'], ['flake.lock']],
] as const) {
  test(`same Wave with ${label} conflicts`, () => {
    const c = validateWavePlan(planOf([[11, 1], [12, 1]]), [feat(11, [...a]), feat(12, [...b])], [], digests);
    assert.equal(c.passed, false, JSON.stringify(c.problems));
  });
}

for (const [label, scope] of [['trailing dot', ['src/a.']], ['zero-width', ['src/x.ts​']], ['control char', ['src/\u0007x']], ['trailing space segment', ['src/a /b']]] as const) {
  test(`an undecidable scope (${label}) never passes`, () => {
    const c = validateWavePlan(planOf([[11, 1], [12, 2]]), [feat(11, [...scope]), feat(12, ['src/b/'])], [], digests);
    assert.ok(codes(c).includes('UNKNOWN_SCOPE'), JSON.stringify(c.problems));
  });
}

test('a directory scope counts the manifests/state it contains (from the repository)', () => {
  const contents = (scope: string) => scope === 'packages/a' ? ['packages/a/package.json', 'packages/a/src/x.ts'] : scope === 'db' ? ['db/migrations/001.sql'] : [];
  const pkg = validateWavePlan(planOf([[11, 1], [12, 1]]), [feat(11, ['packages/a/']), feat(12, ['packages/b/package.json'])], [], digests, contents);
  assert.equal(pkg.passed, false, 'a directory holding package.json touches a shared manifest');
  const state = validateWavePlan(planOf([[11, 1], [12, 1]]), [feat(11, ['db']), feat(12, ['prisma/migrations/1.sql'])], [], digests, contents);
  assert.equal(state.passed, false);
  const plain = validateWavePlan(planOf([[11, 1], [12, 1]]), [feat(11, ['src/a/']), feat(12, ['src/b/'])], [], digests, contents);
  assert.equal(plain.passed, true, 'ordinary directories stay parallel');
});

test('any Wave-like label counts toward "one Wave label"', () => {
  const plan = planOf([[11, 1]]) as unknown as WavePlan;
  for (const extra of ['Wave2', 'Waves: 3', 'wave_1', 'WAVE-4']) {
    const p = checkWaveLabels(plan, [feat(11, [], ['Wave: 1', extra])]);
    assert.deepEqual(p.map(x => x.code), ['WAVE_LABEL_MULTIPLE'], extra);
  }
});
