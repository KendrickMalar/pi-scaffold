// Every running Herdr session, read through the CLI with fixed argv (no shell). Pane ids repeat across sessions,
// so a pane is always (socket, paneId). Changes go through the existing pi-scaffold Herdr client per socket.
import {execFile} from 'node:child_process';
import {createHerdrCli, type HerdrPort} from '../handoff/herdr-client.js';
import type {EpicObservation, Target} from './types.js';

export interface PaneSnapshot { socket: string; paneId: string; agent?: string; status?: string; sessionValue?: string; revision: number; cwd?: string; tabId?: string; tabLabel?: string }
export interface Fleet {
  sockets(): Promise<string[]>;
  panes(socket: string): Promise<PaneSnapshot[]>;
  port(socket: string): Pick<HerdrPort, 'processInfo' | 'paneRun' | 'agentPrompt' | 'paneGet'>;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const parse = (text: string): unknown => { try { return JSON.parse(text); } catch { return undefined; } };

export function parseSessionList(text: string): string[] {
  const v = parse(text);
  if (!isRec(v) || !Array.isArray(v.sessions)) throw new Error('herdr session list returned unreadable output.');
  return v.sessions.filter(isRec).filter(s => s.running === true && typeof s.socket_path === 'string').map(s => s.socket_path as string);
}

export function parsePaneList(socket: string, text: string): PaneSnapshot[] {
  const v = parse(text);
  if (!isRec(v) || !isRec(v.result) || !Array.isArray(v.result.panes)) throw new Error('herdr pane list returned unreadable output.');
  return v.result.panes.filter(isRec).filter(p => typeof p.pane_id === 'string' && typeof p.revision === 'number').map(p => {
    const session = isRec(p.agent_session) && typeof p.agent_session.value === 'string' ? p.agent_session.value : undefined;
    return {socket, paneId: p.pane_id as string, ...(typeof p.agent === 'string' ? {agent: p.agent} : {}), ...(typeof p.agent_status === 'string' ? {status: p.agent_status} : {}), ...(session ? {sessionValue: session} : {}), revision: p.revision as number, ...(typeof p.cwd === 'string' ? {cwd: p.cwd} : {}), ...(typeof p.tab_id === 'string' ? {tabId: p.tab_id} : {})};
  });
}

/** `herdr tab list`: tab id → label. Unreadable output is no labels, not an error: labels only rank successors. */
export function parseTabList(text: string): Map<string, string> {
  const v = parse(text), map = new Map<string, string>();
  if (!isRec(v) || !isRec(v.result) || !Array.isArray(v.result.tabs)) return map;
  for (const t of v.result.tabs) if (isRec(t) && typeof t.tab_id === 'string' && typeof t.label === 'string') map.set(t.tab_id, t.label);
  return map;
}

/** Pi reports the session file path; Claude reports the session id. */
export function sessionMatches(agent: string | undefined, value: string | undefined, sessionId: string): boolean {
  if (!value) return false;
  return agent === 'pi' ? value.endsWith(`_${sessionId}.jsonl`) : value === sessionId;
}
export function matchPane(target: Target, panes: PaneSnapshot[]): PaneSnapshot | undefined {
  return panes.find(p => p.agent === target.agent && sessionMatches(p.agent, p.sessionValue, target.sessionId));
}

/** The session id a pane reports: Pi's file is `<time>_<id>.jsonl`, Claude reports the id itself. */
export function sessionIdOf(agent: string | undefined, value: string | undefined): string | undefined {
  if (!value) return undefined;
  return agent === 'pi' ? /_([^_/]+)\.jsonl$/.exec(value)?.[1] : value;
}

const PI_STAMP = /(?:^|\/)(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_[^/]+\.jsonl$/;
const UUID_V7 = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** When a conversation was created: Pi's file name, else a UUIDv7 id. Undefined when neither says. */
export function sessionCreatedAt(agent: string | undefined, value: string | undefined): number | undefined {
  const stamp = agent === 'pi' && value ? PI_STAMP.exec(value) : null;
  if (stamp) { const t = Date.parse(`${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}.${stamp[5]}Z`); if (Number.isFinite(t)) return t; }
  const v7 = UUID_V7.exec(sessionIdOf(agent, value) ?? '');
  return v7 ? parseInt(`${v7[1]}${v7[2]}`, 16) : undefined;
}

export type Successor = {kind: 'none'} | {kind: 'one'; pane: PaneSnapshot; sessionId: string} | {kind: 'ambiguous'; panes: PaneSnapshot[]};
/**
 * The conversation that took over a stage whose recorded one is gone: same agent and cwd, another conversation that
 * no other target or the owner holds (`claimed`), started after the handoff. The handoff's own tab wins; one
 * candidate is taken, several are never guessed. A conversation with no creation time counts only in that tab.
 */
export function findSuccessor(target: Target, panes: PaneSnapshot[], claimed: ReadonlySet<string>): Successor {
  const tagged = (p: PaneSnapshot) => target.tabTag !== undefined && p.tabLabel === target.tabTag;
  const candidates = panes.flatMap(p => {
    const id = sessionIdOf(p.agent, p.sessionValue);
    if (p.agent !== target.agent || p.cwd !== target.cwd || !id || id === target.sessionId || id === target.ownerSessionId || claimed.has(id)) return [];
    const created = sessionCreatedAt(p.agent, p.sessionValue);
    return (created === undefined ? tagged(p) : created > target.handoffAt) ? [{pane: p, sessionId: id}] : [];
  });
  const pool = candidates.some(c => tagged(c.pane)) ? candidates.filter(c => tagged(c.pane)) : candidates;
  if (pool.length === 1) return {kind: 'one', ...pool[0]!};
  return pool.length ? {kind: 'ambiguous', panes: pool.map(c => c.pane)} : {kind: 'none'};
}

/** `gh issue view --json state,labels`. More than one Stage label is never guessed. */
export function parseEpic(text: string): EpicObservation {
  const v = parse(text);
  if (!isRec(v) || typeof v.state !== 'string' || !Array.isArray(v.labels)) return 'unknown';
  const stages = v.labels.filter(isRec).map(l => l.name).filter((n): n is string => typeof n === 'string' && n.startsWith('Stage: '));
  if (stages.length > 1) return 'unknown';
  return {...(stages[0] ? {stageLabel: stages[0]} : {}), closed: v.state.toUpperCase() === 'CLOSED'};
}

function exec(bin: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => execFile(bin, args, {env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, shell: false}, (error, stdout, stderr) => {
    if (error) reject(new Error(`${bin} ${args.slice(0, 3).join(' ')} failed: ${String(stderr).trim().slice(0, 200) || error.message}`));
    else resolve(String(stdout));
  }));
}
const baseEnv = (): Record<string, string> => ({PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', LANG: 'C.UTF-8'});

export function createHerdrFleet(options: {bin?: string; timeoutMs?: number} = {}): Fleet {
  const bin = options.bin ?? 'herdr', timeoutMs = options.timeoutMs ?? 15_000;
  const ports = new Map<string, HerdrPort>();
  return {
    async sockets() { return parseSessionList(await exec(bin, ['session', 'list', '--json'], baseEnv(), timeoutMs)); },
    async panes(socket) {
      const env = {...baseEnv(), HERDR_SOCKET_PATH: socket};
      const panes = parsePaneList(socket, await exec(bin, ['pane', 'list'], env, timeoutMs));
      const labels = await exec(bin, ['tab', 'list'], env, timeoutMs).then(parseTabList, () => new Map<string, string>());
      return panes.map(p => { const label = p.tabId ? labels.get(p.tabId) : undefined; return label ? {...p, tabLabel: label} : p; });
    },
    port(socket) {
      let p = ports.get(socket);
      if (!p) { p = createHerdrCli({bin, socketPath: socket, timeoutMs}); ports.set(socket, p); }
      return p;
    },
  };
}

export function createGhEpicReader(options: {bin?: string; timeoutMs?: number} = {}): (repo: string, issue: number) => Promise<EpicObservation> {
  return async (repo, issue) => {
    try { return parseEpic(await exec(options.bin ?? 'gh', ['issue', 'view', String(issue), '--repo', repo, '--json', 'state,labels'], {...baseEnv(), ...(process.env.GH_CONFIG_DIR ? {GH_CONFIG_DIR: process.env.GH_CONFIG_DIR} : {}), ...(process.env.GH_TOKEN ? {GH_TOKEN: process.env.GH_TOKEN} : {})}, options.timeoutMs ?? 20_000)); }
    catch { return 'unknown'; }
  };
}
