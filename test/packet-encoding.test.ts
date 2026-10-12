import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, rm, writeFile, readFile, readdir, lstat, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {sha256Text, taggedDigest} from '../src/core/digests.js';
import {acceptStartupPacket} from '../src/handoff/receiver.js';
import {readPacket, readReceipt, writePacket, type HandoffPacketV1} from '../src/handoff/packet.js';

async function fixture(t: {after(fn: () => Promise<void>): void}) {
  const base = join(process.cwd(), '.task-artifacts', 'tmp');
  await mkdir(base, {recursive: true, mode: 0o700});
  const home = await mkdtemp(join(base, 'packet-encoding-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const agentDir = join(home, 'auth'), scaffoldDir = join(home, 'storage'), dir = join(scaffoldDir, 'handoff');
  await mkdir(agentDir, {mode: 0o700});
  await mkdir(scaffoldDir, {mode: 0o700});
  const instructions = '合成の開発指示';
  const packet: HandoffPacketV1 = {
    version: 1, nonce: '1'.repeat(64), workflowId: '11111111-1111-4111-8111-111111111111',
    repo: 'example/demo', epicIssue: 10, sourceStage: 'setup', targetStage: 'specification',
    artifactDigests: {epicBodySha256: 'a'.repeat(64), epicLabelsSha256: 'b'.repeat(64)},
    cwd: '/synthetic/repo', profileId: 'developer', profileInstructionsDigest: sha256Text(instructions),
    accountBinding: taggedDigest('account-binding', {agentDir: await realpath(agentDir), authMode: 'file-backed'}),
    requiredTools: ['synthetic-tool'], resourceRefs: ['MARKER'],
  };
  const written = await writePacket(dir, packet, scaffoldDir);
  const input = {
    packetPath: written.path, agentDir, scaffoldDir, cwd: packet.cwd, sessionId: 'target',
    sessionEntries: [{type: 'custom', customType: 'startup-profile-state', data: {version: 1, id: 'developer', label: 'Developer', instructions}}],
    toolNames: packet.requiredTools,
    policy: {version: 1 as const, repos: {'example/demo': {authMode: 'file-backed' as const, models: []}}},
  };
  return {packet, written, input, dir, scaffoldDir};
}

// Catches nonfatal byte replacement inside an otherwise schema-valid JSON string.
test('receiver refuses invalid UTF-8 inside a packet JSON string without a receipt or file mutation', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from(JSON.stringify(f.packet));
  const marker = bytes.indexOf('MARKER');
  assert.ok(marker >= 0);
  bytes[marker] = 0xff;
  await writeFile(f.written.path, bytes);
  const names = await readdir(f.dir), inode = (await lstat(f.written.path)).ino;
  const accepted = await acceptStartupPacket(f.input);
  assert.equal(accepted.ok, false, 'invalid byte must not be replaced and accepted');
  const read = await readPacket(f.written.path, f.scaffoldDir);
  assert.equal(read.ok, false);
  assert.deepEqual(await readdir(f.dir), names);
  assert.equal((await lstat(f.written.path)).ino, inode);
  assert.deepEqual(await readFile(f.written.path), bytes);
});

// Catches normal UTF-8 rejection or hashing decoded/reserialized content instead of the raw bytes.
test('receiver accepts valid multibyte UTF-8 and retains the raw packet hash in its receipt', async t => {
  const f = await fixture(t), packet = {...f.packet, resourceRefs: ['日本語の根拠/é/😀']};
  const bytes = Buffer.from(' \n' + JSON.stringify(packet) + '\n\t');
  await writeFile(f.written.path, bytes);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const read = await readPacket(f.written.path, f.scaffoldDir);
  assert.ok(read.ok);
  assert.deepEqual(read.value.packet, packet);
  assert.equal(read.value.sha256, hash);
  const accepted = await acceptStartupPacket(f.input);
  assert.ok(accepted.ok);
  assert.equal(accepted.value.packetSha256, hash);
  const ready = await readReceipt(f.dir, 'receiver-ready', f.scaffoldDir);
  assert.ok(ready);
  assert.equal(ready.packetSha256, hash);
  assert.equal(ready.nonceSha256, createHash('sha256').update('1'.repeat(64)).digest('hex'));
});

// Catches decoder BOM stripping that would silently widen the former JSON.parse acceptance boundary.
test('receiver continues rejecting a UTF-8 BOM before packet JSON without writing a receipt', async t => {
  const f = await fixture(t);
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(f.packet))]);
  await writeFile(f.written.path, bytes);
  const names = await readdir(f.dir), inode = (await lstat(f.written.path)).ino;
  const read = await readPacket(f.written.path, f.scaffoldDir);
  assert.ok(!read.ok && read.problems.some(p => p.code === 'PACKET_INVALID'));
  assert.equal((await acceptStartupPacket(f.input)).ok, false);
  assert.deepEqual(await readdir(f.dir), names);
  assert.equal((await lstat(f.written.path)).ino, inode);
  assert.deepEqual(await readFile(f.written.path), bytes);
});
