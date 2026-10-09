// #15 scaffold_handoff_verification: implementation → verification only. Pins the integration commit and every native
// Feature's per-criterion evidence (owned files, hashes, refs in the integration history) into the handoff packet and
// hands the still-open Epic to a new verification session via #5. Runs no tests, closes nothing, accepts nothing.
import {decodeMutationInput, isGitObjectId, isSha256, problem, type Decoded, type EpicDocV1, type GitObjectId, type IssueSnapshot, type MutationInput, type OwnedEvidenceRef, type Problem, type ScaffoldResult} from '../core/contracts.js';
import {checkFeatureIntegration, evidenceRootOf, readEvidence} from '../core/evidence.js';
import {prepareLabelEdit} from '../core/label-policy.js';
import {committedByUs, handoffStage, type HandoffData, type StageGate} from '../handoff/driver.js';
import type {ToolCall} from '../core/runtime.js';
import {readIssue} from '../ports/pi-gh.js';
import {readFeatureSet} from '../ports/feature-set.js';

export const HANDOFF_VERIFICATION = 'scaffold_handoff_verification';
export type VerificationHandoffInput = MutationInput & {integrationRef: GitObjectId; evidenceRefs: OwnedEvidenceRef[]};
export type VerificationHandoffData = HandoffData & {testedOnIntegration: boolean; evidenceChecked: 'refs-and-hashes-only'};

export function decodeVerificationHandoffInput(value: unknown): Decoded<VerificationHandoffInput> {
  return decodeMutationInput<{integrationRef: GitObjectId; evidenceRefs: OwnedEvidenceRef[]}>(value, {
    integrationRef: {decode: (r, v, p) => r.pattern(v, p, isGitObjectId, 'a 40/64 hex commit id (not a branch or HEAD)')},
    evidenceRefs: {decode: (r, v, p) => {
      // Normalized relative paths without "@" so the pinned `evidence:<path>@sha256:<hex>` entry is unambiguous.
      const normalized = (x: unknown) => typeof x === 'string' && !x.includes('@') && !x.startsWith('/') && x.split('/').every(s => s !== '' && s !== '.' && s !== '..');
      const list = r.array(v, p, (x, q) => { const o = r.object(x, q, ['relativePath', 'sha256']) ?? {}; return {relativePath: r.pattern(o.relativePath, `${q}.relativePath`, normalized, 'a normalized path inside evidence/ without "@"'), sha256: r.pattern(o.sha256, `${q}.sha256`, isSha256, 'sha256')}; }, 50);
      if (Array.isArray(v) && !v.length) r.add('EMPTY', p, 'Give one report per Feature.');
      return list;
    }},
  });
}

export async function handoffVerification(input: VerificationHandoffInput, call: ToolCall): Promise<ScaffoldResult<VerificationHandoffData>> {
  const operation = HANDOFF_VERIFICATION;
  const blocked = (problems: Problem[]): ScaffoldResult<VerificationHandoffData> => ({status: 'blocked', operation, problems});
  const caps = await call.bridge.requireCapabilities(['gh_issue_get', 'gh_subissues_list', 'gh_issue_edit_if_current', 'gh_issue_labels_if_current'], call.scope);
  if (!caps.ok) return blocked(caps.problems);
  const repoOnly = await call.repoContext(input.repo, null);
  if (!repoOnly.ok) return blocked(repoOnly.problems);
  const snap = await readIssue(input.repo, input.epicIssue, call.bridge, call.scope);
  if (!snap.ok) return blocked(snap.problems);
  const doc = snap.value.doc;
  if (doc.kind !== 'epic') return blocked([problem('NOT_AN_EPIC', 'epicIssue', `#${input.epicIssue} is not a Scaffold Epic.`)]);
  const context = await call.repoContext(input.repo, doc.workflowId);
  if (!context.ok) return blocked(context.problems);
  const handoff = {...input, expectedStage: 'implementation' as const, nextStage: 'verification' as const};
  const evidenceRoot = evidenceRootOf(context.value.workflowStateRoot);
  let tested = false;
  const check = async (s: IssueSnapshot): Promise<Problem[]> => {
    const epic = s.doc as EpicDocV1;
    const set = await readFeatureSet(input.repo, input.epicIssue, call.bridge, call.scope, {workflowId: epic.workflowId});
    if (!set.ok) return set.problems;
    const ev = await readEvidence(input.evidenceRefs, evidenceRoot, call.namespaceRoot);
    const gate = await checkFeatureIntegration({epic, features: set.value.features, reports: ev.reports, integrationRef: input.integrationRef, git: call.runtime.git, repoRoot: repoOnly.value.repoRoot});
    tested = gate.testedOnIntegration;
    return [...ev.problems, ...gate.problems];
  };
  if (!(await committedByUs(snap.value, handoff, call.journal(context.value)))) {
    const env = call.environment();
    if (env.HERDR_ENV !== '1' || !env.HERDR_WORKSPACE_ID || !env.HERDR_PANE_ID) return blocked([problem('HERDR_UNAVAILABLE', 'herdr', 'This session is not running inside Herdr.')]);
    if (env.PI_SUBAGENT_CHILD) return blocked([problem('CHILD_SESSION', 'session', 'A subagent child cannot start a stage session.')]);
    if (doc.stage !== 'implementation') return blocked([problem('STAGE_MISMATCH', 'stage', `Epic is in ${doc.stage}, not implementation.`)]);
    const stale = [
      ...(snap.value.bodySha256 !== input.expectedBodySha256 ? [problem('STALE_BODY', 'expectedBodySha256', 'Epic body changed; read it again.')] : []),
      ...(doc.revision !== input.expectedRevision ? [problem('STALE_REVISION', 'expectedRevision', `Epic revision is ${doc.revision}.`)] : []),
    ];
    if (stale.length) return blocked(stale);
    const labels = prepareLabelEdit(snap.value, {type: 'Scaffold', scope: 'Epic', stage: 'verification'});
    if (!labels.ok) return blocked(labels.problems);
    const problems = await check(snap.value);
    if (problems.length) return blocked(problems);
  }
  // The evidence is checked again right before the stage commit (files and refs may change meanwhile).
  const gate: StageGate = async s => { const p = await check(s); return {status: p.length ? 'blocked' : 'validated', problems: p, artifactDigests: {}}; };
  const resourceRefs = [`integration:${input.integrationRef}`, ...input.evidenceRefs.map(r => `evidence:${r.relativePath}@sha256:${r.sha256}`)];
  const result = await handoffStage(handoff, gate, call, operation, {resourceRefs});
  if (result.status !== 'applied' && result.status !== 'noop') return result as ScaffoldResult<VerificationHandoffData>;
  // A resumed handoff skips the checks above; the answer comes from the pinned evidence either way.
  const pinned = await readEvidence(input.evidenceRefs, evidenceRoot, call.namespaceRoot);
  tested = !pinned.problems.length && pinned.reports.length > 0 && pinned.reports.every(r => r.productRef === input.integrationRef);
  return {...result, data: {...result.data!, testedOnIntegration: tested, evidenceChecked: 'refs-and-hashes-only'}};
}
