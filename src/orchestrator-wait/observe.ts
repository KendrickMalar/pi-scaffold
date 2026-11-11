// One read of Herdr for the watched tabs. Read-only: only `session list`, `pane list` and `tab list`.
// A tab whose session could not be read is left out (never reported gone on a failed read).
import type {Fleet, PaneSnapshot} from '../watchdog/herdr-fleet.js';
import type {WaitTarget} from './targets.js';

export interface TabObs {
  /** The session is not running, the recorded pane is missing, or no agent runs in it. */
  gone: boolean;
  /** Scaffold body panes → agent_status: the recorded pane and the panes of the tab's stage tabs. */
  bodies: Record<string, string>;
  /** Some pane in the tab's cleanup sockets is `working`. */
  working: boolean;
}
export interface Observation { tabs: Map<string, TabObs>; errors: string[] }

/** Stage tabs scaffold opens on handoff: `spec-e12`, `design-e12-r1`, `verify-e12-a1b2`. Manager tabs never match. */
export function stageTabPattern(epics: number[]): RegExp | undefined {
  if (!epics.length) return undefined;
  return new RegExp(`^(spec|design|impl|verify|setup)-e(${epics.join('|')})(-r[0-9]+)?(-[0-9a-f]{4})?$`);
}

export async function observe(targets: WaitTarget[], fleet: Pick<Fleet, 'sockets' | 'panes'>): Promise<Observation> {
  const tabs = new Map<string, TabObs>(), errors: string[] = [];
  let running: Set<string>;
  try { running = new Set(await fleet.sockets()); } catch (e) { errors.push(`herdr session list: ${(e as Error).message}`); return {tabs, errors}; }
  const wanted = new Set(targets.flatMap(t => t.cleanupSockets));
  const panes = new Map<string, PaneSnapshot[] | undefined>();
  for (const socket of wanted) {
    if (!running.has(socket)) { panes.set(socket, []); continue; }
    try { panes.set(socket, await fleet.panes(socket)); } catch (e) { panes.set(socket, undefined); errors.push(`herdr pane list ${socket}: ${(e as Error).message}`); }
  }
  for (const t of targets) {
    const own = panes.get(t.socket);
    if (own === undefined) continue;
    const recorded = own.find(p => p.paneId === t.pane);
    const gone = !running.has(t.socket) || !recorded || !recorded.agent;
    const stage = stageTabPattern(t.epics);
    const bodies: Record<string, string> = {};
    for (const p of own) {
      if (!p.agent) continue;
      if (p.paneId === t.pane || (stage && p.tabLabel && stage.test(p.tabLabel))) bodies[p.paneId] = p.status ?? 'unknown';
    }
    const working = t.cleanupSockets.some(s => (panes.get(s) ?? []).some(p => p.status === 'working'));
    tabs.set(t.key, {gone, bodies: gone ? {} : bodies, working});
  }
  return {tabs, errors};
}
