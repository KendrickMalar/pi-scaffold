// scaffold-orchestrator-wait <state file>: what the orchestrator runs instead of `sleep 300`. See README.
import {setTimeout as delay} from 'node:timers/promises';
import {createHerdrFleet} from '../watchdog/herdr-fleet.js';
import {waitForChange, type WaitResult} from './run.js';

export const INTERVAL_MS = 5_000;
export const MAX_WAIT_MS = 300_000;

function positive(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, out: (s: string) => void = s => process.stdout.write(s), err: (s: string) => void = s => process.stderr.write(s)): Promise<number> {
  const statePath = argv[0];
  if (!statePath || argv.length !== 1) { err('usage: scaffold-orchestrator-wait <state file>\n'); return 2; }
  let result: WaitResult;
  try {
    result = await waitForChange({
      statePath, recordPath: `${statePath}.wait.json`,
      fleet: createHerdrFleet({bin: env.SCAFFOLD_ORCH_WAIT_HERDR ?? 'herdr'}),
      now: Date.now, sleep: ms => delay(ms),
      intervalMs: positive(env.SCAFFOLD_ORCH_WAIT_INTERVAL_MS, INTERVAL_MS),
      maxWaitMs: positive(env.SCAFFOLD_ORCH_WAIT_MAX_MS, MAX_WAIT_MS),
    });
  } catch (e) { err(`scaffold-orchestrator-wait: ${(e as Error).message}\n`); return 2; }
  if (result.kind === 'changes') out(result.lines.map(l => `${l}\n`).join(''));
  else out(result.errors.length ? `timeout (errors: ${result.errors.join('; ')})\n` : 'timeout\n');
  return 0;
}
