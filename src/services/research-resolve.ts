// #8 scaffold_research_resolve: apply research results to the claimed items, one conditional edit per item after a
// fresh read. Results are never promoted to REQ/AC/D; evidence references are format/hash checked, not judged true.
import {join} from 'node:path';
import {
  LIMITS, decodeMutationInput, isUuid, problem,
  type Decoded, type EpicDocV1, type IssueSnapshot, type MutationInput, type Problem, type ScaffoldResult,
} from '../core/contracts.js';
import {patchDoc} from '../core/body-codec.js';
import {sha256Bytes, specificationDigest, taggedDigest} from '../core/digests.js';
import {OwnedFileError, ownedPath, readOwnedFile, writeOwnedFile} from '../core/files.js';
import {withOperation} from '../core/lifecycle.js';
import {applyResolution, checkResolution, parseEvidenceRef, showsResolution, type ResearchResolution} from '../core/research.js';
import type {ToolCall} from '../core/runtime.js';
import {readIssue} from '../ports/pi-gh.js';

export const RESEARCH_RESOLVE = 'scaffold_research_resolve';
export type ResearchResolveInput = MutationInput & {resolutions: ResearchResolution[]};
export interface EvidenceCheck { ref: string; kind: 'url' | 'artifact'; checked: 'format-only' | 'sha256' }
export interface ResearchResolveData { resolvedIds: string[]; remainingIds: string[]; revision: number; specDigest: string; evidence: EvidenceCheck[] }

export function decodeResearchResolveInput(value: unknown): Decoded<ResearchResolveInput> {
  return decodeMutationInput<{resolutions: ResearchResolution[]}>(value, {
    resolutions: {decode: (r, v, p) => {
      const list = r.array(v, p, (x, q) => {
        const o = r.object(x, q, ['researchId', 'claimOperationId', 'conclusion', 'evidenceRefs', 'limitations', 'disposition']) ?? {};
        const res: ResearchResolution = {
          researchId: r.stableId('R', o.researchId, `${q}.researchId`), claimOperationId: r.pattern(o.claimOperationId, `${q}.claimOperationId`, isUuid, 'UUID'),
          conclusion: r.nullableText(o.conclusion, `${q}.conclusion`), evidenceRefs: r.texts(o.evidenceRefs, `${q}.evidenceRefs`), limitations: r.texts(o.limitations, `${q}.limitations`),
          disposition: r.literal(o.disposition, `${q}.disposition`, ['resolved', 'needs-more-work'] as const),
        };
        // needs-more-work also carries a conclusion: the submitted result stays visible as unconfirmed.
        if (o.conclusion === null) r.add('CONCLUSION_REQUIRED', `${q}.conclusion`, 'A result needs a conclusion (for needs-more-work: what is known so far).');
        if (res.disposition === 'resolved') {
          if (Array.isArray(o.evidenceRefs) && !o.evidenceRefs.length) r.add('EVIDENCE_REQUIRED', `${q}.evidenceRefs`, 'A resolved result needs at least one evidence reference.');
        }
        res.evidenceRefs.forEach((ref, i) => { if (typeof ref === 'string' && ref.trim() && !parseEvidenceRef(ref)) r.add('INVALID_EVIDENCE', `${q}.evidenceRefs[${i}]`, 'Evidence must be an https:// URL or artifact:<path>@sha256:<hex>.'); });
        return res;
      }, LIMITS.research);
      if (Array.isArray(v) && !v.length) r.add('EMPTY', p, 'Give at least one result.');
      r.unique(list.map(x => x.researchId), p, 'researchId');
      return list;
    }},
  });
}

function preflight(snapshot: IssueSnapshot): Problem[] {
  const doc = snapshot.doc as EpicDocV1;
  return [
    ...(snapshot.state !== 'open' ? [problem('ISSUE_CLOSED', 'epicIssue', 'The Epic is closed.')] : []),
    ...(doc.stage !== 'specification' ? [problem('STAGE_MISMATCH', 'stage', `Research results are applied during specification; the Epic is in ${doc.stage}.`)] : []),
  ];
}

export async function resolveResearch(input: ResearchResolveInput, call: ToolCall): Promise<ScaffoldResult<ResearchResolveData>> {
  const operation = RESEARCH_RESOLVE;
  const blocked = (problems: Problem[]): ScaffoldResult<ResearchResolveData> => ({status: 'blocked', operation, problems});
  const caps = await call.bridge.requireCapabilities(['gh_issue_get', 'gh_issue_edit_if_current'], call.scope);
  if (!caps.ok) return blocked(caps.problems);
  const repoOnly = await call.repoContext(input.repo, null);
  if (!repoOnly.ok) return blocked(repoOnly.problems);
  const snap = await readIssue(input.repo, input.epicIssue, call.bridge, call.scope);
  if (!snap.ok) return blocked(snap.problems);
  if (snap.value.doc.kind !== 'epic') return blocked([problem('NOT_AN_EPIC', 'epicIssue', 'Expected an Epic.')]);
  const context = await call.repoContext(input.repo, snap.value.doc.workflowId);
  if (!context.ok) return blocked(context.problems);
  const root = context.value.workflowStateRoot;

  // Evidence: URLs are format-checked only; artifacts must exist as owned files with the stated hash.
  const evidence: EvidenceCheck[] = [];
  const evidenceProblems: Problem[] = [];
  for (const [i, res] of input.resolutions.entries()) {
    for (const [j, ref] of res.evidenceRefs.entries()) {
      const parsed = parseEvidenceRef(ref)!;
      if (parsed.kind === 'url') { evidence.push({ref, kind: 'url', checked: 'format-only'}); continue; }
      const path = `resolutions[${i}].evidenceRefs[${j}]`;
      try {
        const bytes = await readOwnedFile(ownedPath(join(root, 'artifacts'), parsed.path), {root: call.namespaceRoot, maxBytes: LIMITS.artifactBytes});
        if (sha256Bytes(bytes) !== parsed.sha256) evidenceProblems.push(problem('EVIDENCE_HASH_MISMATCH', path, 'The artifact content does not match the stated sha256.'));
        else evidence.push({ref, kind: 'artifact', checked: 'sha256'});
      } catch (e) {
        const code = e instanceof OwnedFileError ? e.code : 'EVIDENCE_UNREADABLE';
        evidenceProblems.push(problem(code === 'NOT_FOUND' ? 'EVIDENCE_NOT_FOUND' : code === 'OUTSIDE_ROOT' ? 'INVALID_EVIDENCE' : code, path, (e as Error).message));
      }
    }
  }
  if (evidenceProblems.length) return blocked(evidenceProblems);

  const {operationId: _id, ...payload} = input;
  const reread = async (stop: (p: Problem[]) => never) => { const r = await readIssue(input.repo, input.epicIssue, call.bridge, call.scope); if (!r.ok) stop(r.problems); return (r as {ok: true; value: IssueSnapshot}).value; };
  const dir = join(root, 'research-resolve', input.operationId);

  const result = await withOperation<ResearchResolveData>({
    operation, repo: input.repo, workflowId: snap.value.doc.workflowId, operationId: input.operationId,
    payloadDigest: taggedDigest('research-resolve', payload), journal: call.journal(context.value), scope: call.scope,
  }, async run => {
    // Started = a write may have reached GitHub. A definitely failed write does not count: the caller's view is checked again.
    const started = run.record.steps.some(s => s.name.startsWith('result:') && s.phase !== 'failed');
    let current = snap.value;
    if (!started) {
      // Before the first write: the caller's view must still be current, and every result must be acceptable.
      const problems = preflight(current);
      if (current.bodySha256 !== input.expectedBodySha256) problems.push(problem('STALE_BODY', 'expectedBodySha256', 'The Epic body changed since it was read; read it again.'));
      if ((current.doc as EpicDocV1).revision !== input.expectedRevision) problems.push(problem('STALE_REVISION', 'expectedRevision', `The Epic is at revision ${(current.doc as EpicDocV1).revision}.`));
      input.resolutions.forEach((res, i) => problems.push(...checkResolution(current.doc as EpicDocV1, res, `resolutions[${i}]`)));
      if (problems.length) run.stop(problems);
    }
    for (const [i, res] of input.resolutions.entries()) {
      const step = `result:${res.researchId}`;
      if (run.done(step) !== undefined) continue;
      if (call.overBudget()) run.pause([problem('CALL_BUDGET_EXHAUSTED', '', 'Progress is recorded; call again with the same operationId to continue.')]);
      const prev = run.record.steps.find(s => s.name === step);
      const changePath = join(dir, `${res.researchId}.json`);
      let expected: {body: string; expectedBodySha256: string} | undefined;
      if (!prev || prev.phase === 'failed') {
        current = await reread(run.stop);
        const doc = current.doc as EpicDocV1;
        const problems = preflight(current);
        problems.push(...checkResolution(doc, res, `resolutions[${i}]`));
        if (problems.length) run.stop(problems);
        const next: EpicDocV1 = {...doc, research: doc.research.map(r => r.researchId === res.researchId ? applyResolution(r, res) : r)};
        const edit = patchDoc(current, next);
        if (!edit.ok) return run.stop(edit.problems);
        await writeOwnedFile(changePath, JSON.stringify(edit.value), {root: call.namespaceRoot});
      }
      const planned = JSON.parse((await readOwnedFile(changePath, {root: call.namespaceRoot, maxBytes: LIMITS.bodyBytes * 2})).toString('utf8')) as {body: string; expectedBodySha256: string};
      expected = planned;
      await run.write(step, () => call.bridge.call('gh_issue_edit_if_current', {changePath}, () => true as const, call.scope), {
        // Per item: other items may have changed meanwhile (parallel research sessions).
        reconcile: async () => { const s = await reread(run.stop); return showsResolution(s.doc as EpicDocV1, res) ? 'applied' : s.bodySha256 === expected!.expectedBodySha256 ? 'not-applied' : 'unknown'; },
      });
    }
    // Each item was confirmed by pi-gh's conditional edit or by reconciliation; later edits by others are not ours to undo.
    const doc = (await reread(run.stop)).doc as EpicDocV1;
    return {status: 'applied', data: {
      resolvedIds: input.resolutions.filter(r => r.disposition === 'resolved').map(r => r.researchId),
      remainingIds: doc.research.filter(r => r.state !== 'resolved').map(r => r.researchId),
      revision: doc.revision, specDigest: specificationDigest(doc), evidence,
    }};
  });
  return result as ScaffoldResult<ResearchResolveData>;
}
