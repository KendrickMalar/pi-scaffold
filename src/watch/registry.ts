// The watch registry: which stage panes each Pi session handed off and how far their watch has got.
// Shared by every session of this agent dir; each session only acts on records it owns (ownerSessionId).
import {join} from 'node:path';
import {OwnedFileError, readOwnedJson, writeOwnedFile} from '../core/files.js';
import {INITIAL_PROGRESS, type WatchEntry, type WatchProgress} from './decide.js';

export interface WatchRecord { entry: WatchEntry; progress: WatchProgress }
export const sameWatch = (a: WatchEntry, b: WatchEntry) => a.paneId === b.paneId && a.targetSessionId === b.targetSessionId;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const STRING_FIELDS = ['ownerSessionId', 'paneId', 'tabId', 'workspaceId', 'targetSessionId', 'cwd', 'repo', 'targetStage', 'addedAt'] as const;
function isRecord(v: unknown): v is WatchRecord {
  if (!isRec(v) || !isRec(v.entry) || !isRec(v.progress)) return false;
  const e = v.entry, p = v.progress;
  return STRING_FIELDS.every(k => typeof e[k] === 'string') && Number.isInteger(e.epicIssue)
    && typeof p.retryCount === 'number' && typeof p.herdrFailures === 'number';
}

export class WatchRegistry {
  private readonly root: string;
  readonly path: string;
  constructor(agentDir: string) { this.root = join(agentDir, 'pi-scaffold'); this.path = join(this.root, 'state', 'watches.json'); }

  /** A missing file is empty. An unreadable file or malformed records are skipped and reported as corrupt. */
  async load(): Promise<{records: WatchRecord[]; corrupt: boolean}> {
    let raw: unknown;
    try { raw = await readOwnedJson(this.path, {root: this.root}); }
    catch (e) { return {records: [], corrupt: !(e instanceof OwnedFileError && e.code === 'NOT_FOUND')}; }
    if (!isRec(raw) || raw.version !== 1 || !Array.isArray(raw.watches)) return {records: [], corrupt: true};
    const records = raw.watches.filter(isRecord);
    return {records, corrupt: records.length !== raw.watches.length};
  }
  private async save(records: WatchRecord[]): Promise<void> {
    await writeOwnedFile(this.path, `${JSON.stringify({version: 1, watches: records}, null, 2)}\n`, {root: this.root});
  }
  /** (Re)registers a handed-off pane with fresh progress. */
  async upsert(entry: WatchEntry): Promise<void> {
    const {records} = await this.load();
    await this.save([...records.filter(r => !sameWatch(r.entry, entry)), {entry, progress: {...INITIAL_PROGRESS}}]);
  }
  /** Re-reads before writing so records other sessions added meanwhile are kept. */
  async update(record: WatchRecord): Promise<void> {
    const {records} = await this.load();
    if (!records.some(r => sameWatch(r.entry, record.entry))) return;
    await this.save(records.map(r => sameWatch(r.entry, record.entry) ? record : r));
  }
  async remove(entry: WatchEntry): Promise<void> {
    const {records} = await this.load();
    await this.save(records.filter(r => !sameWatch(r.entry, entry)));
  }
}
