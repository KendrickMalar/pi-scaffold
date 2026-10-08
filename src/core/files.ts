// Owner-only private files under a namespace root. Defends against symlink/FIFO/permission mistakes by the
// same OS user's tooling; it is not a sandbox against an attacker with arbitrary shell or file access.
import {constants} from 'node:fs';
import {lstat, mkdir, open, rename, unlink, type FileHandle} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LIMITS} from './contracts.js';
import {parseStrictJson} from './body-codec.js';

export class OwnedFileError extends Error {
  constructor(readonly code: 'OUTSIDE_ROOT' | 'SYMLINK' | 'NOT_REGULAR' | 'NOT_DIRECTORY' | 'NOT_OWNER' | 'INSECURE_MODE' | 'TOO_LARGE' | 'CHANGED' | 'NOT_FOUND' | 'INVALID_ENCODING' | 'INVALID_JSON', readonly path: string, message: string) {
    super(message);
  }
}
export interface OwnedOptions { root: string; maxBytes?: number }

const uid = () => process.getuid?.() ?? -1;
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'));
}
/** Resolves `rel` inside `root`; absolute paths or traversal are rejected. */
export function ownedPath(root: string, rel: string): string {
  if (typeof rel !== 'string' || !rel || isAbsolute(rel) || rel.includes('\0') || rel.split(/[\\/]/).includes('..')) throw new OwnedFileError('OUTSIDE_ROOT', String(rel), 'Path must be relative and stay inside the owned root.');
  const path = resolve(root, rel);
  if (!inside(resolve(root), path) || path === resolve(root)) throw new OwnedFileError('OUTSIDE_ROOT', rel, 'Path escapes the owned root.');
  return path;
}

async function lstatOrUndefined(path: string) {
  try { return await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
}
function checkOwnerMode(path: string, st: {uid: number; mode: number}) {
  if (uid() >= 0 && st.uid !== uid()) throw new OwnedFileError('NOT_OWNER', path, 'Not owned by the current user.');
  if (st.mode & 0o077) throw new OwnedFileError('INSECURE_MODE', path, 'Group/other permissions must be cleared.');
}
/** Verifies root and every directory from root to `dir` (inclusive) is a real owner-only directory. */
async function verifyDirs(root: string, dir: string, create: boolean) {
  const r = resolve(root), d = resolve(dir);
  if (!inside(r, d)) throw new OwnedFileError('OUTSIDE_ROOT', dir, 'Directory is outside the owned root.');
  const parts = relative(r, d).split(sep).filter(Boolean);
  let current = r;
  for (const part of [null, ...parts]) {
    if (part !== null) current = join(current, part);
    let st = await lstatOrUndefined(current);
    if (!st && create) { try { await mkdir(current, {mode: 0o700}); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } st = await lstat(current); }
    if (!st) throw new OwnedFileError('NOT_FOUND', current, 'Directory does not exist.');
    if (st.isSymbolicLink()) throw new OwnedFileError('SYMLINK', current, 'Symbolic links are not followed.');
    if (!st.isDirectory()) throw new OwnedFileError('NOT_DIRECTORY', current, 'Expected a directory.');
    checkOwnerMode(current, st);
  }
}
export async function ensureOwnedDir(dir: string, root: string): Promise<void> { await verifyDirs(root, dir, true); }

export async function readOwnedFile(path: string, options: OwnedOptions): Promise<Buffer> {
  const max = options.maxBytes ?? LIMITS.artifactBytes;
  const p = resolve(path);
  if (!inside(resolve(options.root), p) || p === resolve(options.root)) throw new OwnedFileError('OUTSIDE_ROOT', path, 'File is outside the owned root.');
  await verifyDirs(options.root, dirname(p), false);
  const st = await lstatOrUndefined(p);
  if (!st) throw new OwnedFileError('NOT_FOUND', path, 'File does not exist.');
  if (st.isSymbolicLink()) throw new OwnedFileError('SYMLINK', path, 'Symbolic links are not followed.');
  if (!st.isFile()) throw new OwnedFileError('NOT_REGULAR', path, 'Expected a regular file.');
  checkOwnerMode(path, st);
  if (st.size > max) throw new OwnedFileError('TOO_LARGE', path, `File exceeds ${max} bytes.`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const fst = await handle.stat();
    if (fst.ino !== st.ino || fst.dev !== st.dev || !fst.isFile()) throw new OwnedFileError('CHANGED', path, 'File changed while opening.');
    const buffer = Buffer.alloc(Math.min(max, fst.size) + 1);
    let total = 0;
    for (;;) { const {bytesRead} = await handle.read(buffer, total, buffer.length - total, total); if (!bytesRead) break; total += bytesRead; if (total > max) throw new OwnedFileError('TOO_LARGE', path, `File exceeds ${max} bytes.`); if (total === buffer.length) break; }
    if (total !== fst.size) throw new OwnedFileError('CHANGED', path, 'File changed while reading.');
    return buffer.subarray(0, total);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ELOOP') throw new OwnedFileError('SYMLINK', path, 'Symbolic links are not followed.');
    throw e;
  } finally { await handle?.close(); }
}

const UTF8 = new TextDecoder('utf-8', {fatal: true});
export async function readOwnedJson(path: string, options: OwnedOptions): Promise<unknown> {
  const bytes = await readOwnedFile(path, options);
  let text: string;
  try { text = UTF8.decode(bytes); } catch { throw new OwnedFileError('INVALID_ENCODING', path, 'File is not valid UTF-8.'); }
  try { return parseStrictJson(text); } catch (e) { throw new OwnedFileError('INVALID_JSON', path, (e as Error).message); }
}

/** Atomically replaces `path` with an owner-only (0600) regular file. */
export async function writeOwnedFile(path: string, data: string | Uint8Array, options: OwnedOptions): Promise<void> {
  const max = options.maxBytes ?? LIMITS.artifactBytes;
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  const p = resolve(path);
  if (bytes.length > max) throw new OwnedFileError('TOO_LARGE', path, `Data exceeds ${max} bytes.`);
  if (!inside(resolve(options.root), p) || p === resolve(options.root)) throw new OwnedFileError('OUTSIDE_ROOT', path, 'File is outside the owned root.');
  await verifyDirs(options.root, dirname(p), true);
  const existing = await lstatOrUndefined(p);
  if (existing?.isSymbolicLink()) throw new OwnedFileError('SYMLINK', path, 'Refusing to replace a symbolic link.');
  if (existing && !existing.isFile()) throw new OwnedFileError('NOT_REGULAR', path, 'Refusing to replace a non-regular file.');
  const temp = join(dirname(p), `.${randomUUID()}.tmp`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temp, p); } catch (e) { await unlink(temp).catch(() => undefined); throw e; }
}
