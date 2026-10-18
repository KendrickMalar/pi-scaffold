// scaffold_feature_revise: bring one Feature in line with a revised specification. Its criteria (and, when given, its
// design reference) are replaced after the same checks scaffold_feature_create applies, and the Blocked label is
// released only when a specification revision of the Epic set it (listed in specRevisions[].affectedFeatures).
import {join} from 'node:path';
import {
  decodeMutationInput, problem, readCriterion, readDesignRef, LIMITS,
  type Criterion, type Decoded, type DesignRef, type FeatureDocV1, type IssueSnapshot, type MutationInput, type PreparedIssueEdit, type Problem, type ScaffoldResult,
} from '../core/contracts.js';
import {patchDoc} from '../core/body-codec.js';
import {canonicalJson, taggedDigest} from '../core/digests.js';
import {readOwnedJson, writeOwnedFile} from '../core/files.js';
import {prepareLabelEdit} from '../core/label-policy.js';
import {withOperation} from '../core/lifecycle.js';
import type {ToolCall} from '../core/runtime.js';
import {readIssue, PI_GH_MASK} from '../ports/pi-gh.js';
import {readFeatureSet} from '../ports/feature-set.js';
import {checkCriteria, verifyDesignRef} from './feature-create.js';
import {REVISABLE_STAGES} from './specification-revise.js';

export const FEATURE_REVISE = 'scaffold_feature_revise';
/** expectedRevision/expectedBodySha256 are those of the Feature (featureIssue), not of the Epic. */
export type FeatureReviseInput = MutationInput & {featureIssue: number; criteria: Criterion[]; designRef?: DesignRef};
export interface FeatureReviseData { featureIssue: number; revision: number; blockedReleased: boolean }

export function decodeFeatureReviseInput(value: unknown): Decoded<FeatureReviseInput> {
  return decodeMutationInput<{featureIssue: number; criteria: Criterion[]; designRef?: DesignRef}>(value, {
    featureIssue: {decode: (r, v, p) => r.int(v, p)},
    criteria: {decode: (r, v, p) => { const c = r.array(v, p, (x, q) => readCriterion(r, x, q), LIMITS.criteria); if (Array.isArray(v) && !v.length) r.add('EMPTY', p, 'At least one criterion is required.'); return c; }},
    designRef: {optional: true, decode: (r, v, p) => readDesignRef(r, v, p)},
  });
}

interface Plan { edit: boolean; release: {changePath: string; expectedLabelsSha256: string} | null }

export async function reviseFeature(input: FeatureReviseInput, call: ToolCall): Promise<ScaffoldResult<FeatureReviseData>> {
  const operation = FEATURE_REVISE;
  const blocked = (problems: Problem[]): ScaffoldResult<FeatureReviseData> => ({status: 'blocked', operation, problems});
  if (JSON.stringify(input).includes(PI_GH_MASK)) return blocked([problem('UNREADABLE_TEXT', '', `Input contains "${PI_GH_MASK}", which pi-gh uses for redaction; the Feature could not be read back. Rephrase it.`)]);
  const caps = await call.bridge.requireCapabilities(['gh_issue_get', 'gh_issue_edit_if_current', 'gh_issue_labels_if_current', 'gh_subissues_list'], call.scope);
  if (!caps.ok) return blocked(caps.problems);
  const repoOnly = await call.repoContext(input.repo, null);
  if (!repoOnly.ok) return blocked(repoOnly.problems);
  const epicSnap = await readIssue(input.repo, input.epicIssue, call.bridge, call.scope);
  if (!epicSnap.ok) return blocked(epicSnap.problems);
  if (epicSnap.value.doc.kind !== 'epic') return blocked([problem('NOT_AN_EPIC', 'epicIssue', `#${input.epicIssue} is not a Scaffold Epic.`)]);
  const epic = epicSnap.value.doc;
  const context = await call.repoContext(input.repo, epic.workflowId);
  if (!context.ok) return blocked(context.problems);
  const journal = call.journal(context.value);
  const record = await journal.load(input.operationId);
  const dir = join(context.value.workflowStateRoot, 'feature-revise', input.operationId);
  const bodyPath = join(dir, 'feature-body.json');
  let fresh: Plan | undefined;

  if (!record?.steps.some(s => s.name === 'plan')) {
    const pre: Problem[] = [];
    if (!REVISABLE_STAGES.includes(epic.stage)) pre.push(problem('STAGE_MISMATCH', 'stage', `The Epic is in ${epic.stage}; Features are revised in basic-design, implementation or verification.`));
    if (epicSnap.value.state !== 'open') pre.push(problem('ISSUE_CLOSED', 'epicIssue', 'The Epic is closed.'));
    if (pre.length) return blocked(pre);
    const set = await readFeatureSet(input.repo, input.epicIssue, call.bridge, call.scope, {workflowId: epic.workflowId});
    if (!set.ok) return blocked(set.problems);
    const f = set.value.features.find(x => x.number === input.featureIssue);
    if (!f) return blocked([problem('NOT_A_FEATURE', 'featureIssue', `#${input.featureIssue} is not a Feature of Epic #${input.epicIssue}.`)]);
    if (f.state !== 'open') pre.push(problem('ISSUE_CLOSED', 'featureIssue', 'The Feature is closed.'));
    if (f.bodySha256 !== input.expectedBodySha256) pre.push(problem('STALE_BODY', 'expectedBodySha256', 'The Feature body changed; read it again.'));
    if (f.doc.revision !== input.expectedRevision) pre.push(problem('STALE_REVISION', 'expectedRevision', `The Feature is at revision ${f.doc.revision}.`));
    pre.push(...checkCriteria(epic, input.criteria));
    if (input.designRef) pre.push(...await verifyDesignRef(call, repoOnly.value.repoRoot, input.designRef));
    if (pre.length) return blocked(pre);
    const next: FeatureDocV1 = {...f.doc, criteria: input.criteria, ...(input.designRef ? {designRef: input.designRef} : {})};
    const edit = patchDoc(f, next);
    if (!edit.ok) return blocked(edit.problems);
    const changed = canonicalJson(next) !== canonicalJson(f.doc);
    if (changed) await writeOwnedFile(bodyPath, JSON.stringify(edit.value), {root: call.namespaceRoot});
    // Released only for a Feature a specification revision blocked; a Blocked label set for another reason stays.
    let release: Plan['release'] = null;
    if (f.labels.includes('Blocked') && (epic.specRevisions ?? []).some(v => v.affectedFeatures.includes(f.number))) {
      // The body edit leaves the labels alone, so the label snapshot read here is still the one to compare against.
      const labels = prepareLabelEdit(f, {type: 'Scaffold', scope: 'Feature', stage: f.doc.stage, blocked: false});
      if (!labels.ok) return blocked(labels.problems);
      const changePath = join(dir, 'labels.json');
      await writeOwnedFile(changePath, JSON.stringify(labels.value), {root: call.namespaceRoot});
      release = {changePath, expectedLabelsSha256: f.labelsSha256};
    }
    if (!changed && !release) return {status: 'noop', operation, data: {featureIssue: f.number, revision: f.doc.revision, blockedReleased: false}, problems: []};
    fresh = {edit: changed, release};
  }

  const {operationId: _id, ...payload} = input;
  const reread = async (stop: (p: Problem[]) => never) => { const r = await readIssue(input.repo, input.featureIssue, call.bridge, call.scope); if (!r.ok) stop(r.problems); return (r as {ok: true; value: IssueSnapshot}).value; };
  const result = await withOperation<FeatureReviseData>({operation, repo: input.repo, workflowId: epic.workflowId, operationId: input.operationId, payloadDigest: taggedDigest('feature-revise', payload), journal, scope: call.scope}, async run => {
    const plan = (run.done('plan') as Plan | undefined) ?? (run.note('plan', fresh!), fresh!);
    if (plan.edit) {
      const planned = await readOwnedJson(bodyPath, {root: call.namespaceRoot, maxBytes: LIMITS.bodyBytes * 2}) as PreparedIssueEdit;
      await run.write('feature-body', () => call.bridge.call('gh_issue_edit_if_current', {changePath: bodyPath}, () => true as const, call.scope), {
        reconcile: async () => { const s = await reread(run.stop); return s.body === planned.body ? 'applied' : s.bodySha256 === planned.expectedBodySha256 ? 'not-applied' : 'unknown'; },
      });
    }
    if (plan.release) {
      const release = plan.release;
      await run.write('release-blocked', () => call.bridge.call('gh_issue_labels_if_current', {changePath: release.changePath}, () => true as const, call.scope), {
        reconcile: async () => { const s = await reread(run.stop); return !s.labels.includes('Blocked') ? 'applied' : s.labelsSha256 === release.expectedLabelsSha256 ? 'not-applied' : 'unknown'; },
      });
    }
    const after = await reread(run.stop);
    return {status: 'applied', data: {featureIssue: input.featureIssue, revision: (after.doc as FeatureDocV1).revision, blockedReleased: !!plan.release && !after.labels.includes('Blocked')}};
  });
  return result as ScaffoldResult<FeatureReviseData>;
}
