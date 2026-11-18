// Which changes between two reads of one tab should wake the orchestrator (design 3.2). One line per change.
import type {TabObs} from './observe.js';
import type {WaitTarget} from './targets.js';

const RESTING = new Set(['idle', 'done']);

export function diffTab(t: WaitTarget, before: TabObs | undefined, cur: TabObs): string[] {
  // The manager went away (agent gone or tab closed): one "gone" line per manager pane; the stage tabs it hid are
  // compared from the next read on.
  if (before?.manager && !cur.manager) return Object.keys(before.bodies).filter(p => !(p in cur.bodies)).map(p => `${t.label} ${p} gone`);
  // A manager appeared: the stage panes we recorded are no longer bodies, so they are not "gone".
  const prev = before && cur.manager && !before.manager ? {...before, bodies: {}, gone: false} : before;
  const gone = `${t.label} pane ${t.pane} gone`;
  if (!prev) {
    const blocked = Object.entries(cur.bodies).filter(([, s]) => s === 'blocked').map(([p]) => `${t.label} ${p} new->blocked`);
    return cur.gone ? [gone, ...blocked] : blocked;
  }
  const lines: string[] = cur.gone && !prev.gone ? [gone] : [];
  for (const [p, c] of Object.entries(cur.bodies)) {
    const before = prev.bodies[p];
    const from = before ?? 'new';
    if (c === 'blocked' && before !== 'blocked') lines.push(`${t.label} ${p} ${from}->blocked`);
    else if (RESTING.has(c) && before !== undefined && !RESTING.has(before)) lines.push(`${t.label} ${p} ${from}->${c}`);
  }
  for (const p of Object.keys(prev.bodies)) if (!(p in cur.bodies) && p !== t.pane) lines.push(`${t.label} ${p} gone`);
  if (t.status === 'cleanup_waiting' && prev.working && !cur.working) lines.push(`${t.label} cleanup: no working agent`);
  return lines;
}
