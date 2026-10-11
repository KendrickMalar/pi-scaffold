// Pure decision for one watched stage pane: (progress, observation, now) → actions + next progress.
// No I/O here; watcher.ts observes and acts. Spec: docs/superpowers/specs/2026-10-11-stage-watch-design.md
import type {TailResult} from './session-tail.js';

export const CHECK_INTERVAL_MS = 60_000;
export const RETRY_DELAYS_MS = [60_000, 300_000, 900_000] as const;
export const MAX_AUTO_CONTINUE = RETRY_DELAYS_MS.length;
export const HERDR_FAILURE_LIMIT = 3;
export const CONTINUE_PROMPT = 'pi-scaffold: 一時的なエラーで止まったため再開します。直前の作業を続けてください。';
const MESSAGE_CHARS = 120;

export interface WatchEntry {
  ownerSessionId: string; paneId: string; tabId: string; workspaceId: string; targetSessionId: string;
  cwd: string; repo: string; epicIssue: number; targetStage: string; addedAt: string;
}
export interface WatchProgress {
  /** A pending schedule applies only to the error it was announced for: `pendingErrorAt` is that error's `at`.
   * `endedAt` marks a watch that has ended but could not yet be removed: it is never observed or acted on again. */
  retryCount: number; pendingRetryAt?: number; pendingErrorAt?: number; exhaustedErrorAt?: number; endedAt?: number; lastNoticeKey?: string; herdrFailures: number;
}
export const INITIAL_PROGRESS: WatchProgress = Object.freeze({retryCount: 0, herdrFailures: 0});

export type Observation =
  | {kind: 'gone'} | {kind: 'exited'} | {kind: 'replaced'} | {kind: 'working'} | {kind: 'blocked'}
  /** `sessionConfirmed`: Herdr reported the pane's session and it is the handed-off one. Only then is a continue sent. */
  | {kind: 'idle'; tail: TailResult; sessionConfirmed: boolean}
  | {kind: 'unclear'; reason: string};
export type NoticeLevel = 'info' | 'warning' | 'error';
export type WatchAction =
  | {type: 'notify'; level: NoticeLevel; text: string}
  | {type: 'prompt'; text: string; errorAt: number}
  | {type: 'stop'};

export const noticeHead = (e: WatchEntry) => `pi-scaffold: Epic #${e.epicIssue}（${e.repo}・${e.targetStage}）`;
const minutes = (ms: number) => `${Math.round(ms / 60_000)}分`;
const cut = (s: string) => s.length > MESSAGE_CHARS ? `${s.slice(0, MESSAGE_CHARS)}…` : s;

export function decide(entry: WatchEntry, progress: WatchProgress, obs: Observation, now: number): {actions: WatchAction[]; next: WatchProgress} {
  const p: WatchProgress = {...progress};
  const actions: WatchAction[] = [];
  const notify = (level: NoticeLevel, text: string) => actions.push({type: 'notify', level, text: `${noticeHead(entry)}: ${text}`});
  const notifyOnce = (key: string, level: NoticeLevel, text: string) => { if (p.lastNoticeKey === key) return; p.lastNoticeKey = key; notify(level, text); };

  if (obs.kind === 'unclear') {
    p.herdrFailures += 1;
    if (p.herdrFailures === HERDR_FAILURE_LIMIT) notify('warning', `下位 pane の状態を ${HERDR_FAILURE_LIMIT} 回続けて読めませんでした（${cut(obs.reason)}）。`);
    return {actions, next: p};
  }
  p.herdrFailures = 0;
  // Only a transient error keeps a schedule, and only for the error it was announced for (see below).
  const clearSchedule = () => { delete p.pendingRetryAt; delete p.pendingErrorAt; };

  switch (obs.kind) {
    case 'gone': clearSchedule(); notify('error', '下位の pane が消えました。監視を終えます。'); actions.push({type: 'stop'}); break;
    case 'exited': clearSchedule(); notify('warning', '下位の pi が終了しました。監視を終えます。'); actions.push({type: 'stop'}); break;
    case 'replaced': clearSchedule(); notify('warning', '下位の pane で別のセッションが動いています。監視を終えます。'); actions.push({type: 'stop'}); break;
    case 'working': clearSchedule(); delete p.lastNoticeKey; break; // the count stays: only a normal end resets it
    case 'blocked': clearSchedule(); notifyOnce('blocked', 'warning', '下位が確認・入力を待っています。'); break;
    case 'idle': {
      const tail = obs.tail;
      if (tail.kind === 'unknown') { clearSchedule(); notifyOnce(`unknown:${tail.reason}`, 'warning', `下位は止まっていますが、理由を判定できません（${tail.reason}）。自動再開はしません。`); break; }
      if (tail.kind === 'stopped') {
        p.retryCount = 0; clearSchedule();
        if (tail.reason === 'aborted') notifyOnce(`aborted:${tail.at}`, 'info', '下位のターンは中断されています。');
        else notifyOnce(`stopped:${tail.at}`, 'info', '下位が返事待ちか、工程の作業を終えています。');
        break;
      }
      if (!tail.transient) { clearSchedule(); notifyOnce(`error:${tail.at}`, 'error', `下位がエラーで止まっています: ${cut(tail.message)}`); break; }
      if (!obs.sessionConfirmed) { clearSchedule(); notifyOnce(`unconfirmed:${tail.at}`, 'warning', `下位が一時的なエラーで止まっていますが、セッションを確認できないため、自動再開はしません: ${cut(tail.message)}`); break; }
      if (p.exhaustedErrorAt === tail.at) { clearSchedule(); break; }
      if (p.retryCount >= MAX_AUTO_CONTINUE) {
        p.exhaustedErrorAt = tail.at; clearSchedule();
        notifyOnce(`exhausted:${tail.at}`, 'error', `自動再開を ${MAX_AUTO_CONTINUE} 回試しましたが止まっています: ${cut(tail.message)}`);
        break;
      }
      // No schedule, or one left over from another error: this is a fresh sighting. Announce the wait; never send now.
      if (p.pendingRetryAt === undefined || p.pendingErrorAt !== tail.at) {
        const delay = RETRY_DELAYS_MS[p.retryCount]!;
        p.pendingRetryAt = now + delay; p.pendingErrorAt = tail.at;
        p.lastNoticeKey = `transient:${tail.at}:${p.retryCount}`;
        notify('warning', `下位が一時的なエラーで止まっています。${minutes(delay)}後に自動で再開します: ${cut(tail.message)}`);
        break;
      }
      if (now < p.pendingRetryAt) break;
      p.retryCount += 1; clearSchedule();
      actions.push({type: 'prompt', text: CONTINUE_PROMPT, errorAt: tail.at});
      break;
    }
  }
  return {actions, next: p};
}
