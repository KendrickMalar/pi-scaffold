// scaffold_stage_check (read-only): before resuming work after reload, plan-mode switch or interruption, check that this
// session can do its stage — the read tools are active and the Epic's pinned docs match in this cwd. Never changes anything.
import {StrictReader, isRepoRef, problem, type Decoded, type ScaffoldResult, type Stage} from '../core/contracts.js';
import type {ToolCall} from '../core/runtime.js';
import {readIssue} from '../ports/pi-gh.js';
import {pinnedDocRefs, verifyPinnedDocs} from '../core/pinned-docs.js';
import {checkSpecificationReady} from '../core/specification-gate.js';
import {hasPlanPending, readEpicWait, type EpicWait} from '../core/epic-wait.js';

export const STAGE_CHECK = 'scaffold_stage_check';
export interface StageCheckInput { repo: string; epicIssue: number }
export interface StageCheckData {
  stage: Stage | null; passed: boolean; missingReadTools: string[]; missingStageTools: string[]; docProblems: {path: string; message: string}[];
  /** Whether the specification is complete (the handoff gate's check); null outside the specification stage. */
  specificationReady: boolean | null;
  /** The orchestrator's wait: the scaffold:plan-pending mark and open Epics of this repo the Epic is blocked by. */
  waiting: EpicWait;
}

// Plan mode keeps only gh reads, so only those count as required here.
export const READ_TOOLS = ['gh_capabilities', 'gh_issue_get'];
export const STAGE_TOOLS: Partial<Record<Stage, string[]>> = {
  specification: ['scaffold_specification_update', 'scaffold_research_begin', 'scaffold_research_resolve', 'scaffold_handoff_basic_design'],
  'basic-design': ['scaffold_feature_create', 'scaffold_dependencies_apply', 'scaffold_waves_apply', 'scaffold_handoff_implementation'],
  implementation: ['scaffold_handoff_verification'],
  verification: ['scaffold_epic_complete'],
};

export function decodeStageCheckInput(value: unknown): Decoded<StageCheckInput> {
  const r = new StrictReader();
  const o = r.object(value, '', ['repo', 'epicIssue']);
  if (!o) return r.result(undefined as never);
  return r.result({repo: r.pattern(o.repo, 'repo', isRepoRef, 'OWNER/REPO'), epicIssue: r.int(o.epicIssue, 'epicIssue')});
}

export async function stageCheck(input: StageCheckInput, call: ToolCall): Promise<ScaffoldResult<StageCheckData>> {
  const operation = STAGE_CHECK;
  const active = call.runtime.activeToolNames?.() ?? call.env.toolNames();
  const missingReadTools = READ_TOOLS.filter(t => !active.includes(t));
  const empty: StageCheckData = {stage: null, passed: false, missingReadTools, missingStageTools: [], docProblems: [], specificationReady: null, waiting: {planPending: false, openBlockers: []}};
  if (missingReadTools.includes('gh_issue_get')) return {status: 'blocked', operation, problems: [problem('REQUIRED_TOOL_MISSING', 'tools', `Inactive: ${missingReadTools.join(', ')}.`)], data: empty};
  const caps = await call.bridge.requireCapabilities(['gh_issue_get'], call.scope);
  if (!caps.ok) return {status: 'blocked', operation, problems: caps.problems, data: empty};
  const snap = await readIssue(input.repo, input.epicIssue, call.bridge, call.scope);
  if (!snap.ok) return {status: 'blocked', operation, problems: snap.problems, data: empty};
  if (snap.value.doc.kind !== 'epic') return {status: 'blocked', operation, problems: [problem('NOT_AN_EPIC', 'epicIssue', `#${input.epicIssue} is not a Scaffold Epic.`)], data: empty};
  const stage = snap.value.doc.stage;
  const docs = await verifyPinnedDocs(await (call.env.docsCwd?.() ?? call.env.cwd), pinnedDocRefs(snap.value.doc));
  // gh_dependencies_list is not a required read: when it cannot be read, the problem is reported and passed is unchanged.
  const wait = await readEpicWait(input.repo, snap.value, call);
  const data: StageCheckData = {
    stage, missingReadTools, missingStageTools: (STAGE_TOOLS[stage] ?? []).filter(t => !active.includes(t)),
    docProblems: docs.map(p => ({path: p.path, message: p.message})), passed: false,
    specificationReady: stage === 'specification' ? checkSpecificationReady(snap.value.doc).status === 'validated' : null,
    waiting: wait.ok ? wait.value : {planPending: hasPlanPending(snap.value.labels), openBlockers: []},
  };
  data.passed = !missingReadTools.length && !docs.length;
  const waitProblems = wait.ok ? [] : wait.problems;
  const problems = [...(missingReadTools.length ? [problem('REQUIRED_TOOL_MISSING', 'tools', `Inactive: ${missingReadTools.join(', ')}.`)] : []), ...docs, ...waitProblems];
  return data.passed ? {status: 'validated', operation, problems: waitProblems, data} : {status: 'blocked', operation, problems, data};
}
