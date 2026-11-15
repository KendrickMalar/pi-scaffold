// Box reads for orchestrator-wait: `kec-orb ssh <box> <BOX_READ>` reads the box's own Herdr (its default socket)
// in one connection. Read-only. kec-orb joins its arguments into one box shell line, so the box name is checked
// against BOX_NAME before it gets here (targets.ts) and the box command is this fixed string.
import {spawn} from 'node:child_process';
import {parsePaneList, type PaneSnapshot} from '../watchdog/herdr-fleet.js';
import {parseTabListStrict} from './herdr.js';

export const BOX_SEP = '--- scaffold-orchestrator-wait tab list ---';
export const BOX_READ = `herdr pane list && printf '\\n%s\\n' '${BOX_SEP}' && herdr tab list`;

export type KecOrbRun = (args: string[]) => Promise<string>;
export interface BoxReader { boxPanes(box: string): Promise<PaneSnapshot[]> }

/** kec-orb runs ssh as a child of a bash function (no exec), so a timeout kills the whole process group:
 *  killing only kec-orb would leave ssh (and the box's herdr read) running. */
export function execKecOrb(bin: string, timeoutMs: number): KecOrbRun {
  return args => new Promise((resolve, reject) => {
    const env: Record<string, string> = {PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', LANG: 'C.UTF-8'};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && (k.startsWith('KEC_ORB_') || k === 'SSH_AUTH_SOCK')) env[k] = v;
    const what = `kec-orb ${args.slice(0, 2).join(' ')} failed`;
    let child;
    try { child = spawn(bin, args, {env, detached: true, stdio: ['ignore', 'pipe', 'pipe']}); } catch (e) { reject(new Error(`${what}: ${(e as Error).message}`)); return; }
    const out: Buffer[] = [], err: Buffer[] = [];
    let size = 0, timedOut = false, settled = false;
    const killGroup = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    const finish = (e?: Error) => { if (settled) return; settled = true; clearTimeout(timer); if (e) reject(e); else resolve(Buffer.concat(out).toString('utf8')); };
    child.stdout.on('data', (d: Buffer) => { size += d.length; if (size > 8 * 1024 * 1024) { killGroup(); finish(new Error(`${what}: output too large`)); } else out.push(d); });
    child.stderr.on('data', (d: Buffer) => { if (err.reduce((n, b) => n + b.length, 0) < 4096) err.push(d); });
    child.on('error', e => finish(new Error(`${what}: ${e.message}`)));
    child.on('close', (code, signal) => {
      if (timedOut) { finish(new Error(`${what} (timeout after ${timeoutMs} ms)`)); return; }
      if (code === 0) { finish(); return; }
      finish(new Error(`${what} (exit ${code ?? signal ?? '?'}): ${Buffer.concat(err).toString('utf8').trim().slice(0, 200)}`));
    });
  });
}

export function createBoxReader(o: {run: KecOrbRun}): BoxReader {
  return {
    async boxPanes(box) {
      const out = await o.run(['ssh', box, BOX_READ]);
      const lines = out.split('\n');
      const at = lines.indexOf(BOX_SEP);
      if (at < 0) throw new Error('box herdr output has no tab list separator.');
      const panes = parsePaneList(`box:${box}`, lines.slice(0, at).join('\n'));
      const labels = parseTabListStrict(lines.slice(at + 1).join('\n'));
      return panes.map(p => { const label = p.tabId ? labels.get(p.tabId) : undefined; return label ? {...p, tabLabel: label} : p; });
    },
  };
}
