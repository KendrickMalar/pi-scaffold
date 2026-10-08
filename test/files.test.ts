import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, symlink, chmod, stat, rm, readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readOwnedFile, readOwnedJson, writeOwnedFile, ownedPath, ensureOwnedDir, OwnedFileError} from '../src/core/files.js';
import {LIMITS} from '../src/core/contracts.js';

async function root(t: {after(fn: () => Promise<void>): void}) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-scaffold-files-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const r = join(dir, 'pi-scaffold');
  await ensureOwnedDir(r, r);
  return {dir, r};
}
async function rejectsWith(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof OwnedFileError && e.code === code);
}

test('writes owner-only regular files atomically and reads them back', async t => {
  const {r} = await root(t);
  const path = join(r, 'state', 'a', 'record.json');
  await writeOwnedFile(path, '{"x":1}', {root: r});
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(r, 'state'))).mode & 0o777, 0o700);
  assert.equal((await readOwnedFile(path, {root: r})).toString(), '{"x":1}');
  assert.deepEqual(await readOwnedJson(path, {root: r}), {x: 1});
  await writeOwnedFile(path, '{"x":2}', {root: r});
  assert.deepEqual(await readOwnedJson(path, {root: r}), {x: 2});
});

test('paths outside the owned root are rejected', async t => {
  const {r, dir} = await root(t);
  assert.throws(() => ownedPath(r, '../escape.json'), OwnedFileError);
  assert.throws(() => ownedPath(r, '/etc/passwd'), OwnedFileError);
  assert.throws(() => ownedPath(r, 'a/../../b'), OwnedFileError);
  assert.equal(ownedPath(r, 'a/b.json'), join(r, 'a/b.json'));
  await writeFile(join(dir, 'outside.json'), '{}', {mode: 0o600});
  await rejectsWith(readOwnedFile(join(dir, 'outside.json'), {root: r}), 'OUTSIDE_ROOT');
});

test('symlinked files and directories are rejected', async t => {
  const {r, dir} = await root(t);
  await writeFile(join(dir, 'target.json'), '{}', {mode: 0o600});
  await symlink(join(dir, 'target.json'), join(r, 'link.json'));
  await rejectsWith(readOwnedFile(join(r, 'link.json'), {root: r}), 'SYMLINK');
  await mkdir(join(dir, 'realdir'), {mode: 0o700});
  await writeFile(join(dir, 'realdir', 'f.json'), '{}', {mode: 0o600});
  await symlink(join(dir, 'realdir'), join(r, 'dirlink'));
  await rejectsWith(readOwnedFile(join(r, 'dirlink', 'f.json'), {root: r}), 'SYMLINK');
  await rejectsWith(writeOwnedFile(join(r, 'dirlink', 'g.json'), '{}', {root: r}), 'SYMLINK');
  await rejectsWith(writeOwnedFile(join(r, 'link.json'), '{}', {root: r}), 'SYMLINK');
  assert.equal(await readFile(join(dir, 'target.json'), 'utf8'), '{}');
});

test('FIFOs and directories are not regular files', async t => {
  const {r} = await root(t);
  execFileSync('mkfifo', ['-m', '600', join(r, 'pipe.json')]);
  await rejectsWith(readOwnedFile(join(r, 'pipe.json'), {root: r}), 'NOT_REGULAR');
  await mkdir(join(r, 'dir.json'), {mode: 0o700});
  await rejectsWith(readOwnedFile(join(r, 'dir.json'), {root: r}), 'NOT_REGULAR');
});

test('group/world permissions are rejected', async t => {
  const {r} = await root(t);
  const path = join(r, 'open.json');
  await writeFile(path, '{}', {mode: 0o600}); await chmod(path, 0o644);
  await rejectsWith(readOwnedFile(path, {root: r}), 'INSECURE_MODE');
  await mkdir(join(r, 'wide'), {mode: 0o700}); await chmod(join(r, 'wide'), 0o755);
  await writeFile(join(r, 'wide', 'f.json'), '{}', {mode: 0o600});
  await rejectsWith(readOwnedFile(join(r, 'wide', 'f.json'), {root: r}), 'INSECURE_MODE');
});

test('size limits: exactly the limit is read, one byte more is rejected', async t => {
  const {r} = await root(t);
  const path = join(r, 'big.bin');
  await writeFile(path, Buffer.alloc(LIMITS.artifactBytes), {mode: 0o600});
  assert.equal((await readOwnedFile(path, {root: r})).length, LIMITS.artifactBytes);
  await writeFile(path, Buffer.alloc(LIMITS.artifactBytes + 1), {mode: 0o600});
  await rejectsWith(readOwnedFile(path, {root: r}), 'TOO_LARGE');
  await rejectsWith(writeOwnedFile(path, Buffer.alloc(LIMITS.artifactBytes + 1), {root: r}), 'TOO_LARGE');
  await rejectsWith(readOwnedFile(path, {root: r, maxBytes: 10}), 'TOO_LARGE');
});

test('JSON reads reject invalid UTF-8 and duplicate keys', async t => {
  const {r} = await root(t);
  const path = join(r, 'bad.json');
  await writeFile(path, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]), {mode: 0o600});
  await rejectsWith(readOwnedJson(path, {root: r}), 'INVALID_ENCODING');
  await writeFile(path, '{"a":1,"a":2}', {mode: 0o600});
  await rejectsWith(readOwnedJson(path, {root: r}), 'INVALID_JSON');
});

test('a missing file is reported distinctly', async t => {
  const {r} = await root(t);
  await rejectsWith(readOwnedFile(join(r, 'nope.json'), {root: r}), 'NOT_FOUND');
});
