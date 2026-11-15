// scaffold-orchestrator-wait <state file>: what the orchestrator runs instead of `sleep 300`. See README.
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createBoxReader, execKecOrb} from './box.js';
import {createStrictReader, execHerdr} from './herdr.js';
import {waitForChange, type WaitResult} from './run.js';

export const INTERVAL_MS = 5_000;
export const MAX_WAIT_MS = 300_000;

function positive(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, out: (s: string) => void = s => process.stdout.write(s), err: (s: string) => void = s => process.stderr.write(s)): Promise<number> {
  const raw = argv[0];
  if (!raw || argv.length !== 1) { err('usage: scaffold-orchestrator-wait <state file>\n'); return 2; }
  // The orchestrator copies the skill's `~/.local/state/…` form; a quoted `~` reaches us unexpanded.
  const statePath = raw.startsWith('~/') && env.HOME ? join(env.HOME, raw.slice(2)) : raw;
  let result: WaitResult;
  try {
    result = await waitForChange({
      statePath, recordPath: `${statePath}.wait.json`,
      fleet: {
        ...createStrictReader({run: execHerdr(env.SCAFFOLD_ORCH_WAIT_HERDR ?? 'herdr', 15_000)}),
        ...createBoxReader({run: execKecOrb(env.SCAFFOLD_ORCH_WAIT_KEC_ORB ?? 'kec-orb', 15_000)}),
      },
      now: Date.now, sleep: ms => delay(ms),
      intervalMs: positive(env.SCAFFOLD_ORCH_WAIT_INTERVAL_MS, INTERVAL_MS),
      maxWaitMs: positive(env.SCAFFOLD_ORCH_WAIT_MAX_MS, MAX_WAIT_MS),
    });
  } catch (e) { err(`scaffold-orchestrator-wait: ${(e as Error).message}\n`); return 2; }
  if (result.kind === 'changes') out(result.lines.map(l => `${l}\n`).join(''));
  else out(result.errors.length ? `timeout (errors: ${result.errors.join('; ')})\n` : 'timeout\n');
  return 0;
}
