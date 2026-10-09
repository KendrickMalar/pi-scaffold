// RepoContext is derived from the environment only: cwd's worktree, origin, Pi project trust,
// the session's pi-profile snapshot and the owner policy. Tool input cannot supply trust/account/profile.
import {isAbsolute, join} from 'node:path';
import {failed, okValue, problem, isUuid, type Decoded, type RepoContext, type Sha256} from './contracts.js';
import {sha256Text, taggedDigest} from './digests.js';
import {repoPolicyFor, type OwnerPolicy} from './model-bindings.js';
import {parseGithubRemote, type GitReader} from '../ports/git-read.js';

export function resolveAgentDir(env: Record<string, string | undefined>, home: string): string {
  const v = env.PI_CODING_AGENT_DIR;
  return v && isAbsolute(v) ? v : join(home, '.pi', 'agent');
}

/**
 * pi-profile has no public API; it stores `startup-profile-state` custom entries ({version,id,label,instructions}).
 * This read-only decoder mirrors its validation. Conflicting snapshots are invalid.
 */
export const PROFILE_ENTRY_TYPE = 'startup-profile-state';
export function readProfileSnapshot(entries: readonly unknown[]): {snapshot?: {id: string; instructionsDigest: Sha256}; invalid: boolean} {
  let found: {id: string; instructions: string} | undefined;
  for (const value of entries) {
    if (!value || typeof value !== 'object') continue;
    const e = value as Record<string, unknown>;
    if (e.customType !== PROFILE_ENTRY_TYPE) continue;
    const d = e.data as Record<string, unknown> | null;
    if (e.type !== 'custom' || !d || d.version !== 1 || typeof d.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(d.id) || typeof d.label !== 'string' || typeof d.instructions !== 'string') return {invalid: true};
    if (found && (found.id !== d.id || found.instructions !== d.instructions)) return {invalid: true};
    found = {id: d.id, instructions: d.instructions};
  }
  return found ? {snapshot: {id: found.id, instructionsDigest: sha256Text(found.instructions)}, invalid: false} : {invalid: false};
}

export function repoHash(repo: string): string { return sha256Text(repo.toLowerCase()).slice(0, 32); }

export interface RepoContextInput {
  cwd: string; repo: string; workflowId: string | null; trusted: boolean;
  agentDir: string; agentDirRealpath: string; sessionEntries: readonly unknown[];
  policy: OwnerPolicy | undefined; git: GitReader;
}
export async function deriveRepoContext(input: RepoContextInput): Promise<Decoded<RepoContext>> {
  if (input.workflowId !== null && !isUuid(input.workflowId)) return failed([problem('INVALID_FORMAT', 'workflowId', 'workflowId must be a UUID.')]);
  if (!input.trusted) return failed([problem('UNTRUSTED_PROJECT', 'cwd', 'Pi project trust is not active for this working directory.')]);
  let identity: Awaited<ReturnType<GitReader["repoIdentity"]>>;
  try { identity = await input.git.repoIdentity(input.cwd); } catch { return failed([problem('NOT_A_WORKTREE', 'cwd', 'The working directory is not inside a git worktree.')]); }
  const origin = parseGithubRemote(identity.origin);
  if (!origin || origin.toLowerCase() !== input.repo.toLowerCase()) return failed([problem('ORIGIN_MISMATCH', 'repo', `origin (${origin ?? 'none'}) does not match ${input.repo}.`)]);
  const profile = readProfileSnapshot(input.sessionEntries);
  if (profile.invalid) return failed([problem('PROFILE_INVALID', 'profile', 'The session holds an invalid or conflicting pi-profile snapshot.')]);
  const authMode = repoPolicyFor(input.policy, input.repo)?.authMode;
  return okValue({
    repo: input.repo, repoRoot: identity.repoRoot, gitCommonDir: identity.gitCommonDir,
    workflowStateRoot: join(input.agentDir, 'pi-scaffold', 'state', repoHash(input.repo), input.workflowId ?? '_repo'),
    accountBinding: authMode === 'file-backed' ? taggedDigest('account-binding', {agentDir: input.agentDirRealpath, authMode}) : null,
    profileId: profile.snapshot?.id ?? null, profileInstructionsDigest: profile.snapshot?.instructionsDigest ?? null,
  });
}
