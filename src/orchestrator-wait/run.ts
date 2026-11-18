// The wait loop: read Herdr every intervalMs, return as soon as a watched tab changes in a way the orchestrator
// acts on, or after maxWaitMs. The comparison base is our own record next to the state file, so a change made
// while the orchestrator was awake is still seen, and a state that stays the same never wakes it twice.
import {readFile, rename, writeFile} from 'node:fs/promises';
import {diffTab} from './diff.js';
import {observe, observeStages, type TabObs, type WaitFleet} from './observe.js';
import {scanWatchdogLog, type WatchdogMark} from './watchdog-log.js';
import {readTargets, type Targets, type WaitTarget} from './targets.js';

export interface WaitDeps {
  statePath: string;
  recordPath: string;
  fleet: WaitFleet;
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

const isMark = (v: unknown): v is WatchdogMark => isRec(v) && typeof v.lastAt === 'string' && Array.isArray(v.seen) && v.seen.every(r => typeof r === 'string');

async function readRecord(path: string): Promise<{tabs: Map<string, TabObs>; watchdog?: WatchdogMark}> {
  try {
    const v: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isRec(v) || v.version !== 1 || !isRec(v.tabs)) return {tabs: new Map()};
    return {tabs: new Map(Object.entries(v.tabs).filter((e): e is [string, TabObs] => isObs(e[1]))), ...(isMark(v.watchdog) ? {watchdog: v.watchdog} : {})};
  } catch { return {tabs: new Map()}; }
}
async function writeRecord(path: string, record: Map<string, TabObs>, watchdog?: WatchdogMark): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({version: 1, tabs: Object.fromEntries(record), ...(watchdog ? {watchdog} : {})}), {mode: 0o600});
  await rename(tmp, path);
}

export async function waitForChange(deps: WaitDeps): Promise<WaitResult> {
  let read: Targets = readTargets(await readFile(deps.statePath, 'utf8'));
  let targets: WaitTarget[] = read.targets;
  const record = (await readRecord(deps.recordPath)).tabs;
  const errors = new Set<string>();
  const start = deps.now();
  for (let first = true; ; first = false) {
    if (!first) {
      try { read = readTargets(await readFile(deps.statePath, 'utf8')); targets = read.targets; }
      catch (e) { errors.add(`state file: ${(e as Error).message}`); }
    }
    const keys = new Set(targets.map(t => t.key));
    for (const k of [...record.keys()]) if (!keys.has(k)) record.delete(k);
    for (const e of read.errors) errors.add(e);
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

export interface ManagerDeps {
  /** The manager's summary file (JSON with `epic` and `repo`). Read only. */
  summaryPath: string;
  recordPath: string;
  /** The manager's own herdr session socket ('' = herdr's default). */
  socket: string;
  /** The manager's own pane: never watched. */
  ownPane?: string;
  fleet: Pick<WaitFleet, 'panes'>;
  /** The watchdog log's text. Rejects when there is no readable log. */
  readWatchdogLog(): Promise<string>;
  now(): number;
  sleep(ms: number): Promise<void>;
  intervalMs: number;
  maxWaitMs: number;
}

export function readSummary(text: string): {epic: number; repo: string} {
  const v: unknown = JSON.parse(text);
  if (!isRec(v) || typeof v.epic !== 'number' || !Number.isInteger(v.epic) || v.epic <= 0) throw new Error('summary file has no integer epic.');
  if (typeof v.repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(v.repo)) throw new Error('summary file has no owner/name repo.');
  return {epic: v.epic, repo: v.repo};
}

/** Manager mode: the stage tabs of the summary's Epic in our own session, plus new watchdog log lines for it. */
export async function waitForManagerChange(deps: ManagerDeps): Promise<WaitResult> {
  const who = readSummary(await readFile(deps.summaryPath, 'utf8'));
  const target: WaitTarget = {key: `manager|${deps.socket}|${who.epic}`, label: `Epic #${who.epic}`, socket: deps.socket, pane: '', epics: [who.epic], status: 'running', cleanupSockets: []};
  const saved = await readRecord(deps.recordPath);
  const record = saved.tabs;
  let mark = saved.watchdog;
  const errors = new Set<string>();
  const start = deps.now();
  for (;;) {
    const lines: string[] = [];
    try {
      const cur = await observeStages(deps.socket, who.epic, deps.ownPane, deps.fleet);
      lines.push(...diffTab(target, record.get(target.key), cur));
      record.set(target.key, cur);
    } catch (e) { errors.add(`herdr pane list: ${(e as Error).message}`); }
    try {
      const scan = scanWatchdogLog(await deps.readWatchdogLog(), who, mark);
      mark = scan.mark;
      lines.push(...scan.lines);
    } catch (e) { errors.add(`watchdog log: ${(e as Error).message}`); }
    if (lines.length) { await writeRecord(deps.recordPath, record, mark); return {kind: 'changes', lines}; }
    if (deps.now() - start >= deps.maxWaitMs) { await writeRecord(deps.recordPath, record, mark); return {kind: 'timeout', errors: [...errors]}; }
    await deps.sleep(deps.intervalMs);
  }
}
