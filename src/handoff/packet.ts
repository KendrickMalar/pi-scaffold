// Private handoff packet and receipts (owner-only files under the workflow state root). The nonce stays here.
import {join} from 'node:path';
import {StrictReader, STAGES, isRepoRef, isSha256, isUuid, problem, failed, okValue, type Decoded, type Sha256, type Stage} from '../core/contracts.js';
import {sha256Bytes, sha256Text} from '../core/digests.js';
import {OwnedFileError, readOwnedFile, readOwnedJson, writeOwnedFile} from '../core/files.js';

export interface HandoffPacketV1 {
  version: 1; nonce: string; workflowId: string; repo: string; epicIssue: number; sourceStage: Stage; targetStage: Stage;
  artifactDigests: {epicBodySha256: Sha256; epicLabelsSha256: Sha256}; cwd: string; profileId: string; profileInstructionsDigest: Sha256;
  accountBinding: Sha256; requiredTools: string[]; resourceRefs: string[];
}
export type ReceiptPhase = 'receiver-ready' | 'turn-started';
export interface HandoffReceiptFile { version: 1; phase: ReceiptPhase; nonceSha256: Sha256; packetSha256: Sha256; sessionId: string; at: string }

export const handoffDir = (workflowStateRoot: string, operationId: string) => join(workflowStateRoot, 'handoff', operationId);
export const nonceSha256 = (nonce: string) => sha256Text(nonce);

export async function writePacket(dir: string, packet: HandoffPacketV1, root: string): Promise<{path: string; sha256: Sha256}> {
  const text = JSON.stringify(packet, null, 2) + '\n', path = join(dir, 'packet.json');
  await writeOwnedFile(path, text, {root});
  return {path, sha256: sha256Text(text)};
}

export function decodePacket(v: unknown): Decoded<HandoffPacketV1> {
  const r = new StrictReader();
  const o = r.object(v, '', ['version', 'nonce', 'workflowId', 'repo', 'epicIssue', 'sourceStage', 'targetStage', 'artifactDigests', 'cwd', 'profileId', 'profileInstructionsDigest', 'accountBinding', 'requiredTools', 'resourceRefs']) ?? {};
  r.literal(o.version, 'version', [1] as const, 'UNKNOWN_VERSION');
  const a = r.object(o.artifactDigests, 'artifactDigests', ['epicBodySha256', 'epicLabelsSha256']) ?? {};
  return r.result({
    version: 1, nonce: r.pattern(o.nonce, 'nonce', x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x), '64 hex'),
    workflowId: r.pattern(o.workflowId, 'workflowId', isUuid, 'UUID'), repo: r.pattern(o.repo, 'repo', isRepoRef, 'OWNER/REPO'), epicIssue: r.int(o.epicIssue, 'epicIssue'),
    sourceStage: r.literal(o.sourceStage, 'sourceStage', STAGES), targetStage: r.literal(o.targetStage, 'targetStage', STAGES),
    artifactDigests: {epicBodySha256: r.pattern(a.epicBodySha256, 'artifactDigests.epicBodySha256', isSha256, 'sha256'), epicLabelsSha256: r.pattern(a.epicLabelsSha256, 'artifactDigests.epicLabelsSha256', isSha256, 'sha256')},
    cwd: r.text(o.cwd, 'cwd'), profileId: r.text(o.profileId, 'profileId'), profileInstructionsDigest: r.pattern(o.profileInstructionsDigest, 'profileInstructionsDigest', isSha256, 'sha256'),
    accountBinding: r.pattern(o.accountBinding, 'accountBinding', isSha256, 'sha256'), requiredTools: r.texts(o.requiredTools, 'requiredTools'), resourceRefs: r.texts(o.resourceRefs, 'resourceRefs'),
  });
}

export async function readPacket(path: string, root: string): Promise<Decoded<{packet: HandoffPacketV1; sha256: Sha256}>> {
  let bytes: Buffer;
  try { bytes = await readOwnedFile(path, {root, maxBytes: 64 * 1024}); }
  catch (e) { return failed([problem(e instanceof OwnedFileError ? e.code : 'PACKET_UNREADABLE', 'packet', (e as Error).message)]); }
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return failed([problem('PACKET_INVALID', 'packet', 'Packet is not JSON.')]); }
  const decoded = decodePacket(value);
  return decoded.ok ? okValue({packet: decoded.value, sha256: sha256Bytes(bytes)}) : decoded;
}

export async function writeReceipt(dir: string, receipt: HandoffReceiptFile, root: string): Promise<void> {
  await writeOwnedFile(join(dir, receipt.phase === 'receiver-ready' ? 'ready.json' : 'started.json'), JSON.stringify(receipt, null, 2), {root});
}
export async function readReceipt(dir: string, phase: ReceiptPhase, root: string): Promise<HandoffReceiptFile | undefined> {
  try {
    const v = await readOwnedJson(join(dir, phase === 'receiver-ready' ? 'ready.json' : 'started.json'), {root, maxBytes: 16 * 1024}) as HandoffReceiptFile;
    return v && v.version === 1 && v.phase === phase && isSha256(v.nonceSha256) && isSha256(v.packetSha256) && typeof v.sessionId === 'string' ? v : undefined;
  } catch (e) { if (e instanceof OwnedFileError && e.code === 'NOT_FOUND') return undefined; throw e; }
}
