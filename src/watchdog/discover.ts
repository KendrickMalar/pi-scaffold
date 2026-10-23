// Finds the stage sessions to watch from scaffold's own handoff records: packet.json says which Epic and stage,
// ready.json says which session received it. Works the same for Pi and Claude (claude-scaffold writes the same files).
// Read-only; anything malformed is skipped, never guessed.
import {readdir, readFile} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';
import type {AgentKind, Target, TargetStage} from './types.js';
import {isScaffoldProfile} from '../handoff/profiles.js';
import {accountOfAgentDir} from '../core/browser-account.js';

export interface StateRoot { /** A scaffold dir, e.g. ~/.pi/agent/pi-scaffold */ dir: string; agent: AgentKind }
/** Pi only: the agent directory a scaffold dir belongs to (…/.pi/agent or agent-<account>, then /pi-scaffold), so a relaunch keeps its account. */
export function agentDirOfRoot(root: StateRoot): string | undefined {
  return root.agent === 'pi' && basename(root.dir) === 'pi-scaffold' && accountOfAgentDir(dirname(root.dir)) ? dirname(root.dir) : undefined;
}
/** Handoffs older than this are not watched: an Epic left that long is not a stop to recover. */
export const MAX_HANDOFF_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const STAGES: readonly TargetStage[] = ['specification', 'basic-design', 'implementation', 'verification'];

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
async function json(path: string): Promise<unknown> { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return undefined; } }
async function dirs(path: string): Promise<string[]> {
  try { return (await readdir(path, {withFileTypes: true})).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; }
}

async function owners(dir: string): Promise<Map<string, string>> {
  const raw = await json(join(dir, 'state', 'watches.json'));
  const map = new Map<string, string>();
  if (!isRec(raw) || !Array.isArray(raw.watches)) return map;
  for (const w of raw.watches) {
    if (isRec(w) && isRec(w.entry) && typeof w.entry.targetSessionId === 'string' && typeof w.entry.ownerSessionId === 'string') map.set(w.entry.targetSessionId, w.entry.ownerSessionId);
  }
  return map;
}

export async function discoverTargets(roots: StateRoot[], now: number): Promise<Target[]> {
  const found = new Map<string, {target: Target; at: number}>();
  for (const root of roots) {
    const owner = await owners(root.dir), agentDir = agentDirOfRoot(root);
    const state = join(root.dir, 'state');
    for (const repo of await dirs(state)) for (const wf of await dirs(join(state, repo))) {
      const handoffs = join(state, repo, wf, 'handoff');
      for (const op of await dirs(handoffs)) {
        const p = await json(join(handoffs, op, 'packet.json')), r = await json(join(handoffs, op, 'ready.json'));
        if (!isRec(p) || !isRec(r) || r.phase !== 'receiver-ready' || typeof r.sessionId !== 'string' || typeof r.at !== 'string') continue;
        const at = Date.parse(r.at);
        if (!Number.isFinite(at) || now - at > MAX_HANDOFF_AGE_MS) continue;
        if (typeof p.repo !== 'string' || !Number.isInteger(p.epicIssue) || typeof p.cwd !== 'string' || !STAGES.includes(p.targetStage as TargetStage)) continue;
        const sessionId = r.sessionId, ownerSessionId = owner.get(sessionId);
        const tabTag = typeof r.nonceSha256 === 'string' && /^[0-9a-f]{64}$/.test(r.nonceSha256) ? `scaffold-${r.nonceSha256.slice(0, 12)}` : undefined;
        const target: Target = {key: sessionId, agent: root.agent, repo: p.repo, epicIssue: p.epicIssue as number, targetStage: p.targetStage as TargetStage, cwd: p.cwd, sessionId, handoffAt: at, ...(tabTag ? {tabTag} : {}), ...(ownerSessionId ? {ownerSessionId} : {}), ...(agentDir ? {agentDir} : {}), ...(isScaffoldProfile(p.profileId as string) && p.profileId !== 'developer' ? {profileId: p.profileId as string} : {})};
        const prev = found.get(sessionId);
        if (!prev || prev.at < at) found.set(sessionId, {target, at});
      }
    }
  }
  return [...found.values()].map(v => v.target);
}
