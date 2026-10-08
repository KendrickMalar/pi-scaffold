import {createHash} from 'node:crypto';
import type {EpicDocV1, Sha256} from './contracts.js';

export function sha256Bytes(bytes: Uint8Array): Sha256 { return createHash('sha256').update(bytes).digest('hex'); }
export function sha256Text(text: string): Sha256 { return createHash('sha256').update(text, 'utf8').digest('hex'); }

/** Canonical JSON for hashing: recursively sorted keys, no whitespace. Rejects non-JSON values. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new TypeError('Non-finite number.'); return JSON.stringify(value); }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}';
  }
  throw new TypeError('Value is not JSON.');
}
/** Domain-separated digest so different digest kinds can never be confused with each other. */
export function taggedDigest(tag: string, value: unknown): Sha256 { return sha256Text(`pi-scaffold:${tag}:v1\n` + canonicalJson(value)); }

/** Order-insensitive digest of an Issue's label names. */
export function labelsSha256(labels: readonly string[]): Sha256 { return taggedDigest('labels', [...labels].sort()); }

/** Specification inputs that research claims are bound to (excludes research progress/results and decisions). */
export function specBaseDigest(doc: EpicDocV1): Sha256 {
  return taggedDigest('spec-base', {
    purpose: doc.purpose, originalRequest: doc.originalRequest, background: doc.background, questions: doc.questions,
    requirements: doc.requirements, criteria: doc.criteria, constraints: doc.constraints, outOfScope: doc.outOfScope,
    research: doc.research.map(r => ({researchId: r.researchId, question: r.question, requiredEvidence: r.requiredEvidence, doneCondition: r.doneCondition})),
  });
}
/** Content approved at the specification gate: base + resolved research results + decisions. */
export function specificationDigest(doc: EpicDocV1): Sha256 {
  return taggedDigest('specification', {
    base: specBaseDigest(doc),
    resolved: doc.research.filter(r => r.state === 'resolved').map(r => ({researchId: r.researchId, conclusion: r.conclusion, evidenceRefs: r.evidenceRefs, limitations: r.limitations})),
    decisions: doc.decisions,
  });
}
export function designDigest(doc: EpicDocV1): Sha256 { return taggedDigest('design', {design: doc.design, dependencyPlan: doc.dependencyPlan}); }
export function wavePlanDigest(doc: EpicDocV1): Sha256 { return taggedDigest('wave-plan', doc.wavePlan); }
