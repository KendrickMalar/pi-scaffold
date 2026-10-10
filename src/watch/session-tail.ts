// Reads only the tail of a Pi session log to tell why an idle stage session stopped. Pi writes these files
// (they are not owner-only), so plain fs is used; anything unexpected is `unknown`, never a guess.
import {open, readdir} from 'node:fs/promises';
import {join} from 'node:path';

export type TailResult =
  | {kind: 'error'; transient: boolean; message: string; at: number}
  | {kind: 'stopped'; reason: string; at: number}
  | {kind: 'unknown'; reason: string};

export const SESSION_LOG_VERSION = 3;
export const TAIL_BYTES = 256 * 1024;
const HEAD_BYTES = 4096;

/** Errors that minutes of waiting will not fix, even when they look like rate limits. */
const NOT_TRANSIENT = /usage limit|authentication|invalidated|maximum context length/i;
const TRANSIENT = [
  /^(429|5\d\d)\b/,
  /\b(rate_limit_error|overloaded_error|api_error)\b/,
  /fetch failed|connection error|ECONNRESET|ETIMEDOUT|socket hang up|timed out|upstream connect error|exceeded request buffer limit/i,
];
export function isTransientError(message: string): boolean {
  const m = message.trim();
  if (!m || NOT_TRANSIENT.test(m)) return false;
  return TRANSIENT.some(r => r.test(m));
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Pi's per-cwd session directory name: "/a/b" → "--a-b--". */
export function sessionDirName(cwd: string): string { return `--${cwd.replace(/^\/+/, '').replace(/\//g, '-')}--`; }

export async function findSessionLog(sessionsRoot: string, cwd: string, sessionId: string): Promise<string | undefined> {
  const suffix = `_${sessionId}.jsonl`;
  const look = async (dir: string) => { try { return (await readdir(dir)).find(n => n.endsWith(suffix)); } catch { return undefined; } };
  const preferred = join(sessionsRoot, sessionDirName(cwd));
  const hit = await look(preferred);
  if (hit) return join(preferred, hit);
  let dirs: string[];
  try { dirs = (await readdir(sessionsRoot, {withFileTypes: true})).filter(d => d.isDirectory()).map(d => d.name); } catch { return undefined; }
  for (const d of dirs) { const h = await look(join(sessionsRoot, d)); if (h) return join(sessionsRoot, d, h); }
  return undefined;
}

export async function readSessionTail(path: string): Promise<TailResult> {
  let handle;
  try { handle = await open(path, 'r'); } catch { return {kind: 'unknown', reason: 'log-missing'}; }
  try {
    const {size} = await handle.stat();
    const head = Buffer.alloc(Math.min(HEAD_BYTES, size));
    await handle.read(head, 0, head.length, 0);
    let header: unknown;
    try { header = JSON.parse(head.toString('utf8').split('\n', 1)[0] ?? ''); } catch { return {kind: 'unknown', reason: 'log-header'}; }
    if (!isRec(header) || header.type !== 'session') return {kind: 'unknown', reason: 'log-header'};
    if (header.version !== SESSION_LOG_VERSION) return {kind: 'unknown', reason: 'log-version'};
    const start = Math.max(0, size - TAIL_BYTES);
    const tail = Buffer.alloc(size - start);
    await handle.read(tail, 0, tail.length, start);
    const lines = tail.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // the window may start inside a line
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry: unknown;
      try { entry = JSON.parse(lines[i]!); } catch { continue; }
      if (!isRec(entry) || entry.type !== 'message' || !isRec(entry.message) || entry.message.role !== 'assistant') continue;
      const m = entry.message;
      // The timestamp is the error's identity for the watch; without one, never act on this record.
      if (typeof m.timestamp !== 'number' || !Number.isFinite(m.timestamp)) return {kind: 'unknown', reason: 'no-timestamp'};
      const at = m.timestamp;
      if (m.stopReason === 'error') {
        const message = typeof m.errorMessage === 'string' ? m.errorMessage : '';
        return {kind: 'error', transient: isTransientError(message), message, at};
      }
      return {kind: 'stopped', reason: typeof m.stopReason === 'string' ? m.stopReason : 'unknown', at};
    }
    return {kind: 'unknown', reason: 'no-assistant-message'};
  } catch { return {kind: 'unknown', reason: 'log-read'}; }
  finally { await handle.close(); }
}

export function tailReader(sessionsRoot: string) {
  return async (entry: {cwd: string; targetSessionId: string}): Promise<TailResult> => {
    const path = await findSessionLog(sessionsRoot, entry.cwd, entry.targetSessionId);
    return path ? readSessionTail(path) : {kind: 'unknown', reason: 'log-missing'};
  };
}
