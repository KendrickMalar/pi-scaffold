// #15 evidence: per-Feature test reports and their logs, read only from the workflow's owned `evidence/` root
// (regular owner-only files; no symlinks, FIFOs or paths outside). Hashes and refs are checked; whether the reported
// results are true is never claimed — final acceptance stays with a human (#16).
import {join} from 'node:path';
import {
  LIMITS, StrictReader, isGitObjectId, isSha256, problem,
  type EpicDocV1, type EvidenceReportV1, type FeatureSnapshot, type GateResult, type GitObjectId, type OwnedEvidenceRef, type Problem,
} from './contracts.js';
import {sha256Bytes} from './digests.js';
import {parseStrictJson} from './body-codec.js';
import {OwnedFileError, ownedPath, readOwnedFile} from './files.js';
import type {GitReader} from '../ports/git-read.js';

const FILE_CODE: Record<string, string> = {OUTSIDE_ROOT: 'INVALID_PATH', NOT_FOUND: 'EVIDENCE_NOT_FOUND', SYMLINK: 'SYMLINK', NOT_REGULAR: 'NOT_REGULAR_FILE'};
async function readEvidenceFile(evidenceRoot: string, relativePath: string, namespaceRoot: string, path: string): Promise<Buffer | Problem> {
  try { return await readOwnedFile(ownedPath(evidenceRoot, relativePath), {root: namespaceRoot, maxBytes: LIMITS.artifactBytes}); }
  catch (e) {
    if (e instanceof OwnedFileError) return problem(FILE_CODE[e.code] ?? e.code, path, e.message);
    return problem('EVIDENCE_UNREADABLE', path, (e as Error).message);
  }
}

function decodeReport(value: unknown, path: string): EvidenceReportV1 | Problem[] {
  const r = new StrictReader();
  const o = r.object(value, path, ['version', 'workflowId', 'featureIssue', 'productRef', 'suiteRef', 'criteria']) ?? {};
  r.literal(o.version, `${path}.version`, [1] as const, 'UNKNOWN_VERSION');
  const report: EvidenceReportV1 = {
    version: 1, workflowId: r.text(o.workflowId, `${path}.workflowId`), featureIssue: r.int(o.featureIssue, `${path}.featureIssue`),
    productRef: r.pattern(o.productRef, `${path}.productRef`, isGitObjectId, 'a 40/64 hex commit id'), suiteRef: r.pattern(o.suiteRef, `${path}.suiteRef`, isGitObjectId, 'a 40/64 hex commit id'),
    criteria: r.array(o.criteria, `${path}.criteria`, (x, q) => {
      const c = r.object(x, q, ['id', 'status', 'command', 'exitCode', 'logPath', 'logSha256']) ?? {};
      return {id: r.stableId('AC', c.id, `${q}.id`), status: r.literal(c.status, `${q}.status`, ['pass', 'fail', 'unverified'] as const), command: r.text(c.command, `${q}.command`),
        exitCode: c.exitCode === null ? null : r.int(c.exitCode, `${q}.exitCode`, -1, 255), logPath: r.text(c.logPath, `${q}.logPath`), logSha256: r.pattern(c.logSha256, `${q}.logSha256`, isSha256, 'sha256')};
    }, LIMITS.criteria),
  };
  const d = r.result(report);
  return d.ok ? d.value : d.problems;
}

/** Reads and hash-checks every report and every log it names. */
export async function readEvidence(refs: readonly OwnedEvidenceRef[], evidenceRoot: string, namespaceRoot: string): Promise<{reports: EvidenceReportV1[]; problems: Problem[]}> {
  const reports: EvidenceReportV1[] = [], problems: Problem[] = [];
  for (const [i, ref] of refs.entries()) {
    const at = `evidenceRefs[${i}]`;
    const bytes = await readEvidenceFile(evidenceRoot, ref.relativePath, namespaceRoot, at);
    if (!Buffer.isBuffer(bytes)) { problems.push(bytes); continue; }
    if (sha256Bytes(bytes) !== ref.sha256) { problems.push(problem('REPORT_HASH_MISMATCH', at, `${ref.relativePath} does not match its sha256.`)); continue; }
    let json: unknown;
    try { json = parseStrictJson(bytes.toString('utf8')); } catch { problems.push(problem('INVALID_REPORT', at, `${ref.relativePath} is not valid JSON.`)); continue; }
    const report = decodeReport(json, at);
    if (Array.isArray(report)) { problems.push(...report); continue; }
    for (const [j, c] of report.criteria.entries()) {
      const log = await readEvidenceFile(evidenceRoot, c.logPath, namespaceRoot, `${at}.criteria[${j}].logPath`);
      if (!Buffer.isBuffer(log)) problems.push(log);
      else if (sha256Bytes(log) !== c.logSha256) problems.push(problem('LOG_HASH_MISMATCH', `${at}.criteria[${j}].logSha256`, `${c.logPath} does not match its sha256.`));
    }
    reports.push(report);
  }
  return {reports, problems};
}

/** Every native Feature (closed included) has exactly one report covering exactly its criteria, all passed with exit 0, on integrated refs. */
export async function checkFeatureIntegration(input: {epic: EpicDocV1; features: readonly FeatureSnapshot[]; reports: readonly EvidenceReportV1[]; integrationRef: GitObjectId; git: GitReader; repoRoot: string}): Promise<GateResult & {testedOnIntegration: boolean}> {
  const {epic, features, reports, integrationRef, git, repoRoot} = input;
  const problems: Problem[] = [];
  const exists = async (ref: string) => (await git.run(['cat-file', '-e', `${ref}^{commit}`], repoRoot)).code === 0;
  const integrated = async (ref: string) => ref === integrationRef || (await git.run(['merge-base', '--is-ancestor', ref, integrationRef], repoRoot)).code === 0;
  if (!(await exists(integrationRef))) problems.push(problem('REF_NOT_FOUND', 'integrationRef', `${integrationRef} is not a commit in the local repository.`));
  const byIssue = new Map<number, EvidenceReportV1>();
  for (const [i, r] of reports.entries()) {
    const at = `reports[#${r.featureIssue}]`;
    if (r.workflowId !== epic.workflowId) problems.push(problem('WORKFLOW_MISMATCH', at, 'The report belongs to another workflow.'));
    if (byIssue.has(r.featureIssue)) { problems.push(problem('DUPLICATE_REPORT', `evidenceRefs[${i}]`, `#${r.featureIssue} has more than one report.`)); continue; }
    byIssue.set(r.featureIssue, r);
    for (const [k, ref] of [['productRef', r.productRef], ['suiteRef', r.suiteRef]] as const) {
      if (!(await exists(ref))) problems.push(problem('REF_NOT_FOUND', `${at}.${k}`, `${ref} is not a commit in the local repository.`));
      else if (!(await integrated(ref))) problems.push(problem('REF_NOT_INTEGRATED', `${at}.${k}`, `${ref} is not part of ${integrationRef}.`));
    }
  }
  const reqs = new Set(epic.requirements.map(r => r.id));
  for (const f of features) {
    const at = `features[#${f.number}]`;
    const r = byIssue.get(f.number);
    if (!r) { problems.push(problem('FEATURE_EVIDENCE_MISSING', at, `${f.doc.featureKey} (#${f.number}${f.state === 'closed' ? ', closed' : ''}) has no report; being closed is not passing.`)); continue; }
    const ids = new Set(f.doc.criteria.map(c => c.id));
    for (const c of f.doc.criteria) {
      for (const id of c.requirementIds) if (!reqs.has(id)) problems.push(problem('UNKNOWN_REFERENCE', `${at}.${c.id}`, `${c.id} refers to ${id}, which the Epic does not have.`));
      const got = r.criteria.filter(x => x.id === c.id);
      if (!got.length) { problems.push(problem('CRITERION_EVIDENCE_MISSING', `${at}.${c.id}`, `${c.id} has no result.`)); continue; }
      if (got.length > 1) problems.push(problem('DUPLICATE_CRITERION', `${at}.${c.id}`, `${c.id} is reported more than once.`));
      for (const x of got) {
        if (x.status !== 'pass') problems.push(problem('CRITERION_NOT_PASSED', `${at}.${c.id}`, `${c.id} is ${x.status}; it goes back to implementation.`));
        if (x.exitCode !== 0) problems.push(problem('EXIT_CODE', `${at}.${c.id}`, `${c.id} exited with ${x.exitCode === null ? 'no code' : x.exitCode}.`));
      }
    }
    for (const x of r.criteria) if (!ids.has(x.id)) problems.push(problem('UNKNOWN_CRITERION', `${at}.${x.id}`, `${x.id} is not a criterion of ${f.doc.featureKey}.`));
  }
  for (const n of byIssue.keys()) if (!features.some(f => f.number === n)) problems.push(problem('UNKNOWN_FEATURE', `reports[#${n}]`, `#${n} is not a Feature of this Epic.`));
  const testedOnIntegration = reports.length > 0 && reports.every(r => r.productRef === integrationRef);
  return {status: problems.length ? 'blocked' : 'validated', problems, artifactDigests: {}, testedOnIntegration};
}
export const evidenceRootOf = (workflowStateRoot: string) => join(workflowStateRoot, 'evidence');
