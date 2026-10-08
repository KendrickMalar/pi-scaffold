// Managed label names (#1/#3) and the minimal delta for one Issue. Nothing outside the managed set is touched.
import {LIMITS, STAGES, failed, okValue, problem, type Decoded, type IssueSnapshot, type PreparedIssueLabels, type Problem, type Stage} from './contracts.js';
import {labelsSha256} from './digests.js';

export interface LabelTarget {
  type: 'Scaffold' | 'Jig'; scope: 'Epic' | 'Feature' | 'Task'; stage: Stage;
  wave?: number;
  /** true adds Blocked; false is only for an explicitly confirmed release. Omit to keep the current state. */
  blocked?: boolean;
}

const STAGE_LABEL: Record<Stage, string | undefined> = {
  setup: undefined, specification: 'Stage: Specification', 'basic-design': 'Stage: BasicDesign',
  implementation: 'Stage: Implementation', verification: 'Stage: Verification', completed: 'Stage: Completed',
};
export const TYPE_LABELS = ['Type: Scaffold', 'Type: Jig'] as const;
export const SCOPE_LABELS = ['Scope: Epic', 'Scope: Feature', 'Scope: Task'] as const;
export const STAGE_LABELS = STAGES.map(s => STAGE_LABEL[s]).filter((l): l is string => !!l);
export const BLOCKED_LABEL = 'Blocked';
export const FIXED_LABEL_NAMES: readonly string[] = [...TYPE_LABELS, ...SCOPE_LABELS, ...STAGE_LABELS, BLOCKED_LABEL];

export function stageLabelName(stage: Stage): string | undefined { return STAGE_LABEL[stage]; }
export function waveLabelName(wave: number): string {
  if (typeof wave !== 'number' || !Number.isSafeInteger(wave) || wave < LIMITS.waveMin || wave > LIMITS.waveMax) throw new RangeError(`Invalid wave ${String(wave)}; expected an integer from ${LIMITS.waveMin} to ${LIMITS.waveMax}.`);
  return `Wave: ${wave}`;
}
const WAVE_RE = /^Wave: ([1-9]\d{0,2})$/;
function canonicalWave(label: string): number | undefined {
  const m = WAVE_RE.exec(label); if (!m) return undefined;
  const n = Number(m[1]); return n >= LIMITS.waveMin && n <= LIMITS.waveMax ? n : undefined;
}
const squash = (s: string) => s.toLowerCase().replace(/\s+/g, '');
const MANAGED_SQUASHED = new Set(FIXED_LABEL_NAMES.map(squash));
/** A label that looks managed but is not spelled canonically (case, spacing, old prefix, zero padding). */
function isNoncanonical(label: string): boolean {
  if (FIXED_LABEL_NAMES.includes(label) || canonicalWave(label) !== undefined) return false;
  const s = squash(label);
  return MANAGED_SQUASHED.has(s) || /^wave:/.test(s) || /^(type|scope|stage):/.test(s);
}
const SCOPE_KIND: Record<LabelTarget['scope'], IssueSnapshot['doc']['kind']> = {Epic: 'epic', Feature: 'feature', Task: 'task'};

export function planManagedLabelDelta(snapshot: IssueSnapshot, target: LabelTarget): {add: string[]; remove: string[]; problems: Problem[]} {
  const problems: Problem[] = [];
  const stop = () => ({add: [], remove: [], problems});
  const labels = snapshot.labels;
  for (const l of labels) if (isNoncanonical(l)) problems.push(problem('NONCANONICAL_LABEL', 'labels', `"${l}" is not a canonical managed label; it is not renamed automatically.`));
  const types = labels.filter(l => (TYPE_LABELS as readonly string[]).includes(l));
  const scopes = labels.filter(l => (SCOPE_LABELS as readonly string[]).includes(l));
  const stages = labels.filter(l => STAGE_LABELS.includes(l));
  const waves = labels.filter(l => canonicalWave(l) !== undefined);
  for (const [group, found] of [['Type', types], ['Scope', scopes], ['Stage', stages], ['Wave', waves]] as const)
    if (found.length > 1) problems.push(problem('DUPLICATE_MANAGED_LABEL', 'labels', `More than one ${group} label: ${found.join(', ')}.`));
  if (target.type !== 'Scaffold') problems.push(problem('TYPE_NOT_ALLOWED', 'target.type', 'Scaffold services only manage Type: Scaffold.'));
  if (types.length === 1 && types[0] !== 'Type: Scaffold') problems.push(problem('TYPE_CONFLICT', 'labels', `Issue is ${types[0]}; Type is never changed automatically.`));
  const wantScope = `Scope: ${target.scope}`;
  if (scopes.length === 1 && scopes[0] !== wantScope) problems.push(problem('SCOPE_CONFLICT', 'labels', `Issue is ${scopes[0]}, not ${wantScope}.`));
  if (snapshot.doc.kind !== SCOPE_KIND[target.scope]) problems.push(problem('BODY_MISMATCH', 'doc.kind', `Managed body is ${snapshot.doc.kind}, not ${target.scope}.`));
  if (target.wave !== undefined && !(Number.isSafeInteger(target.wave) && target.wave >= LIMITS.waveMin && target.wave <= LIMITS.waveMax)) problems.push(problem('INVALID_WAVE', 'target.wave', 'Wave must be an integer from 1 to 200.'));
  if (problems.length) return stop();

  const currentStageLabel = stages[0];
  const currentStage = currentStageLabel === undefined ? 'setup' : STAGES.find(s => STAGE_LABEL[s] === currentStageLabel)!;
  const transition = currentStage !== target.stage;
  if (STAGES.indexOf(target.stage) < STAGES.indexOf(currentStage)) problems.push(problem('STAGE_REGRESSION', 'target.stage', `Stage cannot move back from ${currentStage} to ${target.stage} here.`));
  const docStage = 'stage' in snapshot.doc ? snapshot.doc.stage : undefined;
  if (docStage !== undefined && docStage !== currentStage && docStage !== target.stage) problems.push(problem('BODY_MISMATCH', 'doc.stage', `Body stage ${docStage} matches neither the label stage ${currentStage} nor the target ${target.stage}.`));
  const isBlocked = labels.includes(BLOCKED_LABEL);
  if (target.blocked === false && transition) problems.push(problem('BLOCKED_RELEASE_WITH_TRANSITION', 'target.blocked', 'Releasing Blocked must be its own confirmed call, not a side effect of a stage transition.'));
  else if (isBlocked && transition && target.blocked !== false) problems.push(problem('BLOCKED', 'labels', 'Issue is Blocked; stage cannot progress until it is explicitly released.'));
  if (problems.length) return stop();

  const add: string[] = [], remove: string[] = [];
  if (!types.length) add.push('Type: Scaffold');
  if (!scopes.length) add.push(wantScope);
  if (transition) {
    if (currentStageLabel) remove.push(currentStageLabel);
    const next = STAGE_LABEL[target.stage]; if (next) add.push(next);
  }
  if (target.wave !== undefined) {
    const wanted = waveLabelName(target.wave);
    if (waves[0] !== wanted) { if (waves[0]) remove.push(waves[0]); add.push(wanted); }
  }
  if (target.blocked === true && !isBlocked) add.push(BLOCKED_LABEL);
  if (target.blocked === false && isBlocked) remove.push(BLOCKED_LABEL);
  return {add, remove, problems};
}

/** B2 change artifact. Refuses snapshots whose labels no longer match their recorded hash. */
export function prepareLabelEdit(snapshot: IssueSnapshot, target: LabelTarget): Decoded<PreparedIssueLabels> {
  if (labelsSha256(snapshot.labels) !== snapshot.labelsSha256) return failed([problem('STALE_SNAPSHOT', 'labels', 'Label snapshot does not match its hash; read the Issue again.')]);
  const delta = planManagedLabelDelta(snapshot, target);
  if (delta.problems.length) return failed(delta.problems);
  return okValue({version: 1, repo: snapshot.repo, operation: 'issue-labels-if-current', issue: snapshot.number, add: delta.add, remove: delta.remove, expectedLabelsSha256: snapshot.labelsSha256});
}
