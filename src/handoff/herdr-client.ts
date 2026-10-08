// Herdr control through its CLI with fixed argv (no shell). Only the confirmed 0.9.1 / protocol 22 surface is used.
import {execFile} from 'node:child_process';
import {LIMITS} from '../core/contracts.js';

export const SUPPORTED_HERDR = Object.freeze({version: '0.9.1', protocol: 22});
/** not-started/failed: definitely no effect; unknown: the request may have taken effect. */
export class HerdrError extends Error { constructor(readonly kind: 'not-started' | 'failed' | 'unknown', message: string) { super(message); } }

export interface HerdrPort {
  version(): Promise<{version: string; protocol: number}>;
  currentPane(): Promise<{workspaceId: string; paneId: string}>;
  tabCreate(o: {workspaceId: string; cwd: string; label: string}): Promise<{tabId: string; paneId: string}>;
  tabList(workspaceId: string): Promise<{tabId: string; label: string; paneId?: string}[]>;
  processInfo(paneId: string): Promise<{shellReady: boolean}>;
  paneRun(paneId: string, command: string): Promise<void>;
  agentPrompt(paneId: string, text: string): Promise<void>;
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

export function createHerdrCli(options: {bin?: string; socketPath?: string; timeoutMs?: number} = {}): HerdrPort {
  const run = (args: string[], mutation: boolean): Promise<string> => new Promise((resolve, reject) => {
    const env: Record<string, string> = {PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', LANG: 'C.UTF-8'};
    if (options.socketPath) env.HERDR_SOCKET_PATH = options.socketPath;
    execFile(options.bin ?? 'herdr', args, {env, timeout: options.timeoutMs ?? LIMITS.callTimeoutMs, maxBuffer: 1024 * 1024, shell: false}, (error, stdout, stderr) => {
      if (!error) return resolve(String(stdout));
      const e = error as NodeJS.ErrnoException & {killed?: boolean; signal?: string};
      if (e.code === 'ENOENT') return reject(new HerdrError('not-started', 'herdr is not installed.'));
      // A timeout or signal during a change may have applied it; a refused change exits with an error report.
      if (e.killed || e.signal) return reject(new HerdrError(mutation ? 'unknown' : 'failed', `herdr ${args[0]} did not finish.`));
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
    async agentPrompt(paneId, text) { await run(['agent', 'prompt', paneId, text], true); },
  };
}
