// One read of Herdr for the watched tabs. Read-only: host `session list`, `pane list` and `tab list`, and one
// `kec-orb ssh <box>` read per box (box.ts). A tab whose session or box could not be read is left out (never
// reported gone on a failed read).
import type {Fleet, PaneSnapshot} from '../watchdog/herdr-fleet.js';
import type {BoxReader} from './box.js';
import type {WaitTarget} from './targets.js';

export interface TabObs {
  /** The session is not running, the recorded pane is missing, or no agent runs in it. Stage panes are still
   *  collected: the verification parent closes the earlier stage tabs (often the recorded one) and keeps going. */
  gone: boolean;
  /** Scaffold body panes → agent_status: the recorded pane and the panes of the tab's stage tabs. */
  bodies: Record<string, string>;
  /** Some pane in the tab's cleanup sockets is `working`. */
  working: boolean;
}
export interface Observation { tabs: Map<string, TabObs>; errors: string[] }
export type WaitFleet = Pick<Fleet, 'sockets' | 'panes'> & BoxReader;

/** Stage tabs scaffold opens on handoff: `spec-e12`, `design-e12-r1`, `verify-e12-a1b2`. Manager tabs never match. */
export function stageTabPattern(epics: number[]): RegExp | undefined {
  if (!epics.length) return undefined;
  return new RegExp(`^(spec|design|impl|verify|setup)-e(${epics.join('|')})(-r[0-9]+)?(-[0-9a-f]{4})?$`);
}

export async function observe(targets: WaitTarget[], fleet: WaitFleet): Promise<Observation> {
  const tabs = new Map<string, TabObs>(), errors: string[] = [];
  let running: Set<string>;
  try { running = new Set(await fleet.sockets()); } catch (e) { errors.push(`herdr session list: ${(e as Error).message}`); return {tabs, errors}; }
  const wanted = new Set(targets.flatMap(t => t.cleanupSockets));
  const panes = new Map<string, PaneSnapshot[] | undefined>();
  for (const socket of wanted) {
    if (!running.has(socket)) { panes.set(socket, []); continue; }
    try { panes.set(socket, await fleet.panes(socket)); } catch (e) { panes.set(socket, undefined); errors.push(`herdr pane list ${socket}: ${(e as Error).message}`); }
  }
  const boxes = new Map<string, PaneSnapshot[] | undefined>();
  await Promise.all([...new Set(targets.flatMap(t => (t.box ? [t.box] : [])))].map(async box => {
    try { boxes.set(box, await fleet.boxPanes(box)); } catch (e) { boxes.set(box, undefined); errors.push(`kec-orb ssh ${box}: ${(e as Error).message}`); }
  }));
  for (const t of targets) {
    const own = t.box ? boxes.get(t.box) : panes.get(t.socket);
    if (own === undefined) continue;
    const recorded = own.find(p => p.paneId === t.pane);
    const gone = (!t.box && !running.has(t.socket)) || !recorded || !recorded.agent;
    const stage = stageTabPattern(t.epics);
    const bodies: Record<string, string> = {};
    for (const p of own) {
      if (!p.agent) continue;
      if (p.paneId === t.pane || (stage && p.tabLabel && stage.test(p.tabLabel))) bodies[p.paneId] = p.status ?? 'unknown';
    }
    const isWorking = (ps: PaneSnapshot[]) => ps.some(p => p.status === 'working');
    const working = (t.box !== undefined && isWorking(own)) || t.cleanupSockets.some(s => isWorking(panes.get(s) ?? []));
    tabs.set(t.key, {gone, bodies, working});
  }
  return {tabs, errors};
}
