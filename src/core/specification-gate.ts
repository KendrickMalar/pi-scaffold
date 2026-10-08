// #9 specification gate (pure): what must be filled in before the Epic leaves the specification stage.
// It checks presence, references and states only; whether the content is right is the human approval's job.
import {problem, type EpicDocV1, type GateResult, type Problem} from './contracts.js';
import {specificationDigest} from './digests.js';
import {renderEpicVisible} from './epic-render.js';
import type {ApprovalView} from './approvals.js';

export function checkSpecificationReady(doc: EpicDocV1): GateResult {
  const problems: Problem[] = [];
  if (!doc.purpose.trim()) problems.push(problem('BLANK', 'purpose', 'The purpose is empty.'));
  if (!doc.originalRequest.text.trim()) problems.push(problem('BLANK', 'originalRequest.text', 'The original request is empty.'));
  if (!doc.requirements.length) problems.push(problem('MISSING', 'requirements', 'No requirement is recorded.'));
  if (!doc.criteria.length) problems.push(problem('MISSING', 'criteria', 'No acceptance criterion is recorded.'));
  const reqs = new Set(doc.requirements.map(r => r.id));
  const covered = new Set(doc.criteria.flatMap(c => c.requirementIds));
  for (const r of doc.requirements) if (!covered.has(r.id)) problems.push(problem('UNCOVERED_REQUIREMENT', `criteria.${r.id}`, `${r.id} has no acceptance criterion.`));
  doc.criteria.forEach((c, i) => c.requirementIds.forEach((id, j) => { if (!reqs.has(id)) problems.push(problem('UNKNOWN_REFERENCE', `criteria[${i}].requirementIds[${j}]`, `${id} does not exist.`)); }));
  if (doc.constraints === null) problems.push(problem('UNSET', 'constraints', 'Constraints are not confirmed (use [] for "none").'));
  if (doc.outOfScope === null) problems.push(problem('UNSET', 'outOfScope', 'Out-of-scope items are not confirmed (use [] for "none").'));
  for (const q of doc.questions) {
    if (q.answer === null && q.kind === 'conflict') problems.push(problem('UNRESOLVED_CONFLICT', `questions.${q.questionId}.answer`, `${q.questionId} is an unresolved conflict.`));
    else if (q.answer === null && q.required) problems.push(problem('UNANSWERED', `questions.${q.questionId}.answer`, `${q.questionId} is required and unanswered.`));
  }
  for (const r of doc.research) if (r.state !== 'resolved') problems.push(problem('RESEARCH_OPEN', `research.${r.researchId}`, `${r.researchId} is ${r.state}.`));
  return {status: problems.length ? 'blocked' : 'validated', problems, artifactDigests: {specificationDigest: specificationDigest(doc)}};
}

/** What the parent approves: the visible specification, bound to specificationDigest (approvals expire when it changes). */
export function specificationApprovalView(doc: EpicDocV1): ApprovalView {
  return {contentDigest: specificationDigest(doc), text: renderEpicVisible(doc)};
}
