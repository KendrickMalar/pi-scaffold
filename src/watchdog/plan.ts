// Pure decision for one handed-off stage session: (target, what this tick saw, remembered state, now) → actions.
// No I/O here; run.ts observes and acts. The transient-error retry reuses the stage watcher's decide().
import {decide, type WatchEntry} from '../watch/decide.js';
import {STAGE_LABELS, stageLabelName} from '../core/label-policy.js';
import {STAGES} from '../core/contracts.js';
import type {ChildRun, Target, TargetObservation, TargetState, WatchdogAction} from './types.js';

export const IDLE_GRACE_MS = 300_000;
export const NUDGE_RETRY_MS = 900_000;
export const MAX_NUDGES_PER_STOP = 2;
export const MAX_NUDGES_PER_STAGE = 8;
export const MAX_RELAUNCH = 3;
export const RELAUNCH_GAP_MS = 300_000;
export const NUDGE_PROMPT = 'scaffold-watchdog: 工程が完了していないまま止まっています。人に質問できるのは仕様策定の工程だけです。意図の範囲内なら自分で決めて記録し、直前の作業を続けてください。';
/** A running child whose status.json is older than this counts as running only while its runner pid lives. */
export const CHILD_STALE_MS = 600_000;
const RUNNING_STATES = new Set(['running', 'queued']);
export const childDonePrompt = (ids: string[], at: number): string => `scaffold-watchdog: 子 run ${ids.join('、')} は ${new Date(at).toISOString()} に完了済みです（完了の知らせが届いていない可能性）。保存された結果を読んで続けてください。`;
/** Values typed into a shell must not need quoting beyond plain single quotes. */
const SAFE_SHELL_VALUE = /^[A-Za-z0-9._\/:@+-]+$/;

export interface PlanOptions { claudeCommand?: string; piCommand?: string; piProfileCommand?: string }

export function planTarget(target: Target, obs: TargetObservation, state: TargetState, now: number, opts: PlanOptions = {}): {actions: WatchdogAction[]; next: TargetState} {
  const s: TargetState = {...state, watch: {...state.watch}};
  const actions: WatchdogAction[] = [];
  const log = (event: string, detail?: string) => actions.push(detail === undefined ? {type: 'log', event} : {type: 'log', event, detail});
  /** Logs only when the situation changed since the last logged one, so a stuck pane does not fill the log. */
  const logOnce = (key: string, event: string, detail?: string) => { if (s.loggedKey === key) return; s.loggedKey = key; log(event, detail); };
  if (s.retired && s.retiredReason) return {actions, next: s};

  const epic = obs.epic;
  if (epic === 'unknown') { logOnce('epic-unknown', 'epic-unknown'); return {actions, next: s}; }
  const label = stageLabelName(target.targetStage);
  const position = stagePosition(epic.stageLabel), own = STAGES.indexOf(target.targetStage);
  // Only a closed Epic or a later stage ends this one. An earlier label means the handoff ran ahead of the label.
  if (epic.closed || (position !== undefined && position > own)) {
    const reason = epic.closed ? 'closed' : 'later';
    if (!s.retired) log('retired', `Epic stage is ${epic.closed ? 'closed' : epic.stageLabel ?? 'unlabelled'}, not ${label}`);
    s.retired = true; s.retiredReason = reason;
    return {actions, next: s};
  }
  if (s.retired) { delete s.retired; log('unretired', `Epic stage is ${epic.stageLabel ?? 'unlabelled'}, not later than ${label}`); }
  if ((position === undefined || position < own) && s.stageLabelLogged !== (epic.stageLabel ?? '')) {
    s.stageLabelLogged = epic.stageLabel ?? '';
    if (position === undefined) log('stage-unknown', epic.stageLabel);
    else log('stage-not-yet', `Epic stage is ${epic.stageLabel ?? 'unlabelled'}, ${label} has not started`);
  }

  const pane = obs.pane;
  switch (pane.kind) {
    case 'missing': logOnce('missing', 'missing'); break;
    case 'outside-tab': logOnce(`outside-tab:${pane.candidates.join(',')}`, 'rebind-candidate-outside-tab', pane.candidates.join(', ')); break;
    case 'ambiguous': logOnce(`ambiguous:${pane.paneIds.join(',')}`, 'rebind-ambiguous', pane.paneIds.join(',')); break;
    case 'replaced': logOnce(`replaced:${pane.socket}:${pane.paneId}`, 'replaced', `${pane.paneId} now runs another session`); break;
    case 'shell': {
      if (s.relaunches >= MAX_RELAUNCH) { logOnce('relaunch-exhausted', 'relaunch-exhausted'); break; }
      if (s.lastRelaunchAt !== undefined && now - s.lastRelaunchAt < RELAUNCH_GAP_MS) break;
      const value = target.agent === 'pi' ? s.lastSeen?.sessionPath : target.sessionId;
      if (!value) { logOnce('relaunch-unknown-session', 'relaunch-unknown-session'); break; }
      if (!SAFE_SHELL_VALUE.test(value)) { logOnce('relaunch-refused', 'relaunch-refused', value); break; }
      // A stage outside the default Profile resumes in its own Profile (the id is from the fixed allowlist, so unquoted).
      const profile = target.profileId;
      const command = target.agent === 'pi'
        ? (profile ? `${opts.piProfileCommand ?? 'pi-profile'} launch --profile ${profile} -- --session '${value}'` : `${opts.piCommand ?? 'pi'} --session '${value}'`)
        : `${opts.claudeCommand ?? 'claude'}${profile ? ` --scaffold-profile=${profile}` : ''} --resume '${value}'`;
      s.relaunches += 1; s.lastRelaunchAt = now; delete s.loggedKey;
      actions.push({type: 'relaunch', socket: pane.socket, paneId: pane.paneId, command});
      break;
    }
    case 'agent': {
      s.lastSeen = {socket: pane.socket, paneId: pane.paneId, ...(pane.sessionPath ? {sessionPath: pane.sessionPath} : s.lastSeen?.sessionPath ? {sessionPath: s.lastSeen.sessionPath} : {})};
      if (pane.revision !== s.lastRevision) { s.lastRevision = pane.revision; s.revisionChangedAt = now; }
      if (pane.status === 'working') { delete s.loggedKey; break; }
      if (pane.status === 'blocked') { logOnce('blocked', 'blocked'); break; }
      if (pane.status !== 'idle' && pane.status !== 'done') { logOnce(`status:${pane.status}`, 'status-unclear', pane.status); break; }
      const tail = pane.tail;
      if (tail?.kind === 'unknown') { logOnce(`tail:${tail.reason}`, 'tail-unknown', tail.reason); break; }
      if (tail?.kind === 'error') {
        if (!tail.transient) { logOnce(`error:${tail.at}`, 'error', tail.message); break; }
        if (obs.ownerAlive) { logOnce(`delegated:${tail.at}`, 'transient-delegated'); break; }
        transient(target, s, tail, pane, now, actions, log);
        break;
      }
      if (tail?.kind === 'stopped' && tail.reason === 'aborted') { logOnce(`aborted:${tail.at}`, 'aborted'); break; }
      const children = pane.children ?? [];
      const live = children.filter(c => childRunning(c, now)).map(c => c.id).sort();
      // The parent is waiting on its own subagent: not a stop, and it does not use up the stage's prompts.
      if (live.length) { logOnce(`waiting-child:${live.join(',')}`, 'waiting-child', live.join(',')); break; }
      const done = tail ? children.filter(c => !RUNNING_STATES.has(c.state) && endOf(c) > tail.at).sort((a, b) => endOf(a) - endOf(b) || a.id.localeCompare(b.id)) : [];
      const text = done.length ? childDonePrompt(done.map(c => c.id), endOf(done[done.length - 1]!)) : NUDGE_PROMPT;
      nudge(target, s, tail ? `t:${tail.at}` : `r:${pane.revision}`, pane, now, actions, logOnce, text);
      break;
    }
  }
  return {actions, next: s};
}

/** Index in STAGES of an Epic's stage label (none = setup); undefined for a label that is not a stage. */
function stagePosition(stageLabel: string | undefined): number | undefined {
  if (stageLabel === undefined) return STAGES.indexOf('setup');
  if (!STAGE_LABELS.includes(stageLabel)) return undefined;
  const i = STAGES.findIndex(st => stageLabelName(st) === stageLabel);
  return i < 0 ? undefined : i;
}

const endOf = (c: ChildRun): number => c.endedAt ?? c.lastUpdate ?? Number.NEGATIVE_INFINITY;
/** Running or queued, and either recently updated or its runner is alive. A stale dead one waits for reconcile. */
function childRunning(c: ChildRun, now: number): boolean {
  if (!RUNNING_STATES.has(c.state)) return false;
  return (c.lastUpdate !== undefined && now - c.lastUpdate < CHILD_STALE_MS) || c.pidAlive === true;
}

function transient(target: Target, s: TargetState, tail: {at: number; message: string; transient: boolean; kind: 'error'}, pane: {socket: string; paneId: string; revision: number}, now: number, actions: WatchdogAction[], log: (e: string, d?: string) => void): void {
  const entry: WatchEntry = {ownerSessionId: target.ownerSessionId ?? '', paneId: pane.paneId, tabId: '', workspaceId: '', targetSessionId: target.sessionId, cwd: target.cwd, repo: target.repo, epicIssue: target.epicIssue, targetStage: target.targetStage, addedAt: ''};
  const r = decide(entry, s.watch, {kind: 'idle', tail, sessionConfirmed: true}, now);
  s.watch = r.next;
  for (const a of r.actions) {
    if (a.type === 'notify') log('transient', a.text);
    else if (a.type === 'prompt') actions.push({type: 'prompt', socket: pane.socket, paneId: pane.paneId, text: a.text, revision: pane.revision, reason: 'transient'});
  }
}

function nudge(target: Target, s: TargetState, stopKey: string, pane: {socket: string; paneId: string; revision: number}, now: number, actions: WatchdogAction[], logOnce: (k: string, e: string, d?: string) => void, text: string): void {
  if (target.targetStage === 'specification') { logOnce('awaiting-human', 'awaiting-human'); return; }
  if (now - (s.revisionChangedAt ?? now) < IDLE_GRACE_MS) return;
  if (s.nudges >= MAX_NUDGES_PER_STAGE) { logOnce('stage-exhausted', 'stage-exhausted'); return; }
  if (s.stopKey !== stopKey) { s.stopKey = stopKey; s.stopNudges = 0; delete s.lastNudgeAt; }
  if (s.stopNudges >= MAX_NUDGES_PER_STOP) { logOnce(`nudge-exhausted:${stopKey}`, 'nudge-exhausted'); return; }
  if (s.lastNudgeAt !== undefined && now - s.lastNudgeAt < NUDGE_RETRY_MS) return;
  s.nudges += 1; s.stopNudges += 1; s.lastNudgeAt = now; delete s.loggedKey;
  actions.push({type: 'prompt', socket: pane.socket, paneId: pane.paneId, text, revision: pane.revision, reason: 'nudge'});
}
