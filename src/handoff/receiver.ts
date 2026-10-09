// Runs in the receiving Pi (--scaffold-handoff <packet>). Confirms the packet belongs to this session's
// cwd/profile/account/tools and writes owner-only receipts the driver waits for. It is not an AI tool.
import {dirname, join} from 'node:path';
import {realpath} from 'node:fs/promises';
import {failed, okValue, problem, type Decoded, type Problem} from '../core/contracts.js';
import {taggedDigest} from '../core/digests.js';
import {readProfileSnapshot} from '../core/repo-context.js';
import {repoPolicyFor, type OwnerPolicy} from '../core/model-bindings.js';
import {nonceSha256, readPacket, readReceipt, writeReceipt, type HandoffPacketV1} from './packet.js';

const real = async (p: string) => { try { return await realpath(p); } catch { return p; } };

export interface ReceiverInput {
  packetPath: string; agentDir: string; cwd: string; sessionId: string;
  sessionEntries: readonly unknown[]; toolNames: readonly string[]; policy: OwnerPolicy | undefined;
}
export async function acceptStartupPacket(input: ReceiverInput): Promise<Decoded<{packet: HandoffPacketV1; packetSha256: string}>> {
  const root = join(input.agentDir, 'pi-scaffold');
  const read = await readPacket(input.packetPath, root);
  if (!read.ok) return read;
  const {packet, sha256} = read.value;
  const problems: Problem[] = [];
  if (await real(input.cwd) !== await real(packet.cwd)) problems.push(problem('RECEIVER_CWD_MISMATCH', 'cwd', `This session runs in ${input.cwd}, not ${packet.cwd}.`));
  const profile = readProfileSnapshot(input.sessionEntries);
  if (!profile.snapshot || profile.snapshot.id !== packet.profileId || profile.snapshot.instructionsDigest !== packet.profileInstructionsDigest)
    problems.push(problem('RECEIVER_PROFILE_MISMATCH', 'profile', 'This session does not run the same pi-profile Profile and instructions as the sender.'));
  const authMode = repoPolicyFor(input.policy, packet.repo)?.authMode;
  const binding = authMode === 'file-backed' ? taggedDigest('account-binding', {agentDir: await real(input.agentDir), authMode}) : null;
  if (binding !== packet.accountBinding) problems.push(problem('RECEIVER_ACCOUNT_MISMATCH', 'account', 'This session does not use the same file-backed authentication configuration.'));
  const missing = packet.requiredTools.filter(t => !input.toolNames.includes(t));
  if (missing.length) problems.push(problem('REQUIRED_TOOL_MISSING', 'tools', `Missing tools in this session: ${missing.join(', ')}.`));
  if (problems.length) return failed(problems);
  const dir = dirname(input.packetPath);
  const existing = await readReceipt(dir, 'receiver-ready', root);
  if (existing && existing.sessionId !== input.sessionId) return failed([problem('RECEIVER_ALREADY_CLAIMED', 'session', 'Another session already accepted this packet.')]);
  if (!existing) await writeReceipt(dir, {version: 1, phase: 'receiver-ready', nonceSha256: nonceSha256(packet.nonce), packetSha256: sha256, sessionId: input.sessionId, at: new Date().toISOString()}, root);
  return okValue({packet, packetSha256: sha256});
}

/** Called on the first agent turn of the accepting session. Only that session can record the start. */
export const promptTag = (nonceSha256: string) => `scaffold-${nonceSha256.slice(0, 12)}`;
export async function recordTurnStarted(input: {packetPath: string; agentDir: string; sessionId: string; prompt: string}): Promise<boolean> {
  const root = join(input.agentDir, 'pi-scaffold'), dir = dirname(input.packetPath);
  const ready = await readReceipt(dir, 'receiver-ready', root);
  // Only the fixed stage prompt (carrying this packet's tag) starts the handoff turn.
  if (!ready || !input.prompt.includes(promptTag(ready.nonceSha256))) return false;
  if (!ready || ready.sessionId !== input.sessionId || await readReceipt(dir, 'turn-started', root)) return false;
  await writeReceipt(dir, {...ready, phase: 'turn-started', at: new Date().toISOString()}, root);
  return true;
}
