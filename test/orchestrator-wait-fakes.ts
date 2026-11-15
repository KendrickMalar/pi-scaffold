// Fakes shared by the orchestrator-wait tests.
import type {WaitTarget} from '../src/orchestrator-wait/targets.js';
import type {PaneSnapshot} from '../src/watchdog/herdr-fleet.js';

export class FakeReader {
  panesBySocket = new Map<string, PaneSnapshot[]>();
  failSockets = false;
  failPanes = new Set<string>();
  async sockets() { if (this.failSockets) throw new Error('session list failed'); return [...this.panesBySocket.keys()]; }
  async panes(socket: string) { if (this.failPanes.has(socket)) throw new Error(`pane list failed for ${socket}`); return structuredClone(this.panesBySocket.get(socket) ?? []); }
  boxPanesByName = new Map<string, PaneSnapshot[]>();
  failBoxes = new Set<string>();
  boxReads: string[] = [];
  async boxPanes(box: string) { this.boxReads.push(box); if (this.failBoxes.has(box)) throw new Error(`kec-orb ssh ${box} failed (exit 255): unreachable`); return structuredClone(this.boxPanesByName.get(box) ?? []); }
}
export const pane = (o: Partial<PaneSnapshot>): PaneSnapshot => ({socket: '/s/a.sock', paneId: 'w1:p1', agent: 'claude', status: 'working', revision: 1, ...o});
export const target = (o: Partial<WaitTarget> = {}): WaitTarget => {
  const socket = o.socket ?? '/s/a.sock', p = o.pane ?? 'w1:p1';
  return {key: `${socket}|${p}`, label: 'Epic #12', socket, pane: p, epics: [12], status: 'running', cleanupSockets: [socket], ...o};
};

export const boxTarget = (o: Partial<WaitTarget> = {}): WaitTarget => {
  const box = o.box ?? 'web-e12-rust', p = o.pane ?? 'w1:p1', socket = o.socket ?? '/s/h.sock';
  return {key: `box:${box}|${p}`, label: `Epic #12 box ${box}`, socket, pane: p, box, epics: [12], status: 'running', cleanupSockets: socket ? [socket] : [], ...o};
};
export const boxPane = (o: Partial<PaneSnapshot>): PaneSnapshot => pane({socket: 'box:web-e12-rust', ...o});
