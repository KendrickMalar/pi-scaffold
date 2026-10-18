// scaffold-watchdog entry: reads its settings from argv and the environment, then runs one tick (--once, for
// launchd) or one tick a minute. See README "scaffold-watchdog".
import {execFile, execFileSync} from 'node:child_process';
import {existsSync, readdirSync} from 'node:fs';
import {statfs} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createGhEpicReader, createHerdrFleet} from './herdr-fleet.js';
import {readSessionTail} from '../watch/session-tail.js';
import {runOnce, type WatchdogDeps} from './run.js';
import {readChildRuns} from './children.js';
import type {StateRoot} from './discover.js';
import type {AgentKind} from './types.js';

export const INTERVAL_MS = 60_000;

/** SCAFFOLD_WATCHDOG_ROOTS="pi=/a/pi-scaffold,claude=/b/pi-scaffold"; default: every ~/.pi/agent*\/pi-scaffold and ~/.claude/scaffold/pi-scaffold. */
export function resolveRoots(env: NodeJS.ProcessEnv, home: string): StateRoot[] {
  const raw = env.SCAFFOLD_WATCHDOG_ROOTS;
  if (raw) {
    return raw.split(',').map(s => s.trim()).filter(Boolean).map(s => {
      const i = s.indexOf('=');
      const agent = s.slice(0, i), dir = s.slice(i + 1);
      if (i < 0 || (agent !== 'pi' && agent !== 'claude') || !dir.startsWith('/')) throw new Error(`SCAFFOLD_WATCHDOG_ROOTS entry "${s}" must be pi=/abs/path or claude=/abs/path.`);
      return {agent: agent as AgentKind, dir};
    });
  }
  const roots: StateRoot[] = [];
  const pi = join(home, '.pi');
  let names: string[] = [];
  try { names = readdirSync(pi).filter(n => n === 'agent' || n.startsWith('agent-')).sort(); } catch { /* no pi */ }
  for (const n of names) if (existsSync(join(pi, n, 'pi-scaffold'))) roots.push({agent: 'pi', dir: join(pi, n, 'pi-scaffold')});
  const claude = join(env.CLAUDE_SCAFFOLD_STATE_DIR ?? join(home, '.claude', 'scaffold'), 'pi-scaffold');
  if (existsSync(claude)) roots.push({agent: 'claude', dir: claude});
  return roots;
}

/** pi-subagents keeps runs under os.tmpdir(); launchd may start us without the TMPDIR Pi sessions see. */
export function reconcileEnv(env: NodeJS.ProcessEnv, darwinTemp: () => string | undefined = userTempDir): NodeJS.ProcessEnv {
  if (env.TMPDIR) return env;
  const dir = darwinTemp();
  return dir ? {...env, TMPDIR: dir} : env;
}
function userTempDir(): string | undefined {
  try { return execFileSync('getconf', ['DARWIN_USER_TEMP_DIR'], {encoding: 'utf8', timeout: 5000}).trim() || undefined; } catch { return undefined; }
}

/** SCAFFOLD_WATCHDOG_SUBAGENT_RUNS, else pi-subagents' own place: <TMPDIR>/pi-subagents-uid-<uid>/async-subagent-runs. */
export function childRunsDir(env: NodeJS.ProcessEnv, darwinTemp: () => string | undefined = userTempDir): string | undefined {
  if (env.SCAFFOLD_WATCHDOG_SUBAGENT_RUNS) return env.SCAFFOLD_WATCHDOG_SUBAGENT_RUNS;
  const tmp = reconcileEnv(env, darwinTemp).TMPDIR;
  return tmp && process.getuid ? join(tmp, `pi-subagents-uid-${process.getuid()}`, 'async-subagent-runs') : undefined;
}

function runCommand(path: string): Promise<string> {
  return new Promise((resolve, reject) => execFile(path, [], {env: reconcileEnv(process.env), timeout: 120_000, maxBuffer: 4 * 1024 * 1024}, (error, stdout, stderr) => {
    if (error) reject(new Error(`${path} failed: ${String(stderr).trim().slice(0, 300) || error.message}`)); else resolve(String(stdout));
  }));
}

export function depsFromEnv(env: NodeJS.ProcessEnv, argv: string[]): WatchdogDeps {
  const home = env.HOME ?? homedir();
  const reconcile = env.SCAFFOLD_WATCHDOG_SUBAGENTS_RECONCILE;
  const runs = childRunsDir(env);
  return {
    roots: resolveRoots(env, home),
    fleet: createHerdrFleet({bin: env.SCAFFOLD_WATCHDOG_HERDR ?? 'herdr'}),
    epic: createGhEpicReader({bin: env.SCAFFOLD_WATCHDOG_GH ?? 'gh'}),
    readTail: readSessionTail,
    statePath: env.SCAFFOLD_WATCHDOG_STATE ?? join(home, '.local', 'state', 'scaffold-watchdog', 'state.json'),
    logPath: env.SCAFFOLD_WATCHDOG_LOG ?? join(home, '.local', 'state', 'scaffold-watchdog.log'),
    now: Date.now,
    dryRun: argv.includes('--dry-run'),
    ...(reconcile ? {reconcile: () => runCommand(reconcile)} : {}),
    ...(runs ? {childRuns: () => readChildRuns(runs)} : {}),
    diskFree: async () => { const s = await statfs(home); return s.bavail * s.bsize; },
    plan: {...(env.SCAFFOLD_WATCHDOG_CLAUDE_COMMAND ? {claudeCommand: env.SCAFFOLD_WATCHDOG_CLAUDE_COMMAND} : {})},
  };
}

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const deps = depsFromEnv(env, argv);
  if (argv.includes('--once')) { await runOnce(deps); return 0; }
  await runOnce(deps);
  setInterval(() => { void runOnce(deps).catch(() => undefined); }, INTERVAL_MS);
  return await new Promise<number>(() => undefined);
}
