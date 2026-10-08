// Owner policy ($PI_CODING_AGENT_DIR/pi-scaffold/policy.json): per-repo allowed model tuples and auth mode.
// Only provider/id/thinking are handled; no model descriptors, auth.json or settings.json are read or changed.
import {join} from 'node:path';
import {StrictReader, THINKING_LEVELS, isRepoRef, failed, okValue, problem, type Decoded, type FeatureRole, type ModelBinding, type Problem, type ThinkingLevel} from './contracts.js';
import {OwnedFileError, readOwnedJson} from './files.js';

export const FEATURE_ROLES: readonly FeatureRole[] = ['coding-manager', 'coder', 'tester'];
export interface PolicyModel { model: string; thinking: ThinkingLevel; tier: 'basic' | 'upper'; roles: FeatureRole[] }
export interface RepoPolicy { authMode: 'file-backed'; models: PolicyModel[] }
export interface OwnerPolicy { version: 1; repos: Record<string, RepoPolicy> }

export function decodeOwnerPolicy(value: unknown): Decoded<OwnerPolicy> {
  const r = new StrictReader();
  const o = r.object(value, '', ['version', 'repos']);
  if (!o) return r.result(undefined as never);
  r.literal(o.version, 'version', [1] as const, 'UNKNOWN_VERSION');
  const repos: Record<string, RepoPolicy> = {};
  const raw = o.repos;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) r.add('INVALID_TYPE', 'repos', 'Expected an object keyed by OWNER/REPO.');
  else for (const [repo, v] of Object.entries(raw)) {
    const p = `repos.${repo}`;
    if (!isRepoRef(repo)) r.add('INVALID_FORMAT', p, 'Expected OWNER/REPO.');
    const e = r.object(v, p, ['authMode', 'models']) ?? {};
    const authMode = r.literal(e.authMode, `${p}.authMode`, ['file-backed'] as const);
    const models = r.array(e.models, `${p}.models`, (m, q) => {
      const x = r.object(m, q, ['model', 'thinking', 'tier', 'roles']) ?? {};
      return {
        model: r.pattern(x.model, `${q}.model`, v => typeof v === 'string' && /^[^/\s]+\/[^\s]+$/.test(v), 'provider/id'),
        thinking: r.literal(x.thinking, `${q}.thinking`, THINKING_LEVELS), tier: r.literal(x.tier, `${q}.tier`, ['basic', 'upper'] as const),
        roles: r.array(x.roles, `${q}.roles`, (role, rp) => r.literal(role, rp, FEATURE_ROLES)),
      };
    });
    repos[repo] = {authMode, models};
  }
  return r.result({version: 1, repos});
}

export async function loadOwnerPolicy(agentDir: string): Promise<Decoded<OwnerPolicy | undefined>> {
  const root = join(agentDir, 'pi-scaffold');
  try { return decodeOwnerPolicy(await readOwnedJson(join(root, 'policy.json'), {root, maxBytes: 64 * 1024})); }
  catch (e) {
    if (e instanceof OwnedFileError && e.code === 'NOT_FOUND') return okValue(undefined);
    return failed([problem(e instanceof OwnedFileError ? e.code : 'POLICY_INVALID', 'policy.json', (e as Error).message)]);
  }
}

export interface BindingCheck {
  repo: string; bindings: Partial<Record<FeatureRole, ModelBinding>>; policy: OwnerPolicy | undefined;
  /** `provider/id` of models usable in this session (from Pi's model registry). */
  availableModels: readonly string[];
  /** Session scoped models; empty means no scoping is configured. */
  scopedModels: readonly string[];
  roles?: readonly FeatureRole[];
}
/** Basic-tier only in v1. Upper-tier tuples are rejected, never rewritten to basic. */
export function checkFeatureBindings(input: BindingCheck): Problem[] {
  const problems: Problem[] = [];
  if (!input.policy) return [problem('POLICY_MISSING', 'policy.json', 'No owner policy is configured; model bindings cannot be authorized.')];
  const repo = input.policy.repos[input.repo];
  if (!repo) return [problem('POLICY_REPO', 'policy.json', `Owner policy has no entry for ${input.repo}.`)];
  for (const role of input.roles ?? FEATURE_ROLES) {
    const b = input.bindings[role], path = `bindings.${role}`;
    if (!b) { problems.push(problem('REQUIRED', path, 'Binding is required.')); continue; }
    const tuple = repo.models.find(m => m.model === b.model && m.thinking === b.thinking);
    if (!tuple) { problems.push(problem('POLICY_MODEL', path, `${b.model}/${b.thinking} is not allowed by the owner policy.`)); continue; }
    if (!tuple.roles.includes(role)) problems.push(problem('POLICY_ROLE', path, `${b.model} is not allowed for ${role}.`));
    if (tuple.tier !== 'basic') problems.push(problem('UPPER_TIER_UNSUPPORTED', path, 'Only basic-tier bindings are supported in this version.'));
    if (!input.availableModels.includes(b.model)) problems.push(problem('MODEL_UNAVAILABLE', path, `${b.model} is not available in this session.`));
    if (input.scopedModels.length && !input.scopedModels.includes(b.model)) problems.push(problem('MODEL_NOT_SCOPED', path, `${b.model} is outside this session's scoped models.`));
  }
  return problems;
}
