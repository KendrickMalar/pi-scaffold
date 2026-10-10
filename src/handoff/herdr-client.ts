// Herdr control through its CLI with fixed argv (no shell). Only the confirmed 0.9.1 / protocol 22 surface is used.
import {execFile} from 'node:child_process';
import {LIMITS} from '../core/contracts.js';

export const SUPPORTED_HERDR = Object.freeze({version: '0.9.1', protocol: 22});
/** not-started/failed: definitely no effect; unknown: the request may have taken effect. */
export class HerdrError extends Error { constructor(readonly kind: 'not-started' | 'failed' | 'unknown', message: string) { super(message); } }

/** `pane get`: a missing pane is not an error; `agent` is absent when Herdr detects no agent in it. */
export type PaneState = {exists: false} | {exists: true; agent?: string; status?: string};

export interface HerdrPort {
  version(): Promise<{version: string; protocol: number}>;
  currentPane(): Promise<{workspaceId: string; paneId: string}>;
  tabCreate(o: {workspaceId: string; cwd: string; label: string}): Promise<{tabId: string; paneId: string}>;
  tabList(workspaceId: string): Promise<{tabId: string; label: string; paneId?: string}[]>;
  processInfo(paneId: string): Promise<{shellReady: boolean}>;
  paneRun(paneId: string, command: string): Promise<void>;
  agentPrompt(paneId: string, text: string): Promise<void>;
  paneGet(paneId: string): Promise<PaneState>;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
/** First string value of `key` anywhere in a JSON value (Herdr nests results under result.<type>). */
function find(v: unknown, key: string): string | undefined {
  if (Array.isArray(v)) { for (const x of v) { const r = find(x, key); if (r !== undefined) return r; } return undefined; }
  if (!isRec(v)) return undefined;
  if (typeof v[key] === 'string') return v[key] as string;
  for (const x of Object.values(v)) { const r = find(x, key); if (r !== undefined) return r; }
  return undefined;
}
const SHELLS = /^-?(zsh|bash|fish|sh|dash|ksh)$/;

/** caller: HERDR_PANE_ID/WORKSPACE_ID/TAB_ID/SESSION of the calling pane; without them `--current` means the focused pane. */
export function createHerdrCli(options: {bin?: string; socketPath?: string; timeoutMs?: number; caller?: Record<string, string | undefined>} = {}): HerdrPort {
  const run = (args: string[], mutation: boolean, opts: {errorJson?: boolean} = {}): Promise<string> => new Promise((resolve, reject) => {
    const env: Record<string, string> = {PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', LANG: 'C.UTF-8'};
    if (options.socketPath) env.HERDR_SOCKET_PATH = options.socketPath;
    for (const k of ['HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_SESSION']) { const v = options.caller?.[k]; if (v) env[k] = v; }
    execFile(options.bin ?? 'herdr', args, {env, timeout: options.timeoutMs ?? LIMITS.callTimeoutMs, maxBuffer: 1024 * 1024, shell: false}, (error, stdout, stderr) => {
      if (!error) return resolve(String(stdout));
      const e = error as NodeJS.ErrnoException & {killed?: boolean; signal?: string};
      if (e.code === 'ENOENT') return reject(new HerdrError('not-started', 'herdr is not installed.'));
      // Read-only calls that report "not found" as a JSON error on stdout let the caller decide.
      if (opts.errorJson && !mutation && String(stdout).trim().startsWith('{')) return resolve(String(stdout));
      // A change that did not finish cleanly may already have been typed/applied: it is unknown, never definitely failed.
      if (mutation) return reject(new HerdrError('unknown', `herdr ${args.slice(0, 2).join(' ')} did not confirm: ${String(stderr).trim().slice(0, 200)}`));
      if (e.killed || e.signal) return reject(new HerdrError('failed', `herdr ${args[0]} did not finish.`));
      reject(new HerdrError('failed', `herdr ${args.slice(0, 2).join(' ')} failed: ${String(stderr).trim().slice(0, 200)}`));
    });
  });
  const json = (text: string): Rec => { try { const v = JSON.parse(text); if (isRec(v)) return v; } catch { /* below */ } throw new HerdrError('unknown', 'herdr returned unreadable output.'); };
  return {
    async version() {
      const v = /herdr (\d+\.\d+\.\d+)/.exec(await run(['--version'], false))?.[1];
      const p = /private_protocol:\s*(\d+)/.exec(await run(['status', 'server'], false))?.[1];
      if (!v || !p) throw new HerdrError('failed', 'herdr version/protocol could not be read.');
      return {version: v, protocol: Number(p)};
    },
    async currentPane() {
      const r = json(await run(['pane', 'current', '--current'], false));
      const workspaceId = find(r, 'workspace_id'), paneId = find(r, 'pane_id');
      if (!workspaceId || !paneId) throw new HerdrError('failed', 'Current pane could not be resolved.');
      return {workspaceId, paneId};
    },
    async tabCreate(o) {
      const r = json(await run(['tab', 'create', '--workspace', o.workspaceId, '--cwd', o.cwd, '--label', o.label], true));
      const tabId = find(r, 'tab_id'), paneId = find(r, 'pane_id') ?? find(r, 'root_pane_id');
      if (!tabId || !paneId) throw new HerdrError('unknown', 'Tab was requested but its ids could not be read.');
      return {tabId, paneId};
    },
    async tabList(workspaceId) {
      const r = json(await run(['tab', 'list', '--workspace', workspaceId], false));
      // 0.9.1: tab list has no pane ids; the root pane is the first pane listed for the tab.
      const tabs = (isRec(r.result) && Array.isArray(r.result.tabs) ? r.result.tabs : []).filter(isRec);
      const panes = json(await run(['pane', 'list', '--workspace', workspaceId], false));
      const paneList = (isRec(panes.result) && Array.isArray(panes.result.panes) ? panes.result.panes : []).filter(isRec);
      return tabs.filter(t => typeof t.tab_id === 'string').map(t => {
        const pane = paneList.find(p => p.tab_id === t.tab_id && typeof p.pane_id === 'string');
        return {tabId: t.tab_id as string, label: typeof t.label === 'string' ? t.label : '', ...(pane ? {paneId: pane.pane_id as string} : {})};
      });
    },
    async processInfo(paneId) {
      const r = json(await run(['pane', 'process-info', '--pane', paneId], false));
      const info = isRec(r.result) && isRec(r.result.process_info) ? r.result.process_info : undefined;
      const procs = Array.isArray(info?.foreground_processes) ? info!.foreground_processes.filter(isRec) : [];
      if (info && typeof info.shell_pid === 'number') return {shellReady: info.shell_pid === info.foreground_process_group_id};
      return {shellReady: procs.length === 1 && SHELLS.test(String(procs[0]!.name ?? ''))};
    },
    async paneRun(paneId, command) { await run(['pane', 'run', paneId, command], true); },
    async paneGet(paneId) {
      const r = json(await run(['pane', 'get', paneId], false, {errorJson: true}));
      if (isRec(r.error)) {
        if (r.error.code === 'pane_not_found') return {exists: false};
        throw new HerdrError('failed', `herdr pane get failed: ${String(r.error.code ?? 'error')}`);
      }
      const pane = isRec(r.result) && isRec(r.result.pane) ? r.result.pane : undefined;
      if (!pane) throw new HerdrError('failed', 'herdr pane get returned no pane.');
      return {exists: true, ...(typeof pane.agent === 'string' ? {agent: pane.agent} : {}), ...(typeof pane.agent_status === 'string' ? {status: pane.agent_status} : {})};
    },
    async agentPrompt(paneId, text) { await run(['agent', 'prompt', paneId, text], true); },
  };
}
