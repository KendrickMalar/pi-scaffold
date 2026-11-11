// Herdr reads for orchestrator-wait. Unlike the watchdog's fleet, a failed or unreadable `tab list` fails the
// whole socket read: without labels every stage pane would look gone.
import {execFile} from 'node:child_process';
import {parsePaneList, parseSessionList, type Fleet} from '../watchdog/herdr-fleet.js';

export type HerdrRun = (args: string[], socket?: string) => Promise<string>;
type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseTabListStrict(text: string): Map<string, string> {
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new Error('herdr tab list returned unreadable output.'); }
  if (!isRec(v) || !isRec(v.result) || !Array.isArray(v.result.tabs)) throw new Error('herdr tab list returned unreadable output.');
  const map = new Map<string, string>();
  for (const t of v.result.tabs) if (isRec(t) && typeof t.tab_id === 'string' && typeof t.label === 'string') map.set(t.tab_id, t.label);
  return map;
}

export function execHerdr(bin: string, timeoutMs: number): HerdrRun {
  return (args, socket) => new Promise((resolve, reject) => {
    const env: Record<string, string> = {PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', LANG: 'C.UTF-8', ...(socket ? {HERDR_SOCKET_PATH: socket} : {})};
    execFile(bin, args, {env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, shell: false}, (error, stdout, stderr) => {
      if (error) reject(new Error(`herdr ${args.slice(0, 2).join(' ')} failed: ${String(stderr).trim().slice(0, 200) || error.message}`));
      else resolve(String(stdout));
    });
  });
}

export function createStrictReader(o: {run: HerdrRun}): Pick<Fleet, 'sockets' | 'panes'> {
  return {
    async sockets() { return parseSessionList(await o.run(['session', 'list', '--json'])); },
    async panes(socket) {
      const panes = parsePaneList(socket, await o.run(['pane', 'list'], socket));
      const labels = parseTabListStrict(await o.run(['tab', 'list'], socket));
      return panes.map(p => { const label = p.tabId ? labels.get(p.tabId) : undefined; return label ? {...p, tabLabel: label} : p; });
    },
  };
}
