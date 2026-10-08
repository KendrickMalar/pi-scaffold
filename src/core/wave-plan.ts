// #13 Wave plan validation (pure, read-only). Every Feature (closed included) gets exactly one Wave 1–200; a dependency
// from→to needs wave(from) < wave(to); Features sharing a Wave must not overlap in what they edit. Undecidable edit
// scopes never count as parallel-safe.
import {StrictReader, problem, readWavePlan, type Problem, type WaveCheck, type WavePlan, type Sha256} from './contracts.js';

export interface WaveFeature { issue: number; featureKey: string; editScope: readonly string[]; labels: readonly string[] }
export interface WaveEdge { from: number; to: number }

/**
 * Repo-relative, slash-normalized path without a trailing slash; undefined when it cannot be judged safely
 * (globs, absolute, "..", control/zero-width characters, segments ending in a dot or space).
 */
export function normalizeScope(raw: string): string | undefined {
  if (typeof raw !== 'string' || !raw.trim() || /[\\*?[\]{}]/.test(raw) || raw.startsWith('/') || /[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202f\u2060\ufeff]/.test(raw)) return undefined;
  const parts = raw.split('/').filter(p => p !== '' && p !== '.');
  if (!parts.length || parts.includes('..') || parts.some(p => /[.\s]$/.test(p) || /^\s/.test(p))) return undefined;
  return parts.join('/');
}
/** Comparison form: case-folded NFC (macOS/Windows file systems are case-insensitive; NFC/NFD name the same file). */
const fold = (p: string) => p.normalize('NFC').toLowerCase();
const overlaps = (a: string, b: string) => { const x = fold(a), y = fold(b); return x === y || x.startsWith(y + '/') || y.startsWith(x + '/'); };

/** Files every package/manifest change touches together (shared lockfiles), and shared state. */
const MANIFEST = /^(\.npmrc|\.yarnrc(\.yml)?|go\.work\.sum|flake\.(nix|lock)|packages\.lock\.json|directory\.(packages|build)\.props|.+\.(csproj|fsproj|vbproj)|package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|deno\.jsonc?|deno\.lock|tsconfig(\..+)?\.json|Cargo\.(toml|lock)|go\.(mod|sum|work)|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(\.lock)?|requirements(-.+)?\.txt|setup\.(py|cfg)|Gemfile(\.lock)?|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.lockfile|Package\.(swift|resolved)|mix\.(exs|lock)|pubspec\.(yaml|lock))$/i;
const isState = (raw: string) => { const p = fold(raw); return p.split('/').some(s => s === 'migrations' || s === 'migrate') || p === '.github/workflows' || p.startsWith('.github/workflows/') || /(^|\/)(schema\.(prisma|sql|rb|graphql)|structure\.sql)$/.test(p); };
const kindOf = (p: string): 'manifest' | 'state' | undefined => MANIFEST.test(p.split('/').at(-1)!) ? 'manifest' : isState(p) ? 'state' : undefined;

/** Files inside a scope as the repository has them (a file scope may return itself or nothing). */
export type ScopeContents = (scope: string) => readonly string[];

export function validateWavePlan(rawPlan: unknown, features: readonly WaveFeature[], edges: readonly WaveEdge[], digests: {featureSetDigest: Sha256; dependencyDigest: Sha256}, contents: ScopeContents = () => []): WaveCheck {
  const checks: string[] = [], problems: Problem[] = [];
  if (rawPlan === null || rawPlan === undefined) return {passed: false, checks, problems: [problem('PLAN_UNSET', 'wavePlan', 'No Wave plan is set yet (it is filled in during basic design).')]};
  const r = new StrictReader();
  const plan = readWavePlan(r, rawPlan, 'plan');
  const decoded = r.result(plan);
  if (!decoded.ok) return {passed: false, checks, problems: decoded.problems};
  checks.push('plan-format');
  if (plan.featureSetDigest !== digests.featureSetDigest) problems.push(problem('FEATURE_SET_CHANGED', 'plan.featureSetDigest', 'The plan was made for a different Feature set.'));
  if (plan.dependencyDigest !== digests.dependencyDigest) problems.push(problem('DEPENDENCIES_CHANGED', 'plan.dependencyDigest', 'The plan was made for a different dependency plan.'));
  checks.push('digests');
  const wave = new Map<number, number>();
  const known = new Set(features.map(f => f.issue));
  plan.assignments.forEach((a, i) => {
    if (!known.has(a.issue)) problems.push(problem('UNKNOWN_FEATURE', `plan.assignments[${i}]`, `#${a.issue} is not a Feature of this Epic.`));
    else if (wave.has(a.issue)) problems.push(problem('DUPLICATE_ASSIGNMENT', `plan.assignments[${i}]`, `#${a.issue} is assigned twice.`));
    else wave.set(a.issue, a.wave);
  });
  for (const f of features) if (!wave.has(f.issue)) problems.push(problem('UNASSIGNED_FEATURE', `features[#${f.issue}]`, `${f.featureKey} (#${f.issue}) has no Wave.`));
  checks.push('assignments');
  for (const e of edges) {
    const wf = wave.get(e.from), wt = wave.get(e.to);
    if (wf !== undefined && wt !== undefined && wf >= wt) problems.push(problem('DEPENDENCY_ORDER', 'plan.assignments', `#${e.from} → #${e.to} needs wave(#${e.from}) < wave(#${e.to}) (now ${wf} and ${wt}).`));
  }
  checks.push('dependency-order');
  const scopes = new Map<number, string[]>();
  for (const f of features) {
    const norm = f.editScope.map(normalizeScope);
    if (!f.editScope.length || norm.some(s => s === undefined)) problems.push(problem('UNKNOWN_SCOPE', `features[#${f.issue}].editScope`, `${f.featureKey}'s edit scope cannot be judged (empty, root, glob, absolute or ".."); it is never treated as parallel-safe.`));
    else scopes.set(f.issue, norm as string[]);
  }
  const byWave = new Map<number, number[]>();
  for (const [issue, w] of wave) byWave.set(w, [...(byWave.get(w) ?? []), issue]);
  for (const [w, issues] of byWave) {
    for (let i = 0; i < issues.length; i++) for (let j = i + 1; j < issues.length; j++) {
      const a = scopes.get(issues[i]!), b = scopes.get(issues[j]!);
      if (!a || !b) continue;
      const path = a.flatMap(x => b.filter(y => overlaps(x, y)).map(y => `${x} / ${y}`))[0];
      // A directory scope touches whatever shared files it holds in the repository.
      const touches = (scope: string[], k: 'manifest' | 'state') => scope.some(x => kindOf(x) === k || contents(x).some(f => kindOf(f) === k));
      const shared = (['manifest', 'state'] as const).find(k => touches(a, k) && touches(b, k));
      if (path || shared) problems.push(problem('EDIT_CONFLICT', `wave ${w}`, `#${issues[i]} and #${issues[j]} share Wave ${w} but ${path ? `edit overlapping paths (${path})` : `both change shared ${shared === 'manifest' ? 'manifests/lockfiles' : 'state (migrations, workflows, schema)'}`}.`));
    }
  }
  checks.push('edit-conflicts');
  return {passed: problems.length === 0, checks, problems};
}

/** Labels must show exactly one canonical "Wave: N" per Feature, equal to its assignment. */
export function checkWaveLabels(plan: WavePlan, features: readonly WaveFeature[]): Problem[] {
  const problems: Problem[] = [];
  const wave = new Map(plan.assignments.map(a => [a.issue, a.wave]));
  for (const f of features) {
    const waveLike = f.labels.filter(l => /^\s*waves?(\b|[0-9:_\-\s])/i.test(l));
    const at = `features[#${f.issue}].labels`;
    if (!waveLike.length) { problems.push(problem('WAVE_LABEL_MISSING', at, `#${f.issue} has no Wave label.`)); continue; }
    if (waveLike.length > 1) { problems.push(problem('WAVE_LABEL_MULTIPLE', at, `#${f.issue} has several Wave labels (${waveLike.join(', ')}).`)); continue; }
    const m = /^Wave: ([1-9][0-9]{0,2})$/.exec(waveLike[0]!);
    if (!m || Number(m[1]) > 200) { problems.push(problem('WAVE_LABEL_NONCANONICAL', at, `#${f.issue} has "${waveLike[0]}"; the canonical form is "Wave: N".`)); continue; }
    if (wave.get(f.issue) !== Number(m[1])) problems.push(problem('WAVE_LABEL_MISMATCH', at, `#${f.issue} is labeled ${waveLike[0]} but the plan says Wave ${wave.get(f.issue) ?? '(none)'}.`));
  }
  return problems;
}

/** Canonical form of a plan for digests and storage: assignments ordered by Issue number. */
export function canonicalWavePlan(plan: WavePlan): WavePlan {
  return {...plan, assignments: [...plan.assignments].sort((x, y) => x.issue - y.issue)};
}
