// Which changes between two reads of one tab should wake the orchestrator (design 3.2). One line per change.
import type {TabObs} from './observe.js';
import type {WaitTarget} from './targets.js';

const RESTING = new Set(['idle', 'done']);

export function diffTab(t: WaitTarget, prev: TabObs | undefined, cur: TabObs): string[] {
  const gone = `${t.label} pane ${t.pane} gone`;
  if (!prev) {
    if (cur.gone) return [gone];
    return Object.entries(cur.bodies).filter(([, s]) => s === 'blocked').map(([p]) => `${t.label} ${p} new->blocked`);
  }
  if (cur.gone) return prev.gone ? [] : [gone];
  const lines: string[] = [];
  for (const [p, c] of Object.entries(cur.bodies)) {
    const before = prev.bodies[p];
    const from = before ?? 'new';
    if (c === 'blocked' && before !== 'blocked') lines.push(`${t.label} ${p} ${from}->blocked`);
    else if (RESTING.has(c) && before !== undefined && !RESTING.has(before)) lines.push(`${t.label} ${p} ${from}->${c}`);
  }
  if (!prev.gone) for (const p of Object.keys(prev.bodies)) if (!(p in cur.bodies) && p !== t.pane) lines.push(`${t.label} ${p} gone`);
  if (t.status === 'cleanup_waiting' && prev.working && !cur.working) lines.push(`${t.label} cleanup: no working agent`);
  return lines;
}
