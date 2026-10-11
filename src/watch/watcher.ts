// Background watch of the stage panes this Pi session handed off. One timer per session, running only while the
// registry holds watches this session owns; each check is observe → decide → act. Spec: Issue #36.
import {SUPPORTED_HERDR, type HerdrPort} from '../handoff/herdr-client.js';
import {isDeepStrictEqual} from 'node:util';
import {CHECK_INTERVAL_MS, HERDR_FAILURE_LIMIT, MAX_AUTO_CONTINUE, decide, noticeHead, type NoticeLevel, type Observation, type WatchEntry, type WatchProgress} from './decide.js';
import type {WatchRecord, WatchRegistry} from './registry.js';
import type {TailResult} from './session-tail.js';

export type WatchHerdr = Pick<HerdrPort, 'version' | 'paneGet' | 'processInfo' | 'agentPrompt'>;
export interface WatcherDeps {
  ownerSessionId: string;
  registry: WatchRegistry;
  herdr: WatchHerdr;
  readTail(entry: WatchEntry): Promise<TailResult>;
  notify(text: string, level: NoticeLevel): void;
  now(): number;
  intervalMs?: number;
  setInterval?(fn: () => void, ms: number): unknown;
  clearInterval?(handle: unknown): void;
}

function sessionMatches(s: {kind: string; value: string}, entry: WatchEntry): boolean {
  if (s.kind === 'id') return s.value === entry.targetSessionId;
  if (s.kind === 'path') return s.value.endsWith(`_${entry.targetSessionId}.jsonl`);
  return true;
}

/** JSON drops undefined fields, so `{a: undefined}` and `{}` are the same saved progress. */
const stripUndefined = (p: WatchProgress) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));

export class StageWatcher {
  private timer: unknown;
  private running = false;
  private herdr: 'ok' | 'unsupported' | undefined;
  private corruptNotified = false;
  private versionFailures = 0;
  private registryNotified = false;
  /** Watches whose terminal notice (gone/exited/replaced) was shown; a failing remove must not repeat it every check. */
  private readonly ended = new Set<string>();
  constructor(private readonly deps: WatcherDeps) {}

  get active(): boolean { return this.timer !== undefined; }
  /** Registers a handed-off pane (idempotent) and makes sure the timer runs. */
  async add(entry: WatchEntry): Promise<void> { await this.deps.registry.upsert(entry); this.ensureTimer(); }
  /** session_start: restart the timer when this session still owns watches. */
  async resume(): Promise<void> { if ((await this.owned()).length) this.ensureTimer(); }
  stop(): void {
    if (this.timer === undefined) return;
    if (this.deps.clearInterval) this.deps.clearInterval(this.timer); else clearInterval(this.timer as ReturnType<typeof setInterval>);
    this.timer = undefined;
  }

  private ensureTimer(): void {
    if (this.timer !== undefined || this.herdr === 'unsupported') return;
    const fn = () => { void this.tick().catch(() => undefined); };
    const ms = this.deps.intervalMs ?? CHECK_INTERVAL_MS;
    const handle = this.deps.setInterval ? this.deps.setInterval(fn, ms) : setInterval(fn, ms);
    (handle as {unref?: () => void}).unref?.();
    this.timer = handle;
  }

  private async owned(): Promise<WatchRecord[]> {
    const {records, corrupt} = await this.deps.registry.load();
    if (corrupt && !this.corruptNotified) { this.corruptNotified = true; this.deps.notify('pi-scaffold: 監視台帳に読めない項目があったため、読み飛ばしました。', 'warning'); }
    return records.filter(r => r.entry.ownerSessionId === this.deps.ownerSessionId);
  }

  /** 'skip' when Herdr could not be asked this time; the next check asks again. */
  private async herdrState(): Promise<'ok' | 'unsupported' | 'skip'> {
    if (this.herdr) return this.herdr;
    let v: {version: string; protocol: number};
    try { v = await this.deps.herdr.version(); }
    catch {
      this.versionFailures += 1;
      if (this.versionFailures === HERDR_FAILURE_LIMIT) this.deps.notify(`pi-scaffold: Herdr に ${HERDR_FAILURE_LIMIT} 回続けて接続できませんでした。下位の監視は接続できるまで待ちます。`, 'warning');
      return 'skip';
    }
    this.versionFailures = 0;
    this.herdr = v.version === SUPPORTED_HERDR.version && v.protocol === SUPPORTED_HERDR.protocol ? 'ok' : 'unsupported';
    if (this.herdr === 'unsupported') this.deps.notify(`pi-scaffold: Herdr ${v.version}/protocol ${v.protocol} は未検証のため、下位の監視を止めました（必要: ${SUPPORTED_HERDR.version}/${SUPPORTED_HERDR.protocol}）。`, 'warning');
    return this.herdr;
  }

  /** One check of every owned watch. A check still running makes this one a no-op. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const records = await this.owned();
      if (!records.length) { this.stop(); return; }
      const herdr = await this.herdrState();
      if (herdr === 'unsupported') { this.stop(); return; }
      if (herdr === 'skip') return;
      for (const record of records) {
        // One broken watch must not stop the others; the next check retries it.
        try { await this.check(record); }
        catch (e) {
          if (!this.registryNotified) { this.registryNotified = true; this.deps.notify(`pi-scaffold: 監視台帳を更新できませんでした（${(e as Error).message}）。次回の確認で再試行します。`, 'warning'); }
        }
      }
    } finally { this.running = false; }
  }

  private async observe(entry: WatchEntry): Promise<Observation> {
    let pane;
    try { pane = await this.deps.herdr.paneGet(entry.paneId); } catch (e) { return {kind: 'unclear', reason: (e as Error).message}; }
    if (!pane.exists) return {kind: 'gone'};
    if (pane.agent !== 'pi') {
      try { return (await this.deps.herdr.processInfo(entry.paneId)).shellReady ? {kind: 'exited'} : {kind: 'unclear', reason: 'agent-not-detected'}; }
      catch (e) { return {kind: 'unclear', reason: (e as Error).message}; }
    }
    if (pane.session && !sessionMatches(pane.session, entry)) return {kind: 'replaced'};
    switch (pane.status) {
      case 'working': return {kind: 'working'};
      case 'blocked': return {kind: 'blocked'};
      case 'idle': case 'done': return {kind: 'idle', tail: await this.deps.readTail(entry), sessionConfirmed: pane.session !== undefined};
      default: return {kind: 'unclear', reason: `status-${pane.status ?? 'none'}`};
    }
  }

  private async check(record: WatchRecord): Promise<void> {
    const {entry} = record;
    const key = `${entry.paneId}\u0000${entry.targetSessionId}`;
    // Ended earlier but not yet removed: only finish the removal. Observing it again could act on a stale watch.
    if (record.progress.endedAt !== undefined || this.ended.has(key)) { await this.deps.registry.remove(entry); this.ended.delete(key); return; }
    const {actions, next} = decide(entry, record.progress, await this.observe(entry), this.deps.now());
    const ending = actions.some(a => a.type === 'stop');
    let progress: WatchProgress = next;
    for (const action of actions) {
      if (action.type === 'notify') { if (!(ending && this.ended.has(key))) this.deps.notify(action.text, action.level); }
      else if (action.type === 'stop') continue;
      else {
        // Re-check right before typing into the child: someone may have moved it on since the observation.
        const again = await this.observe(entry);
        if (again.kind !== 'idle' || !again.sessionConfirmed || again.tail.kind !== 'error' || again.tail.at !== action.errorAt) {
          // Drop the schedule too: a later error must get its own announced wait, never this one's.
          progress = {...record.progress, pendingRetryAt: undefined, pendingErrorAt: undefined};
          continue;
        }
        // Persist the count BEFORE typing: a lost save after a send could otherwise cause a second "continue".
        try { await this.deps.registry.update({entry, progress: next}); }
        catch (e) {
          if (!this.registryNotified) { this.registryNotified = true; this.deps.notify(`pi-scaffold: 監視台帳を更新できませんでした（${(e as Error).message}）。次回の確認で再試行します。`, 'warning'); }
          return;
        }
        record = {entry, progress: next}; // saved: compare later writes against this
        try {
          await this.deps.herdr.agentPrompt(entry.paneId, action.text);
          this.deps.notify(`${noticeHead(entry)}: 自動で再開を送りました（${next.retryCount}/${MAX_AUTO_CONTINUE}回目）。`, 'info');
        } catch (e) {
          // Possibly typed already: count it and do not resend now (a double "continue" is worse than a missed one).
          this.deps.notify(`${noticeHead(entry)}: 再開の送信を確認できませんでした（${(e as Error).message}）。この回は再送しません。`, 'warning');
        }
      }
    }
    if (ending) {
      this.ended.add(key);
      // Mark it ended (schedule already cleared) before removing: if the removal fails, the record that stays behind
      // can never be acted on, not even by a restarted parent. A failed mark is covered by `ended` for this process.
      try { await this.deps.registry.update({entry, progress: {...progress, endedAt: this.deps.now()}}); } catch { /* the removal below reports */ }
      await this.deps.registry.remove(entry);
      this.ended.delete(key);
      return;
    }
    if (!isDeepStrictEqual(stripUndefined(progress), stripUndefined(record.progress))) await this.deps.registry.update({entry, progress});
  }
}
