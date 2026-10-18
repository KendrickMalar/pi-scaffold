// Shapes shared by the scaffold-watchdog: one Target per handed-off stage session, what one tick saw of it, and
// what the watchdog remembers between ticks. Spec: ai-secretary docs/superpowers/plans/2026-10-18-scaffold-autonomy-W3.md
import type {WatchProgress} from '../watch/decide.js';
import type {TailResult} from '../watch/session-tail.js';

export type AgentKind = 'pi' | 'claude';
export type TargetStage = 'specification' | 'basic-design' | 'implementation' | 'verification';

/** A stage session that a handoff started (packet.json + ready.json). `key` is the receiving session id. */
export interface Target {
  key: string; agent: AgentKind; repo: string; epicIssue: number; targetStage: TargetStage; cwd: string;
  sessionId: string;
  /** When the receiver confirmed the handoff (ready.json `at`), ms. A successor conversation starts after it. */
  handoffAt: number;
  /** Label the sender gave the handoff tab: `scaffold-<first 12 of nonceSha256>`. */
  tabTag?: string;
  /** Pi only: the session that handed off (watches.json); its in-process watcher handles transient errors. */
  ownerSessionId?: string;
}

export type EpicObservation = 'unknown' | {stageLabel?: string; closed: boolean};
export type PaneObservation =
  | {kind: 'missing'}
  /** The recorded conversation is gone and more than one later conversation could have replaced it. */
  | {kind: 'ambiguous'; paneIds: string[]}
  /** The recorded conversation is gone; later ones exist in its cwd but not in the handoff tab (`<id> <socket>#<pane>`). */
  | {kind: 'outside-tab'; candidates: string[]}
  /** The pane the target was last seen in now runs another session. */
  | {kind: 'replaced'; socket: string; paneId: string}
  /** The pane the target was last seen in is back at its shell prompt. */
  | {kind: 'shell'; socket: string; paneId: string}
  | {kind: 'agent'; socket: string; paneId: string; status: string; revision: number; sessionPath?: string; tail?: TailResult};

export interface TargetObservation { epic: EpicObservation; pane: PaneObservation; ownerAlive: boolean }

export interface TargetState {
  lastSeen?: {socket: string; paneId: string; sessionPath?: string};
  /** The stage was relaunched as another conversation; it is tracked under this id instead of the handoff's. */
  rebound?: {sessionId: string; at: number};
  lastRevision?: number; revisionChangedAt?: number;
  /** "Continue" prompts sent in this stage, and for the current stop (`stopKey`). */
  nudges: number; stopKey?: string; stopNudges: number; lastNudgeAt?: number;
  relaunches: number; lastRelaunchAt?: number;
  /** Progress of the transient-error retry, kept in pi-scaffold's own decide() format. */
  watch: WatchProgress;
  loggedKey?: string;
  retired?: boolean;
  /** Why it was retired. A `retired` without one was written by the old rule and is judged again. */
  retiredReason?: 'closed' | 'later';
  /** The Epic label last logged as `stage-not-yet` / `stage-unknown` (`''` = unlabelled), so each is logged once. */
  stageLabelLogged?: string;
}
export const initialTargetState = (): TargetState => ({nudges: 0, stopNudges: 0, relaunches: 0, watch: {retryCount: 0, herdrFailures: 0}});

export type WatchdogAction =
  | {type: 'log'; event: string; detail?: string}
  /** Typed only if the pane still shows `revision` and is idle right before sending. */
  | {type: 'prompt'; socket: string; paneId: string; text: string; revision: number; reason: 'nudge' | 'transient'}
  | {type: 'relaunch'; socket: string; paneId: string; command: string};
