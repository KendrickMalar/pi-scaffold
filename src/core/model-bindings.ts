// Owner policy (<scaffoldDir>/policy.json; default <agentDir>/pi-scaffold): per-repo allowed model tuples and auth mode.
// Only provider/id/thinking are handled; no model descriptors, auth.json or settings.json are read or changed.
import {join} from 'node:path';
import {resolveScaffoldDir} from './scaffold-dir.js';
import {StrictReader, AGENT_APPROVAL_KINDS, AGENT_DECISION_STAGES, QUESTION_BLOCKED_STAGES, THINKING_LEVELS, isRepoRef, failed, okValue, problem, type AgentApprovalKind, type AgentDecisionStage, type Decoded, type QuestionBlockedStage, type FeatureRole, type ModelBinding, type Problem, type ThinkingLevel} from './contracts.js';
import {OwnedFileError, readOwnedJson} from './files.js';

export const FEATURE_ROLES: readonly FeatureRole[] = ['coding-manager', 'coder', 'tester'];
export interface PolicyModel { model: string; thinking: ThinkingLevel; tier: 'basic' | 'upper'; roles: FeatureRole[] }
/**
 * `agentApprovals`: approvals the parent agent records itself (no dialog, any mode); never a subagent child.
 * `questionBlockedStages`: stages whose sessions never ask the human (only specification asks).
 * `agentDecisionStages` (older form, still read): implementation/verification sessions that neither ask nor wait for a
 * human approval. Absent fields mean none (`[]`).
 */
export interface RepoPolicy { authMode: 'file-backed'; models: PolicyModel[]; agentDecisionStages?: AgentDecisionStage[]; agentApprovals?: AgentApprovalKind[]; questionBlockedStages?: QuestionBlockedStage[] }
export interface OwnerPolicy { version: 1; repos: Record<string, RepoPolicy> }

/** A policy key is OWNER/REPO, or OWNER/* for every repository of exactly that owner. No other wildcard exists. */
const isPolicyKey = (k: string) => k.endsWith('/*') ? isRepoRef(k.slice(0, -1) + 'x') : isRepoRef(k);
/** The entry for a repository: an exact OWNER/REPO entry first, otherwise the owner's OWNER/* entry (owner compared case-insensitively). */
export function repoPolicyFor(policy: OwnerPolicy | undefined, repo: string): RepoPolicy | undefined {
  if (!policy) return undefined;
  if (Object.hasOwn(policy.repos, repo)) return policy.repos[repo];
  const owner = repo.split('/')[0]!.toLowerCase();
  const key = Object.keys(policy.repos).find(k => k.endsWith('/*') && k.slice(0, -2).toLowerCase() === owner);
  return key === undefined ? undefined : policy.repos[key];
}
/** True when the owner policy lets the parent agent record this kind of approval itself. */
export function repoAgentApproves(policy: OwnerPolicy | undefined, repo: string, kind: AgentApprovalKind): boolean {
  return (repoPolicyFor(policy, repo)?.agentApprovals ?? []).includes(kind);
}
/** Stages whose sessions never ask the human: questionBlockedStages plus the older agentDecisionStages. */
export function repoQuestionBlockedStages(policy: OwnerPolicy | undefined, repo: string): QuestionBlockedStage[] {
  const p = repoPolicyFor(policy, repo);
  return [...new Set([...(p?.questionBlockedStages ?? []), ...(p?.agentDecisionStages ?? [])])];
}

/** An optional list of distinct allowed values (undefined when absent). */
function uniqueList<T extends string>(r: StrictReader, value: unknown, path: string, allowed: readonly T[]): T[] | undefined {
  if (value === undefined) return undefined;
  const values = r.array(value, path, (s, q) => r.literal(s, q, allowed));
  if (Array.isArray(value) && value.length !== new Set(value).size) r.add('DUPLICATE_VALUE', path, 'Each value may appear once.');
  return values;
}

export function decodeOwnerPolicy(value: unknown): Decoded<OwnerPolicy> {
  const r = new StrictReader();
  const o = r.object(value, '', ['version', 'repos']);
  if (!o) return r.result(undefined as never);
  r.literal(o.version, 'version', [1] as const, 'UNKNOWN_VERSION');
  const repos: Record<string, RepoPolicy> = {};
  const raw = o.repos;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) r.add('INVALID_TYPE', 'repos', 'Expected an object keyed by OWNER/REPO or OWNER/*.');
  else for (const [repo, v] of Object.entries(raw)) {
    const p = `repos.${repo}`;
    if (!isPolicyKey(repo)) r.add('INVALID_FORMAT', p, 'Expected OWNER/REPO or OWNER/*.');
    const e = r.object(v, p, ['authMode', 'models'], ['agentDecisionStages', 'agentApprovals', 'questionBlockedStages']) ?? {};
    const authMode = r.literal(e.authMode, `${p}.authMode`, ['file-backed'] as const);
    const models = r.array(e.models, `${p}.models`, (m, q) => {
      const x = r.object(m, q, ['model', 'thinking', 'tier', 'roles']) ?? {};
      return {
        model: r.pattern(x.model, `${q}.model`, v => typeof v === 'string' && /^[^/\s]+\/[^\s]+$/.test(v), 'provider/id'),
        thinking: r.literal(x.thinking, `${q}.thinking`, THINKING_LEVELS), tier: r.literal(x.tier, `${q}.tier`, ['basic', 'upper'] as const),
        roles: r.array(x.roles, `${q}.roles`, (role, rp) => r.literal(role, rp, FEATURE_ROLES)),
      };
    });
    const set = <T extends string>(key: string, allowed: readonly T[]) => uniqueList(r, e[key], `${p}.${key}`, allowed);
    const stages = set('agentDecisionStages', AGENT_DECISION_STAGES), approvals = set('agentApprovals', AGENT_APPROVAL_KINDS), blocked = set('questionBlockedStages', QUESTION_BLOCKED_STAGES);
    repos[repo] = {authMode, models, ...(stages ? {agentDecisionStages: stages} : {}), ...(approvals ? {agentApprovals: approvals} : {}), ...(blocked ? {questionBlockedStages: blocked} : {})};
  }
  return r.result({version: 1, repos});
}

/**
 * The agent policy sidecar (<scaffoldDir>/policy.agent.json): `agentApprovals` and `questionBlockedStages` per policy key.
 * It lives beside policy.json so that policy.json keeps the older form, which earlier pi-scaffold versions still accept;
 * only this version reads the sidecar. An entry adds to the policy.json entry of exactly the same key and nothing else.
 */
export interface AgentPolicySidecar { version: 1; repos: Record<string, Pick<RepoPolicy, 'agentApprovals' | 'questionBlockedStages'>> }
export function decodeAgentPolicy(value: unknown): Decoded<AgentPolicySidecar> {
  const r = new StrictReader();
  const o = r.object(value, '', ['version', 'repos']);
  if (!o) return r.result(undefined as never);
  r.literal(o.version, 'version', [1] as const, 'UNKNOWN_VERSION');
  const repos: AgentPolicySidecar['repos'] = {};
  const raw = o.repos;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) r.add('INVALID_TYPE', 'repos', 'Expected an object keyed by OWNER/REPO or OWNER/*.');
  else for (const [repo, v] of Object.entries(raw)) {
    const p = `repos.${repo}`;
    if (!isPolicyKey(repo)) r.add('INVALID_FORMAT', p, 'Expected OWNER/REPO or OWNER/*.');
    const e = r.object(v, p, [], ['agentApprovals', 'questionBlockedStages']) ?? {};
    const approvals = uniqueList(r, e.agentApprovals, `${p}.agentApprovals`, AGENT_APPROVAL_KINDS), blocked = uniqueList(r, e.questionBlockedStages, `${p}.questionBlockedStages`, QUESTION_BLOCKED_STAGES);
    repos[repo] = {...(approvals ? {agentApprovals: approvals} : {}), ...(blocked ? {questionBlockedStages: blocked} : {})};
  }
  return r.result({version: 1, repos});
}
const union = <T>(a: readonly T[] | undefined, b: readonly T[] | undefined): T[] | undefined => a || b ? [...new Set([...(a ?? []), ...(b ?? [])])] : undefined;
/** policy.json plus the sidecar, merged per identical key (lists are united). */
export function mergeAgentPolicy(policy: OwnerPolicy, sidecar: AgentPolicySidecar | undefined): OwnerPolicy {
  if (!sidecar) return policy;
  const repos: Record<string, RepoPolicy> = {};
  for (const [key, entry] of Object.entries(policy.repos)) {
    const extra = Object.hasOwn(sidecar.repos, key) ? sidecar.repos[key]! : {};
    const approvals = union(entry.agentApprovals, extra.agentApprovals), blocked = union(entry.questionBlockedStages, extra.questionBlockedStages);
    repos[key] = {...entry, ...(approvals ? {agentApprovals: approvals} : {}), ...(blocked ? {questionBlockedStages: blocked} : {})};
  }
  return {version: 1, repos};
}

export async function loadOwnerPolicy(agentDir: string, scaffoldDir?: string): Promise<Decoded<OwnerPolicy | undefined>> {
  let root: string;
  const read = async (name: string) => readOwnedJson(join(root, name), {root, maxBytes: 64 * 1024});
  try {
    root = resolveScaffoldDir({PI_SCAFFOLD_DIR: scaffoldDir}, agentDir);
    const policy = decodeOwnerPolicy(await read('policy.json'));
    if (!policy.ok) return policy;
    let sidecar: Decoded<AgentPolicySidecar> | undefined;
    try { sidecar = decodeAgentPolicy(await read('policy.agent.json')); }
    catch (e) { if (!(e instanceof OwnedFileError && e.code === 'NOT_FOUND')) throw Object.assign(e as Error, {file: 'policy.agent.json'}); }
    if (sidecar && !sidecar.ok) return failed(sidecar.problems.map(p => ({...p, path: `policy.agent.json${p.path ? '.' + p.path : ''}`})));
    return okValue(mergeAgentPolicy(policy.value, sidecar?.value));
  }
  catch (e) {
    if (e instanceof OwnedFileError && e.code === 'NOT_FOUND' && !(e as {file?: string}).file) return okValue(undefined);
    return failed([problem(e instanceof OwnedFileError ? e.code : 'POLICY_INVALID', (e as {file?: string}).file ?? 'policy.json', (e as Error).message)]);
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
  const repo = repoPolicyFor(input.policy, input.repo);
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
