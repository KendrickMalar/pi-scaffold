// #6 pure specification reducer: applies a stable-ID patch (add/change only, never delete or renumber) to an Epic doc.
// Nothing is inferred: only explicitly given records and fields change. A baseline change resets research progress.
import {
  decodeEpicDoc, failed, okValue, problem,
  type Criterion, type Decision, type Decoded, type EpicDocV1, type OriginalRequest, type Problem, type QuestionFact, type Requirement, type Sha256,
} from './contracts.js';
import {canonicalJson, specBaseDigest, specificationDigest} from './digests.js';

export interface SpecificationPatch {
  originalRequest?: OriginalRequest; background?: string | null;
  facts: QuestionFact[]; requirements: Requirement[]; criteria: Criterion[];
  /** Omitted = unchanged; null = not set; [] = confirmed none. */
  constraints?: string[] | null; outOfScope?: string[] | null; decisions: Decision[];
}
export interface ReducedSpecification { nextDoc: EpicDocV1; missingFields: string[]; changedIds: string[]; specDigest: Sha256; baseChanged: boolean }

/** Gaps a specification may still be saved with; reported, never filled in. */
export function specificationMissingFields(doc: EpicDocV1): string[] {
  const covered = new Set(doc.criteria.flatMap(c => c.requirementIds));
  return [
    ...(doc.background === null ? ['background'] : []),
    ...(doc.requirements.length ? [] : ['requirements']),
    ...doc.requirements.filter(r => !covered.has(r.id)).map(r => `criteria.${r.id}`),
    ...doc.questions.filter(q => q.answer === null && (q.required || q.kind === 'conflict')).map(q => `questions.${q.questionId}.answer`),
    ...(doc.constraints === null ? ['constraints'] : []),
    ...(doc.outOfScope === null ? ['outOfScope'] : []),
  ];
}

/** Upserts records by ID in place (new IDs are appended). The same ID twice must carry the same content. */
function merge<T>(current: readonly T[], patch: readonly T[], id: (x: T) => string, field: string, idKey: string, problems: Problem[], changed: string[]): T[] {
  const next = [...current];
  const seen = new Map<string, string>();
  patch.forEach((item, i) => {
    const key = id(item), json = canonicalJson(item);
    const prev = seen.get(key);
    if (prev !== undefined) { if (prev !== json) problems.push(problem('DUPLICATE_ID', `${field}[${i}].${idKey}`, `${key} is given twice with different content.`)); return; }
    seen.set(key, json);
    const at = next.findIndex(x => id(x) === key);
    if (at < 0) { next.push(item); changed.push(key); }
    else if (canonicalJson(next[at]) !== json) { next[at] = item; changed.push(key); }
  });
  return next;
}

export function reduceSpecification(doc: EpicDocV1, patch: SpecificationPatch): Decoded<ReducedSpecification> {
  const problems: Problem[] = [], changedIds: string[] = [];
  const questions = merge(doc.questions, patch.facts, q => q.questionId, 'facts', 'questionId', problems, changedIds);
  const requirements = merge(doc.requirements, patch.requirements, r => r.id, 'requirements', 'id', problems, changedIds);
  const criteria = merge(doc.criteria, patch.criteria, c => c.id, 'criteria', 'id', problems, changedIds);
  const decisions = merge(doc.decisions, patch.decisions, d => d.id, 'decisions', 'id', problems, changedIds);
  const known = new Set(requirements.map(r => r.id));
  patch.criteria.forEach((c, i) => c.requirementIds.forEach((ref, j) => { if (!known.has(ref)) problems.push(problem('UNKNOWN_REFERENCE', `criteria[${i}].requirementIds[${j}]`, `${ref} does not exist.`)); }));
  if (problems.length) return failed(problems);

  let next: EpicDocV1 = {
    ...doc, questions, requirements, criteria, decisions,
    originalRequest: patch.originalRequest ?? doc.originalRequest,
    background: patch.background !== undefined ? patch.background : doc.background,
    constraints: patch.constraints !== undefined ? patch.constraints : doc.constraints,
    outOfScope: patch.outOfScope !== undefined ? patch.outOfScope : doc.outOfScope,
  };
  for (const key of ['originalRequest', 'background', 'constraints', 'outOfScope'] as const) {
    if (canonicalJson(next[key]) !== canonicalJson(doc[key])) changedIds.push(key);
  }
  const baseChanged = specBaseDigest(next) !== specBaseDigest(doc);
  // A new baseline invalidates claims and results bound to the old one; the questions themselves stay.
  if (baseChanged) next = {...next, research: next.research.map(r => ({...r, state: 'pending' as const, claim: null, conclusion: null, evidenceRefs: [], limitations: []}))};
  const decoded = decodeEpicDoc(next);
  if (!decoded.ok) return failed(decoded.problems.map(p => ({...p, path: 'doc.' + p.path})));
  return okValue({nextDoc: next, missingFields: specificationMissingFields(next), changedIds, specDigest: specificationDigest(next), baseChanged});
}
