import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deriveRepoContext, resolveAgentDir, readProfileSnapshot} from '../src/core/repo-context.js';
import {createGitReader, parseGithubRemote, type GitReader} from '../src/ports/git-read.js';
import {sha256Text} from '../src/core/digests.js';
import type {OwnerPolicy} from '../src/core/model-bindings.js';
import {WORKFLOW_ID} from './helpers/docs.js';

const policy: OwnerPolicy = {version: 1, repos: {'example/demo': {authMode: 'file-backed', models: []}}};
const profileEntry = (id = 'developer', instructions = '開発用の指示（架空）') => ({type: 'custom', customType: 'startup-profile-state', data: {version: 1, id, label: 'Development', instructions}});
function fakeGit(origin = 'git@github.com:example/demo.git'): GitReader {
  return {repoIdentity: async () => ({repoRoot: '/synthetic/repo', gitCommonDir: '/synthetic/repo/.git', origin})} as unknown as GitReader;
}
const base = (over: Partial<Parameters<typeof deriveRepoContext>[0]> = {}) => ({
  cwd: '/synthetic/repo/sub', repo: 'example/demo', workflowId: WORKFLOW_ID, trusted: true, agentDir: '/synthetic/agent',
  agentDirRealpath: '/synthetic/agent', sessionEntries: [profileEntry()], policy, git: fakeGit(), ...over,
});

test('derives the context from trust, origin, profile snapshot and policy', async () => {
  const r = await deriveRepoContext(base());
  assert.ok(r.ok, JSON.stringify(r.ok ? [] : r.problems));
  assert.equal(r.value.repoRoot, '/synthetic/repo');
  assert.equal(r.value.profileId, 'developer');
  assert.equal(r.value.profileInstructionsDigest, sha256Text('開発用の指示（架空）'));
  assert.match(r.value.accountBinding!, /^[0-9a-f]{64}$/);
  assert.ok(r.value.workflowStateRoot.startsWith('/synthetic/agent/pi-scaffold/state/'));
  assert.ok(r.value.workflowStateRoot.endsWith('/' + WORKFLOW_ID));
});

test('untrusted projects and foreign origins are blocked', async () => {
  const untrusted = await deriveRepoContext(base({trusted: false}));
  assert.ok(!untrusted.ok && untrusted.problems[0]!.code === 'UNTRUSTED_PROJECT');
  const foreign = await deriveRepoContext(base({git: fakeGit('https://github.com/other/demo.git')}));
  assert.ok(!foreign.ok && foreign.problems[0]!.code === 'ORIGIN_MISMATCH');
  const none = await deriveRepoContext(base({git: fakeGit('')}));
  assert.ok(!none.ok && none.problems[0]!.code === 'ORIGIN_MISMATCH');
});

test('missing profile or non file-backed auth leave bindings unset; a conflicting profile snapshot blocks', async () => {
  const noProfile = await deriveRepoContext(base({sessionEntries: []}));
  assert.ok(noProfile.ok && noProfile.value.profileId === null && noProfile.value.profileInstructionsDigest === null);
  const noPolicy = await deriveRepoContext(base({policy: undefined}));
  assert.ok(noPolicy.ok && noPolicy.value.accountBinding === null);
  const conflicting = await deriveRepoContext(base({sessionEntries: [profileEntry(), profileEntry('reviewer')]}));
  assert.ok(!conflicting.ok && conflicting.problems[0]!.code === 'PROFILE_INVALID');
  assert.equal(readProfileSnapshot([{type: 'custom', customType: 'startup-profile-state', data: {version: 1, id: 'Bad Id', label: 'x', instructions: ''}}]).invalid, true);
});

test('account binding changes with the agent directory', async () => {
  const a = await deriveRepoContext(base());
  const b = await deriveRepoContext(base({agentDirRealpath: '/synthetic/other-agent'}));
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.value.accountBinding, b.value.accountBinding);
});

test('agent dir comes from PI_CODING_AGENT_DIR or the default, never from tool input', () => {
  assert.equal(resolveAgentDir({PI_CODING_AGENT_DIR: '/x/agent'}, '/home/u'), '/x/agent');
  assert.equal(resolveAgentDir({}, '/home/u'), '/home/u/.pi/agent');
  assert.equal(resolveAgentDir({PI_CODING_AGENT_DIR: 'relative'}, '/home/u'), '/home/u/.pi/agent');
});

test('GitHub remotes parse in https, scp and ssh forms only for github.com', () => {
  for (const url of ['https://github.com/example/demo.git', 'https://github.com/example/demo', 'git@github.com:example/demo.git', 'ssh://git@github.com/example/demo.git'])
    assert.equal(parseGithubRemote(url), 'example/demo', url);
  for (const url of ['https://gitlab.com/example/demo.git', 'https://github.com.evil.test/example/demo', 'file:///tmp/demo', ''])
    assert.equal(parseGithubRemote(url), undefined, url);
});

test('the git reader reads a real worktree with fixed argv only', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pi-scaffold-git-')));
  t.after(() => rm(dir, {recursive: true, force: true}));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/example/demo.git']);
  const git = createGitReader();
  const id = await git.repoIdentity(join(dir));
  assert.equal(id.repoRoot, dir);
  assert.equal(id.gitCommonDir, join(dir, '.git'));
  assert.equal(id.origin, 'https://github.com/example/demo.git');
  await assert.rejects(git.run(['push'], dir), /not allowed/);
  await assert.rejects(git.run(['fetch'], dir), /not allowed/);
});

test('workflowId must be a UUID before it becomes a state path', async () => {
  const r = await deriveRepoContext(base({workflowId: '../aaaa/11111111-1111-4111-8111-111111111111'}));
  assert.ok(!r.ok && r.problems[0]!.code === 'INVALID_FORMAT');
});
