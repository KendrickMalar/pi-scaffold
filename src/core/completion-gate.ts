// #16 completion gate: the specification is complete, every requirement is covered by Feature criteria whose final
// evidence passed, and the verified commit is contained in origin's default branch. Git access is read-only
// (rev-parse/cat-file/merge-base and ls-remote to the matching origin); nothing is fetched, merged or pushed.
import {problem, type EpicDocV1, type EvidenceReportV1, type FeatureSnapshot, type GateResult, type GitObjectId, type Problem, type Sha256} from './contracts.js';
import {checkSpecificationReady} from './specification-gate.js';
import {checkFeatureIntegration} from './evidence.js';
import {designDigest, specificationDigest, taggedDigest} from './digests.js';
import type {GitReader} from '../ports/git-read.js';
import type {ApprovalView} from './approvals.js';

export interface CompletionResult extends GateResult { verifiedRef: GitObjectId; remoteMainRef: GitObjectId | null; defaultBranch: string | null }

/** origin's default branch and its commit, as origin reports it (`git ls-remote --symref origin HEAD`). */
export async function readRemoteDefault(git: GitReader, repoRoot: string): Promise<{branch: string; sha: string} | undefined> {
  const r = await git.run(['ls-remote', '--symref', 'origin', 'HEAD'], repoRoot);
  if (r.code !== 0) return undefined;
  const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(r.stdout)?.[1];
  const sha = /^([0-9a-f]{40}|[0-9a-f]{64})\tHEAD$/m.exec(r.stdout)?.[1];
  return branch && sha ? {branch, sha} : undefined;
}

export async function checkCompletion(input: {epic: EpicDocV1; features: readonly FeatureSnapshot[]; reports: readonly EvidenceReportV1[]; verifiedRef: GitObjectId; git: GitReader; repoRoot: string}): Promise<CompletionResult> {
  const {epic, features, verifiedRef, git, repoRoot} = input;
  const problems: Problem[] = [...checkSpecificationReady(epic).problems];
  const covered = new Set(features.flatMap(f => f.doc.criteria.flatMap(c => c.requirementIds)));
  for (const r of epic.requirements) if (!covered.has(r.id)) problems.push(problem('REQUIREMENT_UNCOVERED', `requirements.${r.id}`, `No Feature has an acceptance criterion for ${r.id}.`));
  // Final evidence: same rules as #15, with verifiedRef as the integration commit.
  const evidence = await checkFeatureIntegration({epic, features, reports: input.reports, integrationRef: verifiedRef, git, repoRoot});
  problems.push(...evidence.problems.map(p => p.path === 'integrationRef' ? {...p, path: 'verifiedRef'} : p));
  const remote = await readRemoteDefault(git, repoRoot);
  let remoteMainRef: string | null = null;
  if (!remote) problems.push(problem('REMOTE_UNREADABLE', 'origin', 'origin\'s default branch could not be read (git ls-remote --symref origin HEAD).'));
  else {
    remoteMainRef = remote.sha;
    const local = await git.run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${remote.sha}^{commit}`], repoRoot);
    if (local.code !== 0) problems.push(problem('REMOTE_REF_NOT_LOCAL', 'origin', `origin/${remote.branch} is at ${remote.sha}, which is not in the local repository. Please run "git fetch origin" yourself and call again (nothing is fetched here).`));
    else if (verifiedRef !== remote.sha && (await git.run(['merge-base', '--is-ancestor', verifiedRef, remote.sha], repoRoot)).code !== 0) problems.push(problem('NOT_IN_DEFAULT_BRANCH', 'verifiedRef', `${verifiedRef} is not contained in origin/${remote.branch} (${remote.sha}).`));
  }
  return {status: problems.length ? 'blocked' : 'validated', problems, artifactDigests: {}, verifiedRef, remoteMainRef, defaultBranch: remote?.branch ?? null};
}

/** The parent's final acceptance: this specification/design/Feature set/evidence at these exact refs. */
export function completionApprovalView(epic: EpicDocV1, featureSetDigest: Sha256, evidence: readonly {relativePath: string; sha256: Sha256}[], result: CompletionResult): ApprovalView {
  const contentDigest = taggedDigest('epic-completion', {
    specification: specificationDigest(epic), design: designDigest(epic), featureSet: featureSetDigest,
    evidence: [...evidence].sort((a, b) => a.relativePath < b.relativePath ? -1 : 1), verifiedRef: result.verifiedRef, remoteMainRef: result.remoteMainRef, defaultBranch: result.defaultBranch,
  });
  const text = [
    'Epic の最終受け入れ',
    `検証済みコミット: ${result.verifiedRef}`,
    `origin/${result.defaultBranch}: ${result.remoteMainRef}（検証済みコミットを含む）`,
    `要件: ${epic.requirements.map(r => r.id).join(', ')}`,
    `証拠: ${evidence.length} 件（参照とハッシュのみ確認。内容の真正性は保証しません）`,
    '受け入れると、Epic の本文と Stage を完了にし、Issue を閉じます（指定があれば Project を Done にします）。',
  ].join('\n');
  return {contentDigest, text};
}
