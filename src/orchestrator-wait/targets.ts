// The tabs scaffold-orchestrator-wait watches, read from the orchestrator's state file (read-only: only the
// orchestrator writes that file). Box tabs (`box` set) are watched through `kec-orb ssh <box>`; see box.ts.

export type WaitTabStatus = 'launching' | 'running' | 'waiting' | 'cleanup_waiting';
export interface WaitTarget {
  /** `${socket}|${pane}`, or `box:${box}|${pane}` for a box tab: pane ids repeat across Herdr sessions. */
  key: string;
  /** "Epic #12", "Epic #12 #13", or "terminal <id>" when the tab has no Epic yet. */
  label: string;
  /** Host socket. A box tab keeps its host spec tab's socket here (may be ''); its body runs in the box. */
  socket: string;
  /** kec-orb box name (already checked against BOX_NAME). The pane is read inside this box. */
  box?: string;
  pane: string;
  epics: number[];
  status: WaitTabStatus;
  /** The tab's socket first, then every previous socket; no duplicates. */
  cleanupSockets: string[];
}
export interface Targets { targets: WaitTarget[]; errors: string[] }

/** kec-orb `check_name`: only these names reach `kec-orb ssh` (it joins its arguments into one box shell line). */
export const BOX_NAME: readonly RegExp[] = [/^[a-z0-9]([a-z0-9-]{0,39}[a-z0-9])?$/, /^sched-[a-z0-9-]{1,40}$/];

const ACTIVE: ReadonlySet<string> = new Set<WaitTabStatus>(['launching', 'running', 'waiting', 'cleanup_waiting']);
type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

export function readTargets(text: string): Targets {
  const v: unknown = JSON.parse(text);
  if (!isRec(v) || !Array.isArray(v.tabs)) throw new Error('state file has no tabs array.');
  const targets: WaitTarget[] = [], errors: string[] = [];
  for (const t of v.tabs) {
    if (!isRec(t) || typeof t.status !== 'string' || !ACTIVE.has(t.status)) continue;
    const box = str(t.box), socket = str(t.socket), pane = str(t.pane);
    if (!pane || (!box && !socket)) continue;
    if (box && !BOX_NAME.some(re => re.test(box))) { errors.push(`box name rejected: ${box}`); continue; }
    const epics = Array.isArray(t.epics) ? t.epics.filter((n): n is number => Number.isInteger(n)) : [];
    const previous = Array.isArray(t.previous) ? t.previous.filter(isRec).map(p => str(p.socket)).filter((s): s is string => !!s) : [];
    const name = epics.length ? `Epic ${epics.map(n => `#${n}`).join(' ')}` : `terminal ${str(t.terminal) ?? '?'}`;
    targets.push({
      key: box ? `box:${box}|${pane}` : `${socket}|${pane}`,
      label: box ? `${name} box ${box}` : name,
      socket: socket ?? '', pane, epics, status: t.status as WaitTabStatus,
      ...(box ? {box} : {}),
      cleanupSockets: [...new Set([...(socket ? [socket] : []), ...previous])],
    });
  }
  return {targets, errors};
}
