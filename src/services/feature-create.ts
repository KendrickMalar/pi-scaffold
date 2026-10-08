// #10 scaffold_feature_create: one Feature per call, from an explicit design decomposition. The Issue is created with the
// pi-gh task template under the real Epic, attached as a native sub-issue and read back. The Epic body is never changed.
// Created-but-unattached Issues are found again through the private journal; nothing is posted twice.
import {join} from 'node:path';
import {
  LIMITS, decodeModelBinding, decodeMutationInput, problem, readCriterion, readDesignRef,
  type Criterion, type Decoded, type DesignRef, type EpicDocV1, type FeatureDocV1, type FeatureRole, type ModelBinding, type MutationInput, type Problem, type ScaffoldResult,
} from '../core/contracts.js';
import {canonicalDocJson, renderFeatureBlock} from '../core/epic-render.js';
import {parseIssueBody} from '../core/body-codec.js';
import {canonicalJson, sha256Bytes, taggedDigest} from '../core/digests.js';
import {writeOwnedFile} from '../core/files.js';
import {withOperation} from '../core/lifecycle.js';
import {approvalViewDigest} from '../core/approvals.js';
import {checkFeatureBindings, FEATURE_ROLES} from '../core/model-bindings.js';
import {specificationApprovalView} from '../core/specification-gate.js';
import {buildTemplateSnapshot, TEMPLATE_FIELD, TEMPLATE_IDS} from '../core/template-snapshot.js';
import type {ToolCall} from '../core/runtime.js';
import {decodeGithubIssue, readIssue, PI_GH_MASK} from '../ports/pi-gh.js';
import {readFeatureSet} from '../ports/feature-set.js';
import {readLabels} from './labels-ensure.js';

export const FEATURE_CREATE = 'scaffold_feature_create';
export const FEATURE_LABELS = ['Type: Scaffold', 'Scope: Feature', 'Stage: BasicDesign'] as const;
export interface FeatureCreateFields {
  featureKey: string; title: string; purpose: string; editScope: string[]; outOfScope: string[]; designRef: DesignRef;
  criteria: Criterion[]; bindings: Record<FeatureRole, ModelBinding>;
}
export type FeatureCreateInput = MutationInput & FeatureCreateFields;
export interface FeatureCreateData { featureKey: string; number: number; url: string; parentAttached: boolean }

export function decodeFeatureCreateInput(value: unknown): Decoded<FeatureCreateInput> {
  const d = decodeMutationInput<FeatureCreateFields>(value, {
    featureKey: {decode: (r, v, p) => r.stableId('F', v, p)},
    title: {decode: (r, v, p) => { const t = r.text(v, p); if (typeof v === 'string' && (/[\r\n\u0000-\u001f\u007f]/.test(v) || Array.from(v).length > 256)) r.add('INVALID_FORMAT', p, 'Title must be a single line of at most 256 characters.'); return t; }},
    purpose: {decode: (r, v, p) => r.text(v, p)},
    editScope: {decode: (r, v, p) => { const x = r.texts(v, p); if (Array.isArray(v) && !v.length) r.add('EMPTY', p, 'Name at least one path the Feature may edit.'); return x; }},
    outOfScope: {decode: (r, v, p) => r.texts(v, p)},
    designRef: {decode: (r, v, p) => readDesignRef(r, v, p)},
    criteria: {decode: (r, v, p) => {
      const list = r.array(v, p, (x, q) => readCriterion(r, x, q), LIMITS.criteria);
      if (Array.isArray(v) && !v.length) r.add('EMPTY', p, 'At least one criterion is required.');
      r.unique(list.map(c => c.id), p, 'id');
      return list;
    }},
    bindings: {decode: (r, v, p) => {
      const o = r.object(v, p, [...FEATURE_ROLES]) ?? {};
      return Object.fromEntries(FEATURE_ROLES.map(role => [role, decodeModelBinding(r, o[role], `${p}.${role}`)])) as Record<FeatureRole, ModelBinding>;
    }},
  });
  return d;
}

/** Feature ACs must stay inside the Epic: every REQ exists there, and an Epic AC ID keeps its exact content. */
function checkCriteria(epic: EpicDocV1, criteria: readonly Criterion[]): Problem[] {
  const reqs = new Set(epic.requirements.map(r => r.id));
  const problems: Problem[] = [];
  criteria.forEach((c, i) => {
    c.requirementIds.forEach((id, j) => { if (!reqs.has(id)) problems.push(problem('UNKNOWN_REFERENCE', `criteria[${i}].requirementIds[${j}]`, `${id} is not a requirement of the Epic.`)); });
    const same = epic.criteria.find(e => e.id === c.id);
    if (same && canonicalJson(same) !== canonicalJson(c)) problems.push(problem('CRITERION_MISMATCH', `criteria[${i}]`, `${c.id} exists in the Epic with different content; use a new AC ID or the Epic's exact criterion.`));
  });
  return problems;
}

async function verifyDesignRef(call: ToolCall, repoRoot: string, ref: DesignRef): Promise<Problem[]> {
  let bytes: Buffer | undefined;
  try { bytes = await call.runtime.git.readBlob(ref.gitRef, ref.path, repoRoot); }
  catch (e) { return [problem(/TOO_LARGE/.test((e as Error).message) ? 'DESIGN_TOO_LARGE' : 'DESIGN_UNREADABLE', 'designRef', (e as Error).message)]; }
  if (!bytes) return [problem('DESIGN_NOT_FOUND', 'designRef', `${ref.path} does not exist at ${ref.gitRef} in the local repository.`)];
  return sha256Bytes(bytes) === ref.sha256 ? [] : [problem('DESIGN_HASH_MISMATCH', 'designRef.sha256', `${ref.path} at ${ref.gitRef} has a different sha256.`)];
}

const decodeIssueList = (d: unknown) => Array.isArray(d) ? d.map(decodeGithubIssue) : undefined;
const decodeCreated = (repo: string) => (d: unknown) => {
  const url = (d as {url?: unknown} | null)?.url;
  const m = typeof url === 'string' ? new RegExp(`^https://github\\.com/${repo.replace('.', '\\.')}/issues/([1-9][0-9]*)$`, 'i').exec(url) : null;
  return m ? {number: Number(m[1]), url: url as string} : undefined;
};

export async function createFeature(input: FeatureCreateInput, call: ToolCall): Promise<ScaffoldResult<FeatureCreateData>> {
  const operation = FEATURE_CREATE;
  const blocked = (problems: Problem[]): ScaffoldResult<FeatureCreateData> => ({status: 'blocked', operation, problems});
  if (JSON.stringify(input).includes(PI_GH_MASK)) return blocked([problem('UNREADABLE_TEXT', '', `Input contains "${PI_GH_MASK}", which pi-gh uses for redaction; the Feature could not be read back. Rephrase it.`)]);
  const caps = await call.bridge.requireCapabilities(['gh_issue_get', 'gh_issue_validate', 'gh_issue_submit', 'gh_issue_list', 'gh_subissues_list', 'gh_subissue_add', 'gh_labels_list'], call.scope, ['issue-list-labels']);
  if (!caps.ok) return blocked(caps.problems);
  const repoOnly = await call.repoContext(input.repo, null);
  if (!repoOnly.ok) return blocked(repoOnly.problems);
  const epicSnap = await readIssue(input.repo, input.epicIssue, call.bridge, call.scope);
  if (!epicSnap.ok) return blocked(epicSnap.problems);
  if (epicSnap.value.doc.kind !== 'epic') return blocked([problem('NOT_AN_EPIC', 'epicIssue', `#${input.epicIssue} is not a Scaffold Epic.`)]);
  const epic = epicSnap.value.doc;
  const context = await call.repoContext(input.repo, epic.workflowId);
  if (!context.ok) return blocked(context.problems);
  const ctx = context.value;
  const journal = call.journal(ctx);
  const record = await journal.load(input.operationId);

  // Once this operation has (possibly) posted, the creation checks are history: a resume only finds the Issue and attaches it.
  const posted = !!record && record.steps.some(s => (s.name === 'submit' && s.phase !== 'failed') || s.name === 'found');
  let existing: number | undefined;
  if (!posted) {
    // ---- preconditions (zero side effects) ----
    const pre: Problem[] = [];
    if (epicSnap.value.state !== 'open') pre.push(problem('ISSUE_CLOSED', 'epicIssue', 'The Epic is closed.'));
    if (epic.stage !== 'basic-design') pre.push(problem('STAGE_MISMATCH', 'stage', `Features are created during basic design; the Epic is in ${epic.stage}.`));
    if (epicSnap.value.labels.includes('Blocked')) pre.push(problem('EPIC_BLOCKED', 'labels', 'The Epic is Blocked.'));
    if (epicSnap.value.bodySha256 !== input.expectedBodySha256) pre.push(problem('STALE_BODY', 'expectedBodySha256', 'The Epic body changed; read it again.'));
    if (epic.revision !== input.expectedRevision) pre.push(problem('STALE_REVISION', 'expectedRevision', `The Epic is at revision ${epic.revision}.`));
    if (pre.length) return blocked(pre);
    const approval = await call.approvals.requireContentApproval('specification', epic.workflowId, approvalViewDigest('specification', specificationApprovalView(epic)), ctx);
    if (!approval.ok) return blocked([problem('SPECIFICATION_NOT_APPROVED', 'specification', 'The current specification has no valid parent approval (it changed, or was never approved).'), ...approval.problems]);
    const policy = await call.policy();
    if (!policy.ok) return blocked(policy.problems);
    const checks = [
      ...checkCriteria(epic, input.criteria),
      ...checkFeatureBindings({repo: input.repo, bindings: input.bindings, policy: policy.value, availableModels: call.env.availableModels(), scopedModels: call.env.scopedModels()}),
      ...await verifyDesignRef(call, ctx.repoRoot, input.designRef),
    ];
    if (checks.length) return blocked(checks);
    const labels = await readLabels(call, input.repo);
    if ('error' in labels) return blocked(labels.error);
    const absent = FEATURE_LABELS.filter(l => labels.labels.get(l.toLowerCase())?.name !== l);
    if (absent.length) return blocked([problem('LABELS_NOT_READY', 'labels', `Management labels are missing (${absent.join(', ')}); run scaffold_labels_ensure first.`)]);
    // ---- the Feature set (native children, closed included, plus created-but-unattached Issues from the journal) ----
    const knownCreated = (await journal.list())
      .filter(r => r.operation === operation && !r.abandonedAt)
      .flatMap(r => { const n = (r.steps.find(s => s.name === 'submit' && s.phase === 'done')?.data ?? r.steps.find(s => s.name === 'found')?.data) as {number?: number} | undefined; return n?.number ? [{number: n.number, createOperationId: r.operationId}] : []; });
    const set = await readFeatureSet(input.repo, input.epicIssue, call.bridge, call.scope, {workflowId: epic.workflowId, knownCreated});
    if (!set.ok) return blocked(set.problems);
    const all = [...set.value.features, ...set.value.unattached];
    const sameKey = all.filter(f => f.doc.featureKey === input.featureKey);
    if (sameKey.some(f => f.doc.createOperationId !== input.operationId)) return blocked([problem('DUPLICATE_FEATURE_KEY', 'featureKey', `${input.featureKey} is already used by #${sameKey.map(f => f.number).join(', #')}.`)]);
    if (!sameKey.length && all.length >= LIMITS.features) return blocked([problem('LIMIT_EXCEEDED', 'features', `The Epic already has ${all.length} Features (closed included; at most ${LIMITS.features}).`)]);
    // Already a child created by this operation (e.g. its journal was lost): adopt it instead of posting.
    existing = sameKey[0]?.number;
  }

  // ---- the document and draft ------------------------------------------------------------------------
  const doc: FeatureDocV1 = {
    version: 1, kind: 'feature', workflowId: epic.workflowId, revision: 1, createOperationId: input.operationId,
    featureKey: input.featureKey, parentEpic: input.epicIssue, stage: 'basic-design', purpose: input.purpose,
    editScope: input.editScope, outOfScope: input.outOfScope, designRef: input.designRef, criteria: input.criteria, bindings: input.bindings, evidenceRefs: [],
  };
  let block: string;
  try { block = renderFeatureBlock(doc); } catch (e) { return blocked([problem('INVALID_DOCUMENT', 'doc', (e as Error).message)]); }
  if (Buffer.byteLength(canonicalDocJson(doc)) > LIMITS.jsonBytes) return blocked([problem('LIMIT_EXCEEDED', 'json', `Managed JSON exceeds ${LIMITS.jsonBytes} bytes.`)]);
  const dir = join(ctx.workflowStateRoot, 'features', input.operationId);
  const draftPath = join(dir, 'draft.json');
  const snapshot = await buildTemplateSnapshot('feature', input.bindings, join(dir, 'template'), call.namespaceRoot);
  const draft = {version: 1, template: TEMPLATE_IDS.feature, repo: input.repo, title: input.title, parentIssue: input.epicIssue, labels: [...FEATURE_LABELS], fields: {[TEMPLATE_FIELD]: block}, agents: input.bindings};
  await writeOwnedFile(draftPath, JSON.stringify(draft, null, 2) + '\n', {root: call.namespaceRoot});
  const args = {draftPath, templatePath: snapshot.templatePath};
  const payloadDigest = taggedDigest('feature-create', {repo: input.repo, epicIssue: input.epicIssue, title: input.title, doc: JSON.parse(canonicalDocJson(doc))});
  if (record && record.payloadDigest !== payloadDigest) return blocked([problem('OPERATION_PAYLOAD_MISMATCH', 'operationId', 'This operationId was already used with different content.')]);
  if (!posted) {
    const validated = await call.bridge.call('gh_issue_validate', args, () => true as const, call.scope);
    if (validated.status !== 'ok') return {status: validated.status === 'cancelled' ? 'cancelled' : 'blocked', operation, problems: validated.problems};
  }

  /**
   * Reconcile an uncertain post: a just-created Feature is open and carries all three labels, which keeps the list small.
   * 'unknown' whenever an Issue mentions this operation but cannot be confirmed as ours (never treated as "not created").
   */
  const reconcileSubmit = async (): Promise<{state: 'applied'; number: number} | {state: 'not-applied' | 'unknown'}> => {
    const r = await call.bridge.call('gh_issue_list', {repo: input.repo, state: 'open', labels: [...FEATURE_LABELS]}, decodeIssueList, call.scope);
    if (r.status !== 'ok' || r.data!.some(i => !i)) return {state: 'unknown'};
    const mentions = r.data!.filter(i => i!.body?.includes(input.operationId));
    const ours = mentions.filter(i => {
      const p = parseIssueBody(i!.body ?? '');
      return p.ok && p.value.doc.kind === 'feature' && p.value.doc.createOperationId === input.operationId && p.value.doc.parentEpic === input.epicIssue;
    });
    if (ours.length === 1 && mentions.length === 1) return {state: 'applied', number: ours[0]!.number};
    return mentions.length ? {state: 'unknown'} : {state: 'not-applied'};
  };
  const attachPath = join(dir, 'attach.json');
  const attached = async (n: number) => {
    const s = await readFeatureSet(input.repo, input.epicIssue, call.bridge, call.scope, {workflowId: epic.workflowId});
    return s.ok ? s.value.features.some(f => f.number === n) : undefined;
  };
  let createdNumber: number | undefined;
  const result = await withOperation<FeatureCreateData>({operation, repo: input.repo, workflowId: epic.workflowId, operationId: input.operationId, payloadDigest, journal, scope: call.scope}, async run => {
    const pending = run.record.steps.some(s => s.name === 'submit' && (s.phase === 'requested' || s.phase === 'unknown'));
    let number = (run.done('submit') as {number: number} | undefined)?.number ?? (run.done('found') as {number: number} | undefined)?.number;
    if (number === undefined && !pending && existing !== undefined) { number = existing; run.note('found', {number}); }
    if (number === undefined) {
      let found: number | undefined;
      const created = await run.write('submit', () => call.bridge.call('gh_issue_submit', args, decodeCreated(input.repo), call.scope), {
        reconcile: async () => { const c = await reconcileSubmit(); if (c.state === 'applied') found = c.number; return c.state; },
      });
      number = created?.number ?? found;
      if (number !== undefined && !created) run.note('found', {number});
    }
    if (number === undefined) return run.stop([problem('ISSUE_NOT_FOUND', 'issue', 'The created Issue could not be identified.')]);
    createdNumber = number;
    // Native parent link: the only evidence of membership. The Epic body is not touched.
    if (!(await attached(number))) {
      run.checkpoint();
      await writeOwnedFile(attachPath, JSON.stringify({version: 1, repo: input.repo, operation: 'subissue-add', issue: input.epicIssue, relatedIssue: number}), {root: call.namespaceRoot});
      await run.write('attach', () => call.bridge.call('gh_subissue_add', {changePath: attachPath}, () => true as const, call.scope), {
        reconcile: async () => { const a = await attached(number!); return a === true ? 'applied' : a === false ? 'not-applied' : 'unknown'; },
      });
    }
    const snap = await readIssue(input.repo, number, call.bridge, call.scope);
    if (!snap.ok) return run.stop(snap.problems);
    if (canonicalDocJson(snap.value.doc) !== canonicalDocJson(doc)) return run.stop([problem('FEATURE_IDENTITY', 'issue', `#${number} does not hold the Feature this operation created.`)]);
    const managed = snap.value.labels.filter(l => /^(Type|Scope|Stage|Wave): /.test(l) || l === 'Blocked');
    if (managed.slice().sort().join('\n') !== [...FEATURE_LABELS].sort().join('\n')) return run.stop([problem('FEATURE_LABELS_INCOMPLETE', 'labels', `#${number} has managed labels [${managed.join(', ')}] instead of ${FEATURE_LABELS.join(', ')}.`)]);
    if ((await attached(number)) !== true) return run.stop([problem('NOT_ATTACHED', 'parent', `#${number} is not a native sub-issue of #${input.epicIssue}.`)]);
    const wrote = run.record.steps.some(s => !s.note && s.phase === 'done' && (s.name === 'submit' || s.name === 'attach'));
    return {status: wrote ? 'applied' : 'noop', data: {featureKey: input.featureKey, number, url: `https://github.com/${input.repo}/issues/${number}`, parentAttached: true}};
  });
  // An interrupted run still reports the Issue it created, so the caller never posts again.
  if ((result.status === 'partial' || result.status === 'unknown' || result.status === 'blocked') && createdNumber !== undefined) {
    return {...result, data: {featureKey: input.featureKey, number: createdNumber, url: `https://github.com/${input.repo}/issues/${createdNumber}`, parentAttached: false}} as ScaffoldResult<FeatureCreateData>;
  }
  return result as ScaffoldResult<FeatureCreateData>;
}
