// #16 scaffold_epic_complete: final acceptance of a verification-stage Epic. Everything is checked (specification,
// requirement coverage, final evidence, verifiedRef contained in origin's default branch, optional Project target) and the
// parent TUI accepts exactly that; then body/Stage (B1/B2) → close (B3) → read back → Project Done → read back →
// the Projects recorded on the Epic closed and read back, journaled. Once this operation has closed the Issue, a resume only finishes the Project steps. No reopen, rollback or notification.
import {join} from 'node:path';
import {
  decodeMutationInput, isGitObjectId, isSha256, problem,
  type ApprovalRef, type Decoded, type EpicDocV1, type GitObjectId, type IssueSnapshot, type MutationInput, type OwnedEvidenceRef, type Problem, type ScaffoldResult,
} from '../core/contracts.js';
import {approvalNeedsConfirmation, approvalViewDigest, withAgentApproval} from '../core/approvals.js';
import {patchDoc} from '../core/body-codec.js';
import {taggedDigest} from '../core/digests.js';
import {writeOwnedFile} from '../core/files.js';
import {withOperation} from '../core/lifecycle.js';
import {prepareLabelEdit} from '../core/label-policy.js';
import {evidenceRootOf, readEvidence} from '../core/evidence.js';
import {checkCompletion, completionApprovalView, type CompletionResult} from '../core/completion-gate.js';
import type {ToolCall} from '../core/runtime.js';
import {readIssue} from '../ports/pi-gh.js';
import {readFeatureSet} from '../ports/feature-set.js';
import {readEpicTree} from '../ports/epic-tree.js';
import {linked, planProjectClose, type ProjectClosePlan} from '../core/project-close-plan.js';

export const EPIC_COMPLETE = 'scaffold_epic_complete';
export interface ProjectTarget { projectId: string; itemId: string; statusFieldId: string; doneOptionId: string }
export type EpicCompleteInput = MutationInput & {verifiedRef: GitObjectId; finalEvidenceRefs: OwnedEvidenceRef[]; project?: ProjectTarget};
export interface EpicCompleteData {
  issueClosed: boolean; projectUpdated: boolean; verifiedRef: string; remoteMainRef: string; pendingStep: string | null;
  projectsClosed: string[]; projectsSkipped: ProjectClosePlan['skipped'];
}

export function decodeEpicCompleteInput(value: unknown): Decoded<EpicCompleteInput> {
  const normalized = (x: unknown) => typeof x === 'string' && !x.includes('@') && !x.startsWith('/') && x.split('/').every(s => s !== '' && s !== '.' && s !== '..');
  return decodeMutationInput<{verifiedRef: GitObjectId; finalEvidenceRefs: OwnedEvidenceRef[]; project?: ProjectTarget}>(value, {
    verifiedRef: {decode: (r, v, p) => r.pattern(v, p, isGitObjectId, 'a full 40/64 hex commit id (not HEAD or a branch)')},
    finalEvidenceRefs: {decode: (r, v, p) => {
      const list = r.array(v, p, (x, q) => { const o = r.object(x, q, ['relativePath', 'sha256']) ?? {}; return {relativePath: r.pattern(o.relativePath, `${q}.relativePath`, normalized, 'a normalized path inside evidence/ without "@"'), sha256: r.pattern(o.sha256, `${q}.sha256`, isSha256, 'sha256')}; }, 50);
      if (Array.isArray(v) && !v.length) r.add('EMPTY', p, 'Give one final report per Feature.');
      return list;
    }},
    project: {optional: true, decode: (r, v, p) => {
      const o = r.object(v, p, ['projectId', 'itemId', 'statusFieldId', 'doneOptionId']) ?? {};
      const id = (re: RegExp, what: string) => (x: unknown) => typeof x === 'string' && re.test(x);
      return {projectId: r.pattern(o.projectId, `${p}.projectId`, id(/^PVT_[A-Za-z0-9_-]{1,200}$/, ''), 'PVT_…'), itemId: r.pattern(o.itemId, `${p}.itemId`, id(/^PVTI_[A-Za-z0-9_-]{1,200}$/, ''), 'PVTI_…'),
        statusFieldId: r.pattern(o.statusFieldId, `${p}.statusFieldId`, id(/^PVTSSF_[A-Za-z0-9_-]{1,200}$/, ''), 'PVTSSF_…'), doneOptionId: r.pattern(o.doneOptionId, `${p}.doneOptionId`, id(/^[A-Za-z0-9_-]{1,200}$/, ''), 'an option id')};
    }},
  });
}

interface ProjectField { id?: unknown; dataType?: unknown; options?: {id?: unknown}[] }
interface ProjectItem { id?: unknown; content?: {__typename?: unknown; number?: unknown; repository?: {nameWithOwner?: unknown}} | null; fieldValues?: {nodes?: {optionId?: unknown; field?: {id?: unknown}}[]} }

export async function completeEpic(input: EpicCompleteInput, call: ToolCall): Promise<ScaffoldResult<EpicCompleteData>> {
  const operation = EPIC_COMPLETE;
  const blocked = (problems: Problem[]): ScaffoldResult<EpicCompleteData> => ({status: 'blocked', operation, problems});
  const tools = ['gh_issue_get', 'gh_subissues_list', 'gh_issue_edit_if_current', 'gh_issue_labels_if_current', 'gh_issue_close_if_current', ...(input.project ? ['gh_project_get', 'gh_project_items', 'gh_project_field_update'] : [])];
  const caps = await call.bridge.requireCapabilities(tools, call.scope);
  if (!caps.ok) return blocked(caps.problems);
  const repoOnly = await call.repoContext(input.repo, null);
  if (!repoOnly.ok) return blocked(repoOnly.problems);
  const snap = await readIssue(input.repo, input.epicIssue, call.bridge, call.scope);
  if (!snap.ok) return blocked(snap.problems);
  if (snap.value.doc.kind !== 'epic') return blocked([problem('NOT_AN_EPIC', 'epicIssue', `#${input.epicIssue} is not a Scaffold Epic.`)]);
  const epic = snap.value.doc;
  if (epic.projectIds?.length) {
    const more = await call.bridge.requireCapabilities(['gh_project_get', 'gh_project_items', 'gh_project_close'], call.scope);
    if (!more.ok) return blocked(more.problems);
  }
  const context = await call.repoContext(input.repo, epic.workflowId);
  if (!context.ok) return blocked(context.problems);
  const journal = call.journal(context.value);
  const record = await journal.load(input.operationId);
  // Only a confirmed close of this operation skips the checks; an uncertain close goes through the full gate again.
  const closedByUs = !!record && record.steps.some(s => s.name === 'close' && s.phase === 'done');
  const started = !!record && record.steps.some(s => !s.note && s.phase !== 'failed');

  const readProject = async () => {
    const p = input.project!;
    const [fields, items] = [await call.bridge.call('gh_project_get', {projectId: p.projectId}, d => (d as {fields?: ProjectField[]} | null)?.fields, call.scope), await call.bridge.call('gh_project_items', {projectId: p.projectId}, d => (d as {items?: ProjectItem[]} | null)?.items, call.scope)];
    return {fields: fields.status === 'ok' ? fields.data! : undefined, items: items.status === 'ok' ? items.data! : undefined};
  };
  // A recorded Project: whether it shows closed (undefined when it cannot be read).
  const projectClosed = async (projectId: string) => { const r = await call.bridge.call('gh_project_get', {projectId}, d => typeof (d as {closed?: unknown} | null)?.closed === 'boolean' ? (d as {closed: boolean}).closed : undefined, call.scope); return r.status === 'ok' ? r.data! : undefined; };
  // A recorded Project's closed flag and linked repositories (nameWithOwner); an answer without them counts as unreadable.
  const decodeProjectState = (d: unknown) => { const v = d as {closed?: unknown; repositories?: unknown} | null; return typeof v?.closed === 'boolean' && Array.isArray(v.repositories) && v.repositories.every(r => typeof r === 'string') ? {closed: v.closed, repositories: v.repositories as string[]} : undefined; };
  const readProjectState = (projectId: string) => call.bridge.call('gh_project_get', {projectId}, decodeProjectState, call.scope);
  // Report only the Projects that read back closed now.
  const stillClosed = async (ids: string[]) => { const out: string[] = []; for (const id of ids) if ((await projectClosed(id)) === true) out.push(id); return out; };
  /** Stands in for the plan of an operation journaled before plans were recorded. */
  const NO_PLAN: ProjectClosePlan = {close: [], alreadyClosed: [], skipped: [{projectId: null, reason: 'not-recorded'}]};
  const projectDone = (items: ProjectItem[] | undefined) => !!items?.find(i => i.id === input.project!.itemId)?.fieldValues?.nodes?.some(v => v.field?.id === input.project!.statusFieldId && v.optionId === input.project!.doneOptionId);

  let gate: CompletionResult | undefined;
  let approval: ApprovalRef | undefined;
  let closePlan: ProjectClosePlan | undefined;
  if (!closedByUs) {
    // ---- everything is (re)checked until this operation has closed the Issue; an already-closed Epic is no shortcut ----
    const pre: Problem[] = [];
    const allowedStage = started ? ['verification', 'completed'] : ['verification'];
    if (!allowedStage.includes(epic.stage)) pre.push(problem('STAGE_MISMATCH', 'stage', `Epic is in ${epic.stage}, not verification.`));
    // Checked on every call, not only as part of a stage transition.
    if (snap.value.labels.includes('Blocked')) pre.push(problem('BLOCKED', 'labels', 'The Epic is Blocked.'));
    const stageLabels = snap.value.labels.filter(l => l.startsWith('Stage: '));
    // A label change this operation sent (done, or uncertain and reconciled below) may already show Stage: Completed.
    const labelsDone = !!record?.steps.some(s => s.name === 'epic-labels' && s.phase !== 'failed');
    const okLabels = labelsDone ? [['Stage: Completed'], ['Stage: Verification']] : [['Stage: Verification']];
    if (!okLabels.some(o => JSON.stringify(o) === JSON.stringify(stageLabels))) pre.push(problem('STAGE_LABEL_MISMATCH', 'labels', `Stage labels [${stageLabels.join(', ')}] do not match a verification Epic.`));
    if (snap.value.state === 'closed' && snap.value.stateReason !== undefined && snap.value.stateReason !== 'completed' && !closedByUs) pre.push(problem('CLOSED_NOT_COMPLETED', 'epicIssue', `The Epic was closed as ${snap.value.stateReason ?? 'unknown'}; it is not marked completed here (reopen it yourself first if that was a mistake).`));
    if (!started) {
      // An Epic closed by hand is not completed by that alone: it goes through the same checks and acceptance (closing is then a no-op).
      if (snap.value.bodySha256 !== input.expectedBodySha256) pre.push(problem('STALE_BODY', 'expectedBodySha256', 'Epic body changed; read it again.'));
      if (epic.revision !== input.expectedRevision) pre.push(problem('STALE_REVISION', 'expectedRevision', `Epic revision is ${epic.revision}.`));
      const labels = prepareLabelEdit(snap.value, {type: 'Scaffold', scope: 'Epic', stage: 'completed'});
      if (!labels.ok) pre.push(...labels.problems);
    }
    if (pre.length) return blocked(pre);
    const set = await readFeatureSet(input.repo, input.epicIssue, call.bridge, call.scope, {workflowId: epic.workflowId});
    if (!set.ok) return blocked(set.problems);
    const ev = await readEvidence(input.finalEvidenceRefs, evidenceRootOf(context.value.workflowStateRoot), call.namespaceRoot);
    gate = await checkCompletion({epic, features: set.value.features, reports: ev.reports, verifiedRef: input.verifiedRef, git: call.runtime.git, repoRoot: repoOnly.value.repoRoot});
    const problems = [...ev.problems, ...gate.problems];
    // The whole tree must be closed by hand first; recorded Projects are closed only if they hold nothing but this tree.
    const tree = await readEpicTree(input.repo, input.epicIssue, call.bridge, call.scope);
    if (!tree.ok) problems.push(...tree.problems);
    else {
      const open = tree.value.filter(i => i.parent !== null && i.state === 'open').map(i => `#${i.number}`);
      if (open.length) problems.push(problem('TREE_ISSUES_OPEN', 'tree', `Close the Features and Tasks first: ${open.join(', ')} still open.`));
      const projects: {projectId: string; closed: boolean; repositories: string[]; items: unknown[]}[] = [];
      for (const projectId of epic.projectIds ?? []) {
        const got = await readProjectState(projectId);
        const items = await call.bridge.call('gh_project_items', {projectId}, d => Array.isArray((d as {items?: unknown} | null)?.items) ? (d as {items: unknown[]}).items : undefined, call.scope);
        if (got.status !== 'ok' || items.status !== 'ok') problems.push(problem('PROJECT_UNREADABLE', `projectIds[${projectId}]`, `The recorded Project ${projectId} could not be read.`));
        else projects.push({projectId, ...got.data!, items: items.data!});
      }
      if (projects.length === (epic.projectIds ?? []).length) closePlan = planProjectClose(epic.projectIds, tree.value, input.repo, projects);
    }
    if (input.project) {
      const pr = await readProject();
      const field = pr.fields?.find(f => f.id === input.project!.statusFieldId);
      const item = pr.items?.find(i => i.id === input.project!.itemId);
      const itemIsEpic = item?.content?.__typename === 'Issue' && item.content.number === input.epicIssue && String(item.content.repository?.nameWithOwner ?? '').toLowerCase() === input.repo.toLowerCase();
      if (!pr.fields || !pr.items) problems.push(problem('PROJECT_UNREADABLE', 'project', 'The Project could not be read.'));
      else if (!itemIsEpic || !field || field.dataType !== 'SINGLE_SELECT' || !field.options?.some(o => o.id === input.project!.doneOptionId)) problems.push(problem('PROJECT_TARGET_INVALID', 'project', 'The Project item is not this Epic, or the field is not a single-select holding the Done option.'));
    }
    if (problems.length) return blocked(problems);
    const view = completionApprovalView(epic, set.value.featureSetDigest, input.finalEvidenceRefs, gate, set.value.features, input.project, closePlan);
    const existing = await call.approvals.requireContentApproval('epic-completion', epic.workflowId, approvalViewDigest('epic-completion', view), context.value);
    if (existing.ok) approval = existing.value;
    else {
      if (!approvalNeedsConfirmation(existing.problems)) return blocked(existing.problems);
      if (call.environment().PI_SUBAGENT_CHILD) return blocked([problem('APPROVAL_UI_REQUIRED', 'epic-completion', 'A subagent child cannot give the final acceptance.')]);
      const confirmed = await call.approvals.confirmContent('epic-completion', epic.workflowId, view, context.value, call.env.approvalUi, call.scope, await call.approvalOptions(input.repo, epic.workflowId, 'epic-completion'));
      if (confirmed.status !== 'validated') return {status: confirmed.status, operation, problems: confirmed.problems};
      approval = confirmed.data;
    }
  }

  const dir = join(context.value.workflowStateRoot, 'complete', input.operationId);
  const {operationId: _id, ...payload} = input;
  const reread = async (stop: (p: Problem[]) => never) => { const r = await readIssue(input.repo, input.epicIssue, call.bridge, call.scope); if (!r.ok) stop(r.problems); return (r as {ok: true; value: IssueSnapshot}).value; };
  const result = await withOperation<EpicCompleteData>({
    operation, repo: input.repo, workflowId: epic.workflowId, operationId: input.operationId,
    payloadDigest: taggedDigest('epic-complete', payload), journal, scope: call.scope,
  }, async run => {
    const refs = (run.done('refs') as {remoteMainRef: string} | undefined) ?? (run.note('refs', {remoteMainRef: gate!.remoteMainRef}), {remoteMainRef: gate!.remoteMainRef!});
    // The Projects to close are those accepted with this completion; a resume after the close reuses them and does not plan again.
    if (closePlan) run.note('projects-plan', closePlan);
    let plan = (run.done('projects-plan') as ProjectClosePlan | undefined) ?? NO_PLAN;
    // A change an earlier run sent without a confirmed outcome goes through run.write (its reconcile reads GitHub)
    // even when GitHub already shows it; skipping it would leave the operation uncertain on every resume.
    const pending = (step: string) => run.record.steps.some(s => s.name === step && (s.phase === 'requested' || s.phase === 'unknown'));
    // 1. Body (B1): stage completed.
    let current = await reread(run.stop);
    if ((current.doc as EpicDocV1).stage !== 'completed' || pending('epic-body')) {
      const edit = patchDoc(current, {...(current.doc as EpicDocV1), stage: 'completed'});
      if (!edit.ok) return run.stop(edit.problems);
      const path = join(dir, 'body.json');
      await writeOwnedFile(path, JSON.stringify(edit.value), {root: call.namespaceRoot});
      const expected = edit.value;
      await run.write('epic-body', () => call.bridge.call('gh_issue_edit_if_current', {changePath: path}, () => true as const, call.scope), {
        reconcile: async () => { const s = await reread(run.stop); return (s.doc as EpicDocV1).stage === 'completed' ? 'applied' : s.bodySha256 === expected.expectedBodySha256 ? 'not-applied' : 'unknown'; },
      });
      current = await reread(run.stop);
    }
    // 2. Labels (B2): Stage: Verification → Stage: Completed only.
    if (!current.labels.includes('Stage: Completed') || current.labels.includes('Stage: Verification') || pending('epic-labels')) {
      const plan = prepareLabelEdit(current, {type: 'Scaffold', scope: 'Epic', stage: 'completed'});
      if (!plan.ok) return run.stop(plan.problems);
      const path = join(dir, 'labels.json');
      await writeOwnedFile(path, JSON.stringify(plan.value), {root: call.namespaceRoot});
      await run.write('epic-labels', () => call.bridge.call('gh_issue_labels_if_current', {changePath: path}, () => true as const, call.scope), {
        reconcile: async () => { const s = await reread(run.stop); return s.labels.includes('Stage: Completed') && !s.labels.includes('Stage: Verification') ? 'applied' : s.labelsSha256 === plan.value.expectedLabelsSha256 ? 'not-applied' : 'unknown'; },
      });
      current = await reread(run.stop);
    }
    // 3. Close (B3) and read back.
    const closeStep = run.record.steps.find(s => s.name === 'close');
    if (current.state !== 'closed' || (closeStep && closeStep.phase !== 'done')) {
      const path = join(dir, 'close.json');
      // The precondition is the body this operation checked; it is recorded once and reused on resume.
      if (!closeStep || closeStep.phase === 'failed') {
        run.note('close-expected', {bodySha256: current.bodySha256});
        await writeOwnedFile(path, JSON.stringify({version: 1, repo: input.repo, operation: 'issue-close-if-current', issue: input.epicIssue, reason: 'completed', expectedBodySha256: current.bodySha256}), {root: call.namespaceRoot});
      }
      const expectedBody = (run.done('close-expected') as {bodySha256: string}).bodySha256;
      await run.write('close', () => call.bridge.call('gh_issue_close_if_current', {changePath: path}, () => true as const, call.scope), {
        reconcile: async () => { const s = await reread(run.stop); return s.state === 'closed' ? 'applied' : s.bodySha256 === expectedBody ? 'not-applied' : 'unknown'; },
      });
    }
    current = await reread(run.stop);
    if (current.state !== 'closed' || (current.stateReason !== undefined && current.stateReason !== 'completed') || (current.doc as EpicDocV1).stage !== 'completed' || !current.labels.includes('Stage: Completed')) return run.stop([problem('NOT_COMPLETED', 'epicIssue', 'The Epic does not show as completed and closed.')]);
    // 4. Optional Project: set Status to Done and read it back.
    let projectUpdated = false;
    if (input.project) {
      run.checkpoint();
      if (!projectDone((await readProject()).items) || pending('project')) {
        const path = join(dir, 'project.json');
        await writeOwnedFile(path, JSON.stringify({version: 1, repo: input.repo, operation: 'project-field-update', projectId: input.project.projectId, itemId: input.project.itemId, fieldId: input.project.statusFieldId, value: {singleSelectOptionId: input.project.doneOptionId}}), {root: call.namespaceRoot});
        await run.write('project', () => call.bridge.call('gh_project_field_update', {changePath: path}, () => true as const, call.scope), {
          reconcile: async () => { const it = (await readProject()).items; return it === undefined ? 'unknown' : projectDone(it) ? 'applied' : 'not-applied'; },
        });
      }
      if (!projectDone((await readProject()).items)) return run.stop([problem('PROJECT_NOT_DONE', 'project', 'The Project item does not show Done.')]);
      projectUpdated = true;
    }
    // 5. Recorded Projects: read the link and the items again, close, read back. A link removed or items not of the tree added
    // since the acceptance → left open and reported (not-linked / foreign-items).
    const closedNow: string[] = [];
    if (plan.close.length) {
      run.checkpoint();
      const tree = await readEpicTree(input.repo, input.epicIssue, call.bridge, call.scope);
      if (!tree.ok) return run.stop(tree.problems);
      const byNumber = new Map(tree.value.map(i => [i.number, i]));
      for (const projectId of [...plan.close]) {
        const step = `project-close:${projectId}`;
        const path = join(dir, `project-close-${projectId}.json`);
        if (!run.done(step) && !pending(step)) {
          const state = await readProjectState(projectId);
          if (state.status !== 'ok') return run.stop([problem('PROJECT_UNREADABLE', `projectIds[${projectId}]`, `The recorded Project ${projectId} could not be read.`)]);
          if (!linked(state.data!.repositories, input.repo)) {
            // Not a failure: pi-gh closes only a Project linked to the repo; it is left open and reported for a human to close.
            plan = {...plan, close: plan.close.filter(id => id !== projectId), skipped: [...plan.skipped, {projectId, reason: 'not-linked'}]};
            run.note('projects-plan', plan);
            continue;
          }
          const items = await call.bridge.call('gh_project_items', {projectId}, d => Array.isArray((d as {items?: unknown} | null)?.items) ? (d as {items: ProjectItem[]}).items : undefined, call.scope);
          if (items.status !== 'ok') return run.stop([problem('PROJECT_UNREADABLE', `projectIds[${projectId}]`, `The recorded Project ${projectId} could not be read.`)]);
          const contents = items.data!.map(i => i.content);
          if (!contents.every(c => c?.__typename === 'Issue' && typeof c.number === 'number' && byNumber.has(c.number) && String(c.repository?.nameWithOwner ?? '').toLowerCase() === input.repo.toLowerCase())) {
            // Not a failure: the Project is left open and reported; the recorded plan keeps it out of a resume.
            plan = {...plan, close: plan.close.filter(id => id !== projectId), skipped: [...plan.skipped, {projectId, reason: 'foreign-items'}]};
            run.note('projects-plan', plan);
            continue;
          }
          const open = contents.filter(c => byNumber.get(c!.number as number)!.state === 'open' || (c as {state?: unknown}).state === 'OPEN').map(c => `#${c!.number}`);
          if (open.length) return run.stop([problem('PROJECT_ITEMS_OPEN', `projectIds[${projectId}]`, `Project ${projectId} holds Issues open again: ${open.join(', ')}. Close them and resume with the same operationId.`)]);
          await writeOwnedFile(path, JSON.stringify({version: 1, repo: input.repo, operation: 'project-close', projectId}), {root: call.namespaceRoot});
        }
        await run.write(step, () => call.bridge.call('gh_project_close', {changePath: path}, () => true as const, call.scope), {
          reconcile: async () => { const c = await projectClosed(projectId); return c === undefined ? 'unknown' : c ? 'applied' : 'not-applied'; },
        });
        if ((await projectClosed(projectId)) !== true) return run.stop([problem('PROJECT_NOT_CLOSED', `projectIds[${projectId}]`, `The recorded Project ${projectId} does not show as closed.`)]);
        closedNow.push(projectId);
      }
    }
    return {status: 'applied', data: {issueClosed: true, projectUpdated, verifiedRef: input.verifiedRef, remoteMainRef: refs.remoteMainRef, pendingStep: null, projectsClosed: [...await stillClosed(plan.alreadyClosed), ...closedNow], projectsSkipped: plan.skipped}};
  });
  if ((result.status === 'partial' || result.status === 'unknown' || result.status === 'blocked') && (await journal.load(input.operationId))) {
    // Report from what GitHub shows now, not from the journal alone.
    const rec = await journal.load(input.operationId);
    const now = await readIssue(input.repo, input.epicIssue, call.bridge, call.scope);
    const remote = (rec?.steps.find(s => s.name === 'refs')?.data as {remoteMainRef?: string} | undefined)?.remoteMainRef ?? gate?.remoteMainRef ?? '';
    if (now.ok) {
      const d = now.value.doc as EpicDocV1;
      const issueClosed = now.value.state === 'closed';
      const plan = (rec?.steps.find(s => s.name === 'projects-plan' && s.phase === 'done')?.data as ProjectClosePlan | undefined) ?? closePlan ?? NO_PLAN;
      // The Project steps run after the close; once it shows closed they are reported from what GitHub shows now.
      const projectUpdated = issueClosed && !!input.project && projectDone((await readProject()).items);
      const projectsClosed = await stillClosed(plan.alreadyClosed);
      if (issueClosed) for (const id of plan.close) if ((await projectClosed(id)) === true) projectsClosed.push(id);
      const pendingStep = d.stage !== 'completed' ? 'epic-body' : !now.value.labels.includes('Stage: Completed') ? 'epic-labels' : !issueClosed ? 'close'
        : input.project && !projectUpdated ? 'project' : plan.close.some(id => !projectsClosed.includes(id)) ? 'project-close' : null;
      return withAgentApproval({...result, data: {issueClosed, projectUpdated, verifiedRef: input.verifiedRef, remoteMainRef: remote, pendingStep, projectsClosed, projectsSkipped: plan.skipped}} as ScaffoldResult<EpicCompleteData>, approval);
    }
  }
  return withAgentApproval(result as ScaffoldResult<EpicCompleteData>, approval);
}
