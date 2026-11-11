// Fakes shared by the orchestrator-wait tests.
import type {WaitTarget} from '../src/orchestrator-wait/targets.js';
import type {PaneSnapshot} from '../src/watchdog/herdr-fleet.js';

export class FakeReader {
  panesBySocket = new Map<string, PaneSnapshot[]>();
  failSockets = false;
  failPanes = new Set<string>();
  async sockets() { if (this.failSockets) throw new Error('session list failed'); return [...this.panesBySocket.keys()]; }
  async panes(socket: string) { if (this.failPanes.has(socket)) throw new Error(`pane list failed for ${socket}`); return structuredClone(this.panesBySocket.get(socket) ?? []); }
}
export const pane = (o: Partial<PaneSnapshot>): PaneSnapshot => ({socket: '/s/a.sock', paneId: 'w1:p1', agent: 'claude', status: 'working', revision: 1, ...o});
export const target = (o: Partial<WaitTarget> = {}): WaitTarget => {
  const socket = o.socket ?? '/s/a.sock', p = o.pane ?? 'w1:p1';
  return {key: `${socket}|${p}`, label: 'Epic #12', socket, pane: p, epics: [12], status: 'running', cleanupSockets: [socket], ...o};
};

