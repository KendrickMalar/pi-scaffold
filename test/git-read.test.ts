import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createGitReader} from '../src/ports/git-read.js';

test('readBlob returns exact bytes, undefined for a missing path, and refuses a blob over the artifact limit', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-scaffold-git-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const env = {...process.env, GIT_AUTHOR_NAME: 'f', GIT_AUTHOR_EMAIL: 'f@example.com', GIT_COMMITTER_NAME: 'f', GIT_COMMITTER_EMAIL: 'f@example.com'};
  execFileSync('git', ['init', '-q', dir]);
  const small = Buffer.from([0xe3, 0x81, 0x82, 0x00, 0xff]);
  await writeFile(join(dir, 'small.bin'), small);
  await writeFile(join(dir, 'big.md'), Buffer.alloc(1024 * 1024 + 10, 0x61));
  execFileSync('git', ['-C', dir, 'add', '.'], {env}); execFileSync('git', ['-C', dir, 'commit', '-qm', 'x'], {env});
  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim();
  const git = createGitReader();
  const bytes = await git.readBlob(head, 'small.bin', dir);
  assert.equal(createHash('sha256').update(bytes!).digest('hex'), createHash('sha256').update(small).digest('hex'));
  assert.equal(await git.readBlob(head, 'none.md', dir), undefined);
  await assert.rejects(git.readBlob(head, 'big.md', dir), /TOO_LARGE/);
});
