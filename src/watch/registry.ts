// The watch registry: which stage panes each Pi session handed off and how far their watch has got.
// Shared by every session of this agent dir; each session only acts on records it owns (ownerSessionId).
// Not locked across processes: writes are read-modify-write, so two sessions writing in the same instant can drop
// one record. Within one instance every write is serialized, so a check's update cannot drop a handoff's upsert.
import {rename} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';
import {OwnedFileError, readOwnedJson, writeOwnedFile} from '../core/files.js';
import {INITIAL_PROGRESS, type WatchEntry, type WatchProgress} from './decide.js';

export interface WatchRecord { entry: WatchEntry; progress: WatchProgress }
export const sameWatch = (a: WatchEntry, b: WatchEntry) => a.paneId === b.paneId && a.targetSessionId === b.targetSessionId;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const STRING_FIELDS = ['ownerSessionId', 'paneId', 'tabId', 'workspaceId', 'targetSessionId', 'cwd', 'repo', 'targetStage', 'addedAt'] as const;
const OPTIONAL_NUMBER_FIELDS = ['pendingRetryAt', 'pendingErrorAt', 'exhaustedErrorAt'] as const;
const optional = (v: unknown, ok: (x: unknown) => boolean) => v === undefined || ok(v);
function isRecord(v: unknown): v is WatchRecord {
  if (!isRec(v) || !isRec(v.entry) || !isRec(v.progress)) return false;
  const e = v.entry, p = v.progress;
  return STRING_FIELDS.every(k => typeof e[k] === 'string') && Number.isInteger(e.epicIssue)
    && typeof p.retryCount === 'number' && typeof p.herdrFailures === 'number'
    && OPTIONAL_NUMBER_FIELDS.every(k => optional(p[k], x => typeof x === 'number' && Number.isFinite(x)))
    && optional(p.lastNoticeKey, x => typeof x === 'string');
}

export class WatchRegistry {
  private readonly root: string;
  readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(agentDir: string) { this.root = join(agentDir, 'pi-scaffold'); this.path = join(this.root, 'state', 'watches.json'); }

  /** Runs one read-modify-write after the previous one settles; a failed write does not block later ones. */
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** A missing file is empty. An unreadable file or malformed records are skipped and reported as corrupt. */
  async load(): Promise<{records: WatchRecord[]; corrupt: boolean}> {
    let raw: unknown;
    try { raw = await readOwnedJson(this.path, {root: this.root}); }
    catch (e) { return {records: [], corrupt: !(e instanceof OwnedFileError && e.code === 'NOT_FOUND')}; }
    if (!isRec(raw) || raw.version !== 1 || !Array.isArray(raw.watches)) return {records: [], corrupt: true};
    const records = raw.watches.filter(isRecord);
    return {records, corrupt: records.length !== raw.watches.length};
  }
  /** Loads for a write. If the file is corrupt, moves it aside first so its bytes are not overwritten. */
  private async loadForWrite(): Promise<WatchRecord[]> {
    const {records, corrupt} = await this.load();
    if (corrupt) {
      try { await rename(this.path, join(dirname(this.path), `${basename(this.path)}.corrupt-${Date.now()}`)); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    return records;
  }
  private async save(records: WatchRecord[]): Promise<void> {
    await writeOwnedFile(this.path, `${JSON.stringify({version: 1, watches: records}, null, 2)}\n`, {root: this.root});
  }
  /** Registers a handed-off pane. An existing watch of the same pane+session keeps its progress (a replayed handoff
   * must not lift the auto-continue cap); only its entry is refreshed. */
  upsert(entry: WatchEntry): Promise<void> {
    return this.serialized(async () => {
      const records = await this.loadForWrite();
      const progress = records.find(r => sameWatch(r.entry, entry))?.progress ?? {...INITIAL_PROGRESS};
      await this.save([...records.filter(r => !sameWatch(r.entry, entry)), {entry, progress}]);
    });
  }
  /** Re-reads right before writing to keep records other sessions added; not locked across processes, so a write racing another session's write in the same instant can drop one of them (writes are rare: only on a change, one per handoff). */
  update(record: WatchRecord): Promise<void> {
    return this.serialized(async () => {
      const records = await this.loadForWrite();
      if (!records.some(r => sameWatch(r.entry, record.entry))) return;
      await this.save(records.map(r => sameWatch(r.entry, record.entry) ? record : r));
    });
  }
  remove(entry: WatchEntry): Promise<void> {
    return this.serialized(async () => {
      const records = await this.loadForWrite();
      await this.save(records.filter(r => !sameWatch(r.entry, entry)));
    });
  }
}
