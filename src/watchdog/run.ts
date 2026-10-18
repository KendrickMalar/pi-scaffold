// One scaffold-watchdog tick: discover targets → read every Herdr session → plan → act → save. Everything it does
// is appended to the log as JSON Lines; nothing is notified. Run by launchd every minute with --once.
import {appendFile, mkdir, readFile, rename, rmdir, stat, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {discoverTargets, type StateRoot} from './discover.js';
import {findSuccessor, matchPane, sessionMatches, type Fleet, type PaneSnapshot} from './herdr-fleet.js';
import {planTarget, type PlanOptions} from './plan.js';
import {initialTargetState, type EpicObservation, type PaneObservation, type Target, type TargetState, type WatchdogAction} from './types.js';
import type {TailResult} from '../watch/session-tail.js';

export interface WatchdogDeps {
  roots: StateRoot[];
  fleet: Fleet;
  epic(repo: string, issue: number): Promise<EpicObservation>;
  readTail(sessionPath: string): Promise<TailResult>;
  statePath: string;
  logPath: string;
  now(): number;
  /**
   * Decides and logs only: nothing is typed. The live state file is read but never written; the dry run keeps its
   * own memory beside it (`<statePath>.dry-run`), so it can share a machine with the running watchdog.
   */
  dryRun?: boolean;
  /** Runs pi-subagents' stale-run reconcile; returns its stdout. */
  reconcile?(): Promise<string>;
  /** Free bytes on the home volume. */
  diskFree?(): Promise<number | undefined>;
  plan?: PlanOptions;
}

/** A lock older than this belongs to a run that died; it is taken over. */
export const STALE_LOCK_MS = 10 * 60_000;
interface SavedState { version: 1; targets: Record<string, TargetState> }

async function loadState(path: string): Promise<Record<string, TargetState>> {
  try {
    const v = JSON.parse(await readFile(path, 'utf8')) as SavedState;
    return v && v.version === 1 && typeof v.targets === 'object' && v.targets ? v.targets : {};
  } catch { return {}; }
}
async function saveState(path: string, targets: Record<string, TargetState>): Promise<void> {
  await mkdir(dirname(path), {recursive: true});
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify({version: 1, targets} satisfies SavedState, null, 2)}\n`);
  await rename(tmp, path);
}

async function lock(path: string, now: number): Promise<boolean> {
  await mkdir(dirname(path), {recursive: true});
  try { await mkdir(path); return true; }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    try { if (now - (await stat(path)).mtimeMs < STALE_LOCK_MS) return false; } catch { return false; }
    await rmdir(path).catch(() => undefined);
    try { await mkdir(path); return true; } catch { return false; }
  }
}

const parseOutput = (text: string): unknown => { try { return JSON.parse(text); } catch { return text.trim().slice(0, 2000); } };

export async function runOnce(deps: WatchdogDeps): Promise<'ran' | 'locked'> {
  const lockPath = `${statePathOf(deps)}.lock`;
  if (!await lock(lockPath, deps.now())) return 'locked';
  await mkdir(dirname(deps.logPath), {recursive: true});
  const lines: string[] = [];
  const log = (event: string, fields: Record<string, unknown> = {}) => { lines.push(JSON.stringify({at: new Date(deps.now()).toISOString(), event, ...fields})); };
  try {
    await tick(deps, log);
  } catch (e) {
    log('tick-error', {error: (e as Error).message});
  } finally {
    await appendFile(deps.logPath, lines.length ? `${lines.join('\n')}\n` : '').catch(() => undefined);
    await rmdir(lockPath).catch(() => undefined);
  }
  return 'ran';
}

const statePathOf = (deps: WatchdogDeps) => deps.dryRun ? `${deps.statePath}.dry-run` : deps.statePath;
const exists = (path: string) => stat(path).then(() => true, () => false);

type Log = (event: string, fields?: Record<string, unknown>) => void;

async function tick(deps: WatchdogDeps, log: Log): Promise<void> {
  const now = deps.now();
  if (deps.diskFree) log('disk', {freeBytes: await deps.diskFree().catch(() => undefined)});
  if (deps.reconcile) {
    try { log('subagents-reconcile', {output: parseOutput(await deps.reconcile())}); }
    catch (e) { log('subagents-reconcile-error', {error: (e as Error).message}); }
  }

  const own = statePathOf(deps);
  const saved = deps.dryRun && !await exists(own) ? await loadState(deps.statePath) : await loadState(own);
  const targets = await discoverTargets(deps.roots, now);
  // A `retired` without a reason came from the old rule and is judged again.
  const active = targets.filter(t => !(saved[t.key]?.retired && saved[t.key]?.retiredReason));
  const next: Record<string, TargetState> = {};
  for (const t of targets) if (saved[t.key]) next[t.key] = saved[t.key]!;

  const panes: PaneSnapshot[] = [];
  const readable = new Set<string>();
  /** A successor is looked for only when every Herdr session was read: an unread one may still hold the original. */
  let sawAll = false;
  if (active.length) {
    let sockets: string[] = [];
    try { sockets = await deps.fleet.sockets(); sawAll = true; } catch (e) { log('herdr-error', {error: (e as Error).message}); }
    for (const socket of sockets) {
      try { panes.push(...await deps.fleet.panes(socket)); readable.add(socket); }
      catch (e) { sawAll = false; log('herdr-error', {socket, error: (e as Error).message}); }
    }
  }
  /** Conversations some target or its sender already stands for; never taken over as another target's successor. */
  const claimed = new Set<string>(targets.flatMap(t => t.ownerSessionId ? [t.sessionId, t.ownerSessionId] : [t.sessionId]));
  for (const t of targets) { const id = next[t.key]?.rebound?.sessionId; if (id) claimed.add(id); }

  const epics = new Map<string, Promise<EpicObservation>>();
  for (const target of active) {
    let state = next[target.key] ?? initialTargetState();
    const epicKey = `${target.repo}#${target.epicIssue}`;
    if (!epics.has(epicKey)) epics.set(epicKey, deps.epic(target.repo, target.epicIssue));
    const epic = await epics.get(epicKey)!;
    // The stage is tracked under the conversation it was last rebound to; `key` stays the handoff's.
    let tracked: Target = state.rebound ? {...target, sessionId: state.rebound.sessionId} : target;
    const found = sawAll && !matchPane(tracked, panes) ? findSuccessor(tracked, panes, claimed) : {kind: 'none' as const};
    if (found.kind === 'one') {
      log('rebound', {...whoOf(target), from: tracked.sessionId, to: found.sessionId, paneId: found.pane.paneId, socket: found.pane.socket});
      state = {...state, rebound: {sessionId: found.sessionId, at: now}};
      delete state.loggedKey;
      claimed.add(found.sessionId);
      tracked = {...target, sessionId: found.sessionId};
    }
    let pane = await observePane(deps, tracked, state, panes, readable);
    // An undecided successor only replaces "gone"; a pane back at its shell is still relaunched.
    if (pane.kind === 'missing' || pane.kind === 'replaced') {
      if (found.kind === 'ambiguous') pane = {kind: 'ambiguous', paneIds: found.panes.map(p => `${p.socket}#${p.paneId}`)};
      else if (found.kind === 'outside-tab') pane = {kind: 'outside-tab', candidates: found.candidates.map(c => `${c.sessionId} ${c.pane.socket}#${c.pane.paneId}`)};
    }
    const ownerAlive = !!target.ownerSessionId && panes.some(p => p.agent === 'pi' && sessionMatches('pi', p.sessionValue, target.ownerSessionId!));
    const r = planTarget(tracked, {epic, pane, ownerAlive}, state, now, deps.plan);
    next[target.key] = r.next;
    for (const action of r.actions) await act(deps, tracked, action, log);
  }
  await saveState(own, next);
}

async function observePane(deps: WatchdogDeps, target: Target, state: TargetState, panes: PaneSnapshot[], readable: Set<string>): Promise<PaneObservation> {
  const hit = matchPane(target, panes);
  if (hit) {
    const idle = hit.status === 'idle' || hit.status === 'done';
    const tail = idle && target.agent === 'pi' && hit.sessionValue ? await deps.readTail(hit.sessionValue) : undefined;
    return {kind: 'agent', socket: hit.socket, paneId: hit.paneId, status: hit.status ?? 'unknown', revision: hit.revision, ...(target.agent === 'pi' && hit.sessionValue ? {sessionPath: hit.sessionValue} : {}), ...(tail ? {tail} : {})};
  }
  const seen = state.lastSeen;
  if (!seen || !readable.has(seen.socket)) return {kind: 'missing'};
  const there = panes.find(p => p.socket === seen.socket && p.paneId === seen.paneId);
  if (!there) return {kind: 'missing'};
  if (there.agent) return {kind: 'replaced', socket: seen.socket, paneId: seen.paneId};
  try { return (await deps.fleet.port(seen.socket).processInfo(seen.paneId)).shellReady ? {kind: 'shell', socket: seen.socket, paneId: seen.paneId} : {kind: 'missing'}; }
  catch { return {kind: 'missing'}; }
}

/** The pane as it is right now, for the re-check before typing. */
async function current(deps: WatchdogDeps, socket: string, paneId: string): Promise<PaneSnapshot | undefined> {
  try { return (await deps.fleet.panes(socket)).find(p => p.paneId === paneId); } catch { return undefined; }
}

const whoOf = (target: Target) => ({target: target.key, agent: target.agent, repo: target.repo, epic: target.epicIssue, stage: target.targetStage});

async function act(deps: WatchdogDeps, target: Target, action: WatchdogAction, log: Log): Promise<void> {
  const who = {...whoOf(target), ...(target.sessionId !== target.key ? {session: target.sessionId} : {})};
  if (action.type === 'log') { log(action.event, {...who, ...(action.detail !== undefined ? {detail: action.detail} : {})}); return; }
  if (deps.dryRun) { log('dry-run', {...who, action: action.type, paneId: action.paneId, socket: action.socket}); return; }
  if (action.type === 'prompt') {
    const now = await current(deps, action.socket, action.paneId);
    if (!now || now.revision !== action.revision || (now.status !== 'idle' && now.status !== 'done') || !sessionMatches(now.agent, now.sessionValue, target.sessionId)) {
      log('prompt-skipped', {...who, paneId: action.paneId, reason: 'pane changed before sending'});
      return;
    }
    try { await deps.fleet.port(action.socket).agentPrompt(action.paneId, action.text); log('prompted', {...who, paneId: action.paneId, socket: action.socket, reason: action.reason}); }
    catch (e) { log('prompt-error', {...who, paneId: action.paneId, error: (e as Error).message}); }
    return;
  }
  const now = await current(deps, action.socket, action.paneId);
  if (!now || now.agent) { log('relaunch-skipped', {...who, paneId: action.paneId, reason: 'pane changed before relaunch'}); return; }
  try { await deps.fleet.port(action.socket).paneRun(action.paneId, action.command); log('relaunched', {...who, paneId: action.paneId, socket: action.socket, command: action.command}); }
  catch (e) { log('relaunch-error', {...who, paneId: action.paneId, error: (e as Error).message}); }
}
