// #14 design gate (pure): what must hold before an Epic leaves basic design — the design document exists at its
// recorded commit with its hash, every Feature's criteria stay inside the Epic and together cover every requirement,
// and every Feature's model bindings are still allowed. Wave consistency is checked by the #13 verifier.
import {canonicalJson, designDigest, sha256Bytes, specificationDigest, taggedDigest, wavePlanDigest} from './digests.js';
import {problem, type DesignRef, type EpicDocV1, type FeatureSnapshot, type GateResult, type Problem, type Sha256} from './contracts.js';
import {checkFeatureBindings, type OwnerPolicy} from './model-bindings.js';
import {canonicalWavePlan} from './wave-plan.js';
import type {ApprovalView} from './approvals.js';

export interface DesignGateInput {
  repo: string; epic: EpicDocV1; features: readonly FeatureSnapshot[];
  /** Bytes of `<gitRef>:<path>` from the local repository; undefined when it does not exist. */
  blobs: ReadonlyMap<string, Buffer | undefined>;
  policy: OwnerPolicy | undefined; availableModels: readonly string[]; scopedModels: readonly string[];
}
export const blobKey = (ref: DesignRef) => `${ref.gitRef}:${ref.path}`;

function checkRef(ref: DesignRef, blobs: DesignGateInput['blobs'], path: string): Problem[] {
  const bytes = blobs.get(blobKey(ref));
  if (!bytes) return [problem('DESIGN_NOT_FOUND', path, `${ref.path} does not exist at ${ref.gitRef} in the local repository.`)];
  return sha256Bytes(bytes) === ref.sha256 ? [] : [problem('DESIGN_HASH_MISMATCH', path, `${ref.path} at ${ref.gitRef} has a different sha256.`)];
}

export function checkDesignReady(input: DesignGateInput): GateResult {
  const {epic, features} = input;
  const problems: Problem[] = [];
  if (epic.design === null) problems.push(problem('DESIGN_UNSET', 'design', 'The Epic has no basic design reference.'));
  else problems.push(...checkRef(epic.design, input.blobs, 'design'));
  if (!features.length) problems.push(problem('NO_FEATURES', 'features', 'The Epic has no Features.'));
  const reqs = new Set(epic.requirements.map(r => r.id));
  const covered = new Set<string>();
  for (const f of features) {
    const at = `features[#${f.number}]`;
    problems.push(...checkRef(f.doc.designRef, input.blobs, `${at}.designRef`));
    f.doc.criteria.forEach((c, i) => {
      c.requirementIds.forEach(id => { if (reqs.has(id)) covered.add(id); else problems.push(problem('UNKNOWN_REFERENCE', `${at}.criteria[${i}]`, `${c.id} refers to ${id}, which the Epic does not have.`)); });
      const same = epic.criteria.find(e => e.id === c.id);
      if (same && canonicalJson(same) !== canonicalJson(c)) problems.push(problem('CRITERION_MISMATCH', `${at}.criteria[${i}]`, `${c.id} differs from the Epic's criterion with the same ID.`));
    });
    problems.push(...checkFeatureBindings({repo: input.repo, bindings: f.doc.bindings, policy: input.policy, availableModels: input.availableModels, scopedModels: input.scopedModels}).map(p => ({...p, path: `${at}.${p.path}`})));
  }
  for (const r of epic.requirements) if (!covered.has(r.id)) problems.push(problem('REQUIREMENT_UNCOVERED', `requirements.${r.id}`, `No Feature has an acceptance criterion for ${r.id}.`));
  return {status: problems.length ? 'blocked' : 'validated', problems, artifactDigests: {}};
}

/** What the parent approves to start implementation: specification, design, Feature set, Feature criteria/bindings and Waves. */
export function startApprovalView(epic: EpicDocV1, features: readonly FeatureSnapshot[], featureSetDigest: Sha256): ApprovalView {
  const sorted = [...features].sort((a, b) => a.number - b.number);
  const plan = epic.wavePlan === null ? null : canonicalWavePlan(epic.wavePlan);
  const wave = new Map((plan?.assignments ?? []).map(a => [a.issue, a.wave]));
  const contentDigest = taggedDigest('implementation-start', {
    specification: specificationDigest(epic), design: designDigest(epic), featureSet: featureSetDigest, wavePlan: wavePlanDigest({...epic, wavePlan: plan}),
    features: sorted.map(f => ({issue: f.number, featureKey: f.doc.featureKey, editScope: f.doc.editScope, designRef: f.doc.designRef, criteria: f.doc.criteria, bindings: f.doc.bindings})),
  });
  const text = [
    '実装を開始する内容',
    `基本設計: ${epic.design ? `${epic.design.path}（${epic.design.gitRef.slice(0, 12)}、SHA-256 ${epic.design.sha256.slice(0, 12)}…）` : '未設定'}`,
    'Feature:',
    ...sorted.map(f => `- #${f.number} ${f.doc.featureKey}（Wave ${wave.get(f.number) ?? '未設定'}）: ${f.doc.purpose.split('\n')[0]}／合格基準 ${f.doc.criteria.map(c => c.id).join(', ')}／担当 ${f.doc.bindings.coder.model}`),
    `依存: ${epic.dependencyPlan?.edges.map(e => `#${e.from}→#${e.to}`).join(', ') || 'なし'}`,
  ].join('\n');
  return {contentDigest, text};
}
