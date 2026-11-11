// The wait loop: read Herdr every intervalMs, return as soon as a watched tab changes in a way the orchestrator
// acts on, or after maxWaitMs. The comparison base is our own record next to the state file, so a change made
// while the orchestrator was awake is still seen, and a state that stays the same never wakes it twice.
import {readFile, rename, writeFile} from 'node:fs/promises';
import type {Fleet} from '../watchdog/herdr-fleet.js';
import {diffTab} from './diff.js';
import {observe, type TabObs} from './observe.js';
import {readTargets, type WaitTarget} from './targets.js';

export interface WaitDeps {
  statePath: string;
  recordPath: string;
  fleet: Pick<Fleet, 'sockets' | 'panes'>;
  now(): number;
  sleep(ms: number): Promise<void>;
  intervalMs: number;
  maxWaitMs: number;
}
export type WaitResult = {kind: 'changes'; lines: string[]} | {kind: 'timeout'; errors: string[]};

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isObs = (v: unknown): v is TabObs => isRec(v) && typeof v.gone === 'boolean' && typeof v.working === 'boolean' && isRec(v.bodies)
  && Object.values(v.bodies).every(s => typeof s === 'string');

async function readRecord(path: string): Promise<Map<string, TabObs>> {
  try {
    const v: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isRec(v) || v.version !== 1 || !isRec(v.tabs)) return new Map();
    return new Map(Object.entries(v.tabs).filter((e): e is [string, TabObs] => isObs(e[1])));
  } catch { return new Map(); }
}
async function writeRecord(path: string, record: Map<string, TabObs>): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({version: 1, tabs: Object.fromEntries(record)}), {mode: 0o600});
  await rename(tmp, path);
}

export async function waitForChange(deps: WaitDeps): Promise<WaitResult> {
  let targets: WaitTarget[] = readTargets(await readFile(deps.statePath, 'utf8')).targets;
  const record = await readRecord(deps.recordPath);
  const errors = new Set<string>();
  const start = deps.now();
  for (let first = true; ; first = false) {
    if (!first) {
      try { targets = readTargets(await readFile(deps.statePath, 'utf8')).targets; }
      catch (e) { errors.add(`state file: ${(e as Error).message}`); }
    }
    const keys = new Set(targets.map(t => t.key));
    for (const k of [...record.keys()]) if (!keys.has(k)) record.delete(k);
    const seen = await observe(targets, deps.fleet);
    for (const e of seen.errors) errors.add(e);
    const lines: string[] = [];
    for (const t of targets) {
      const cur = seen.tabs.get(t.key);
      if (!cur) continue;
      lines.push(...diffTab(t, record.get(t.key), cur));
      record.set(t.key, cur);
    }
    if (lines.length) { await writeRecord(deps.recordPath, record); return {kind: 'changes', lines}; }
    if (deps.now() - start >= deps.maxWaitMs) { await writeRecord(deps.recordPath, record); return {kind: 'timeout', errors: [...errors]}; }
    await deps.sleep(deps.intervalMs);
  }
}
