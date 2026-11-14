import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createGitReader, parseGithubRemote} from '../src/ports/git-read.js';

test('readBlob returns exact bytes, undefined for a missing path, and refuses a blob over the artifact limit', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'deterministic-scaffold-git-'));
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

test('repoIdentity reads the configured origin URL, not the url.<base>.insteadOf rewrite (kec-orb box gitconfig)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'deterministic-scaffold-git-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/Owner/repo.git']);
  // The box's /etc/gitconfig rewrites github.com to the adapter; a repo-level rule reproduces it here.
  execFileSync('git', ['-C', dir, 'config', 'url.http://kec-orb-adapter:8080/github/git/.insteadOf', 'https://github.com/']);
  assert.equal(execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin']).toString().trim(), 'http://kec-orb-adapter:8080/github/git/Owner/repo.git');
  const identity = await createGitReader().repoIdentity(dir);
  assert.equal(identity.origin, 'https://github.com/Owner/repo.git');
  assert.equal(parseGithubRemote(identity.origin), 'Owner/repo');
});

test('repoIdentity returns an empty origin when no origin is configured', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'deterministic-scaffold-git-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  execFileSync('git', ['init', '-q', dir]);
  assert.equal((await createGitReader().repoIdentity(dir)).origin, '');
});
