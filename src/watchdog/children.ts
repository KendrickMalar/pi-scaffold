// Reads pi-subagents' async runs (<dir>/<runId>/status.json): which conversation owns each (its session file), its
// state, and whether its runner process is still alive. Read-only; anything malformed is skipped, never guessed.
import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {ChildRun} from './types.js';

const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};
const num = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) ? v : undefined;

export async function readChildRuns(dir: string): Promise<ChildRun[]> {
  let names: string[];
  try { names = (await readdir(dir, {withFileTypes: true})).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; }
  const runs: ChildRun[] = [];
  for (const name of names) {
    let v: unknown;
    try { v = JSON.parse(await readFile(join(dir, name, 'status.json'), 'utf8')); } catch { continue; }
    if (typeof v !== 'object' || v === null) continue;
    const r = v as Record<string, unknown>;
    if (typeof r.runId !== 'string' || typeof r.state !== 'string' || typeof r.sessionId !== 'string') continue;
    const pid = num(r.pid), lastUpdate = num(r.lastUpdate), endedAt = num(r.endedAt);
    runs.push({id: r.runId, state: r.state, sessionId: r.sessionId, ...(lastUpdate !== undefined ? {lastUpdate} : {}), ...(endedAt !== undefined ? {endedAt} : {}), ...(pid !== undefined && Number.isInteger(pid) && pid > 0 ? {pidAlive: isAlive(pid)} : {})});
  }
  return runs;
}
