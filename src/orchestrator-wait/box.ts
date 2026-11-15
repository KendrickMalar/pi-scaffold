// Box reads for orchestrator-wait: `kec-orb ssh <box> <BOX_READ>` reads the box's own Herdr (its default socket)
// in one connection. Read-only. kec-orb joins its arguments into one box shell line, so the box name is checked
// against BOX_NAME before it gets here (targets.ts) and the box command is this fixed string.
import {execFile} from 'node:child_process';
import {parsePaneList, type PaneSnapshot} from '../watchdog/herdr-fleet.js';
import {parseTabListStrict} from './herdr.js';

export const BOX_SEP = '--- scaffold-orchestrator-wait tab list ---';
export const BOX_READ = `herdr pane list && printf '\\n%s\\n' '${BOX_SEP}' && herdr tab list`;

export type KecOrbRun = (args: string[]) => Promise<string>;
export interface BoxReader { boxPanes(box: string): Promise<PaneSnapshot[]> }

export function execKecOrb(bin: string, timeoutMs: number): KecOrbRun {
  return args => new Promise((resolve, reject) => {
    const env: Record<string, string> = {PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', LANG: 'C.UTF-8'};
    execFile(bin, args, {env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, shell: false}, (error, stdout, stderr) => {
      if (!error) { resolve(String(stdout)); return; }
      const code = typeof error.code === 'number' ? String(error.code) : error.signal ?? String(error.code ?? '?');
      reject(new Error(`kec-orb ${args.slice(0, 2).join(' ')} failed (exit ${code}): ${String(stderr).trim().slice(0, 200) || error.message}`));
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
