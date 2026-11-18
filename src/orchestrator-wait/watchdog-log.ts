// Manager mode: which new scaffold-watchdog log lines wake the scaffold-manager. The watchdog appends one JSON
// object per line ({at, event, repo, epic, stage, …}). The read position is not a byte offset (a log rotation moves
// the file under it) but the latest `at` already handled plus the lines seen at exactly that `at`.
import {open} from 'node:fs/promises';

export const WATCHDOG_EVENTS: ReadonlySet<string> = new Set(['prompted', 'awaiting-human', 'stage-exhausted', 'missing', 'blocked', 'retired']);
export const BOX_WATCHDOG_LOG = '/home/dev/work/.kec-orb/logs/scaffold-watchdog.log';
const TAIL_BYTES = 1024 * 1024;

export interface WatchdogMark {
  /** Latest `at` (ISO string) handled so far; '' before any line. */
  lastAt: string;
  /** Raw lines at exactly `lastAt` that were already handled (a line may repeat). */
  seen: string[];
}
export interface WatchdogScan { lines: string[]; mark: WatchdogMark }

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const ms = (at: string): number => Date.parse(at);

interface Entry { raw: string; at: string; event: string; stage: string }
function matching(text: string, who: {repo: string; epic: number}): Entry[] {
  const out: Entry[] = [];
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    let v: unknown;
    try { v = JSON.parse(raw); } catch { continue; }
    if (!isRec(v) || typeof v.at !== 'string' || Number.isNaN(ms(v.at)) || typeof v.event !== 'string' || !WATCHDOG_EVENTS.has(v.event)) continue;
    if (v.repo !== who.repo || v.epic !== who.epic) continue;
    out.push({raw, at: v.at, event: v.event, stage: typeof v.stage === 'string' && v.stage ? v.stage : '-'});
  }
  return out;
}

/** `mark` undefined = first read: every matching line already there is "before", nothing wakes. */
export function scanWatchdogLog(text: string, who: {repo: string; epic: number}, mark: WatchdogMark | undefined): WatchdogScan {
  const entries = matching(text, who);
  const base = mark?.lastAt ?? '';
  const after = (at: string, than: string): boolean => than === '' || ms(at) > ms(than);
  let latest = base;
  for (const e of entries) if (after(e.at, latest)) latest = e.at;
  const atLatest = (list: Entry[]): string[] => list.filter(e => latest !== '' && ms(e.at) === ms(latest)).map(e => e.raw);
  if (!mark) return {lines: [], mark: {lastAt: latest, seen: atLatest(entries)}};
  // Lines at exactly the old lastAt are new only beyond the number already handled (counted per raw line).
  const handled = new Map<string, number>();
  for (const r of mark.seen) handled.set(r, (handled.get(r) ?? 0) + 1);
  const fresh: Entry[] = [];
  for (const e of entries) {
    if (after(e.at, base)) { fresh.push(e); continue; }
    if (base === '' || ms(e.at) < ms(base)) continue;
    const left = handled.get(e.raw) ?? 0;
    if (left > 0) handled.set(e.raw, left - 1); else fresh.push(e);
  }
  const seen = latest === base ? [...mark.seen, ...atLatest(fresh)] : atLatest(entries);
  return {lines: fresh.map(e => `watchdog ${e.event} ${e.stage}`), mark: {lastAt: latest, seen}};
}

/** Reads the last 1 MiB of the log (a partial first line is dropped by the JSON parse). Throws when unreadable. */
export async function readLogTail(path: string): Promise<string> {
  const h = await open(path, 'r');
  try {
    const {size} = await h.stat();
    const start = Math.max(0, size - TAIL_BYTES), len = size - start;
    const buf = Buffer.alloc(len);
    const {bytesRead} = await h.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally { await h.close(); }
}
