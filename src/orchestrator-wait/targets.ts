// The tabs scaffold-orchestrator-wait watches, read from the orchestrator's state file (read-only: only the
// orchestrator writes that file). Box tabs are counted but not watched; the orchestrator reads them itself.

export type WaitTabStatus = 'launching' | 'running' | 'waiting' | 'cleanup_waiting';
export interface WaitTarget {
  /** `${socket}|${pane}`: pane ids repeat across Herdr sessions. */
  key: string;
  /** "Epic #12", "Epic #12 #13", or "terminal <id>" when the tab has no Epic yet. */
  label: string;
  socket: string;
  pane: string;
  epics: number[];
  status: WaitTabStatus;
  /** The tab's socket first, then every previous socket; no duplicates. */
  cleanupSockets: string[];
}
export interface Targets { targets: WaitTarget[]; boxTabs: number }

const ACTIVE: ReadonlySet<string> = new Set<WaitTabStatus>(['launching', 'running', 'waiting', 'cleanup_waiting']);
type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

export function readTargets(text: string): Targets {
  const v: unknown = JSON.parse(text);
  if (!isRec(v) || !Array.isArray(v.tabs)) throw new Error('state file has no tabs array.');
  const targets: WaitTarget[] = [];
  let boxTabs = 0;
  for (const t of v.tabs) {
    if (!isRec(t) || typeof t.status !== 'string' || !ACTIVE.has(t.status)) continue;
    if (str(t.box)) { boxTabs++; continue; }
    const socket = str(t.socket), pane = str(t.pane);
    if (!socket || !pane) continue;
    const epics = Array.isArray(t.epics) ? t.epics.filter((n): n is number => Number.isInteger(n)) : [];
    const previous = Array.isArray(t.previous) ? t.previous.filter(isRec).map(p => str(p.socket)).filter((s): s is string => !!s) : [];
    targets.push({
      key: `${socket}|${pane}`,
      label: epics.length ? `Epic ${epics.map(n => `#${n}`).join(' ')}` : `terminal ${str(t.terminal) ?? '?'}`,
      socket, pane, epics, status: t.status as WaitTabStatus,
      cleanupSockets: [...new Set([socket, ...previous])],
    });
  }
  return {targets, boxTabs};
}
