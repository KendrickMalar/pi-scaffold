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
  retryCount: number; pendingRetryAt?: number; exhaustedErrorAt?: number; lastNoticeKey?: string; herdrFailures: number;
}
export const INITIAL_PROGRESS: WatchProgress = Object.freeze({retryCount: 0, herdrFailures: 0});

export type Observation =
  | {kind: 'gone'} | {kind: 'exited'} | {kind: 'working'} | {kind: 'blocked'}
  | {kind: 'idle'; tail: TailResult}
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

  switch (obs.kind) {
    case 'gone': notify('error', '下位の pane が消えました。監視を終えます。'); actions.push({type: 'stop'}); break;
    case 'exited': notify('warning', '下位の pi が終了しました。監視を終えます。'); actions.push({type: 'stop'}); break;
    case 'working': delete p.pendingRetryAt; delete p.lastNoticeKey; break; // the count stays: only a normal end resets it
    case 'blocked': notifyOnce('blocked', 'warning', '下位が確認・入力を待っています。'); break;
    case 'idle': {
      const tail = obs.tail;
      if (tail.kind === 'unknown') { notifyOnce(`unknown:${tail.reason}`, 'warning', `下位は止まっていますが、理由を判定できません（${tail.reason}）。自動再開はしません。`); break; }
      if (tail.kind === 'stopped') {
        p.retryCount = 0; delete p.pendingRetryAt;
        if (tail.reason === 'aborted') notifyOnce(`aborted:${tail.at}`, 'info', '下位のターンは中断されています。');
        else notifyOnce(`stopped:${tail.at}`, 'info', '下位が返事待ちか、工程の作業を終えています。');
        break;
      }
      if (!tail.transient) { notifyOnce(`error:${tail.at}`, 'error', `下位がエラーで止まっています: ${cut(tail.message)}`); break; }
      if (p.exhaustedErrorAt === tail.at) break;
      if (p.retryCount >= MAX_AUTO_CONTINUE) {
        p.exhaustedErrorAt = tail.at; delete p.pendingRetryAt;
        notifyOnce(`exhausted:${tail.at}`, 'error', `自動再開を ${MAX_AUTO_CONTINUE} 回試しましたが止まっています: ${cut(tail.message)}`);
        break;
      }
      if (p.pendingRetryAt === undefined) {
        const delay = RETRY_DELAYS_MS[p.retryCount]!;
        p.pendingRetryAt = now + delay;
        notifyOnce(`transient:${tail.at}:${p.retryCount}`, 'warning', `下位が一時的なエラーで止まっています。${minutes(delay)}後に自動で再開します: ${cut(tail.message)}`);
        break;
      }
      if (now < p.pendingRetryAt) break;
      p.retryCount += 1; delete p.pendingRetryAt;
      actions.push({type: 'prompt', text: CONTINUE_PROMPT, errorAt: tail.at});
      break;
    }
  }
  return {actions, next: p};
}
