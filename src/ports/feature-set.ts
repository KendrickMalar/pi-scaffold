// The Feature set of an Epic is its native sub-issues (closed included). The Epic never stores its own list.
import {LIMITS, failed, okValue, problem, type CallScope, type Decoded, type FeatureSnapshot, type Problem, type Sha256, type UUID} from '../core/contracts.js';
import {taggedDigest} from '../core/digests.js';
import {PiGhBridge, readIssue} from './pi-gh.js';

export interface FeatureSetOptions {
  workflowId: UUID;
  /** Issues this workflow created (from the private journal) that may not be attached as sub-issues yet. */
  knownCreated?: {number: number; createOperationId: UUID}[];
}
export interface FeatureSet { features: FeatureSnapshot[]; unattached: FeatureSnapshot[]; featureSetDigest: Sha256 }

function decodeChildNumbers(d: unknown): number[] | undefined {
  if (!Array.isArray(d)) return undefined;
  const numbers = d.map(x => (typeof x === 'object' && x !== null ? (x as {number?: unknown}).number : undefined));
  return numbers.every(n => typeof n === 'number' && Number.isSafeInteger(n) && n > 0) ? numbers as number[] : undefined;
}

function checkFeature(s: Awaited<ReturnType<typeof readIssue>>, number: number, epicIssue: number, options: FeatureSetOptions, problems: Problem[]): FeatureSnapshot | undefined {
  const at = `features[#${number}]`;
  if (!s.ok) { problems.push(...s.problems.map(p => ({...p, path: `${at}.${p.path}`}))); return undefined; }
  const doc = s.value.doc;
  if (doc.kind !== 'feature') { problems.push(problem('UNKNOWN_CHILD', at, `Child #${number} is a ${doc.kind}, not a Feature.`)); return undefined; }
  if (doc.workflowId !== options.workflowId) problems.push(problem('WORKFLOW_MISMATCH', at, `#${number} belongs to another workflow.`));
  if (doc.parentEpic !== epicIssue) problems.push(problem('PARENT_MISMATCH', at, `#${number} names Epic #${doc.parentEpic}.`));
  const types = s.value.labels.filter(l => l.startsWith('Type: ')), scopes = s.value.labels.filter(l => l.startsWith('Scope: '));
  if (types.length !== 1 || types[0] !== 'Type: Scaffold' || scopes.length !== 1 || scopes[0] !== 'Scope: Feature') problems.push(problem('CLASSIFICATION_MISMATCH', at, `#${number} must carry exactly Type: Scaffold and Scope: Feature.`));
  return s.value as FeatureSnapshot;
}

/** Reads every native child (all pages, closed included) and validates workflow/parent/classification/limits. */
export async function readFeatureSet(repo: string, epicIssue: number, bridge: PiGhBridge, scope: CallScope, options: FeatureSetOptions): Promise<Decoded<FeatureSet>> {
  const listed = await bridge.call('gh_subissues_list', {repo, issue: epicIssue}, decodeChildNumbers, scope);
  if (listed.status !== 'ok') return failed([problem('FEATURE_SET_INCOMPLETE', 'features', 'The native sub-issue list could not be read completely.'), ...listed.problems]);
  const numbers = listed.data!;
  const extra = (options.knownCreated ?? []).filter(k => !numbers.includes(k.number));
  if (numbers.length + extra.length > LIMITS.features) return failed([problem('LIMIT_EXCEEDED', 'features', `An Epic may have at most ${LIMITS.features} Features (found ${numbers.length + extra.length}).`)]);
  const problems: Problem[] = [];
  const features: FeatureSnapshot[] = [], unattached: FeatureSnapshot[] = [];
  for (const n of numbers) { const f = checkFeature(await readIssue(repo, n, bridge, scope), n, epicIssue, options, problems); if (f) features.push(f); }
  for (const k of extra) {
    const f = checkFeature(await readIssue(repo, k.number, bridge, scope), k.number, epicIssue, options, problems);
    if (f && f.doc.createOperationId !== k.createOperationId) problems.push(problem('CREATE_OPERATION_MISMATCH', `features[#${k.number}]`, `#${k.number} was not created by the recorded operation.`));
    else if (f) unattached.push(f);
  }
  const keys = new Map<string, number>();
  for (const f of [...features, ...unattached]) {
    const prev = keys.get(f.doc.featureKey);
    if (prev !== undefined) problems.push(problem('DUPLICATE_ID', `features[#${f.number}].featureKey`, `${f.doc.featureKey} is used by #${prev} and #${f.number}.`));
    keys.set(f.doc.featureKey, f.number);
  }
  if (problems.length) return failed(problems);
  const membership = [...features, ...unattached].map(f => ({issue: f.number, featureKey: f.doc.featureKey})).sort((a, b) => a.issue - b.issue);
  return okValue({features, unattached, featureSetDigest: taggedDigest('feature-set', membership)});
}
