import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkCompletion, readRemoteDefault} from '../src/core/completion-gate.js';
import {createGitReader} from '../src/ports/git-read.js';
import type {EpicDocV1, EvidenceReportV1, FeatureSnapshot} from '../src/core/contracts.js';
import {populatedDoc, featureDoc} from './helpers/docs.js';

test('real git: origin\'s default branch is read with ls-remote; containment, local presence and fetch-needed are judged without fetching', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-scaffold-completion-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const env = {...process.env, GIT_AUTHOR_NAME: 'f', GIT_AUTHOR_EMAIL: 'f@example.com', GIT_COMMITTER_NAME: 'f', GIT_COMMITTER_EMAIL: 'f@example.com'};
  const origin = join(dir, 'origin.git'), work = join(dir, 'work'), other = join(dir, 'other');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=trunk', origin]);
  execFileSync('git', ['clone', '-q', origin, work], {env, stdio: 'ignore'});
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], {env}).toString().trim();
  await writeFile(join(work, 'a.txt'), 'a'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'verified');
  const verified = git(work, 'rev-parse', 'HEAD');
  await writeFile(join(work, 'b.txt'), 'b'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'later');
  git(work, 'push', '-q', 'origin', 'HEAD:trunk');
  const main = git(work, 'rev-parse', 'HEAD');
  const reader = createGitReader();
  assert.deepEqual(await readRemoteDefault(reader, work), {branch: 'trunk', sha: main});

  const epic: EpicDocV1 = {...populatedDoc(), stage: 'verification', handoff: null,
    questions: populatedDoc().questions.map(q => ({...q, answer: q.answer ?? '回答', sourceRef: q.sourceRef ?? 'h'})),
    research: populatedDoc().research.map(r => ({...r, state: 'resolved' as const, claim: null, conclusion: r.conclusion ?? '結論', evidenceRefs: r.evidenceRefs.length ? r.evidenceRefs : ['https://example.com/e']}))};
  const f: FeatureSnapshot = {repo: 'example/demo', number: 11, title: 'F', body: '', bodySha256: 'a'.repeat(64), labels: [], labelsSha256: 'a'.repeat(64), state: 'open', projectionChecked: true,
    doc: {...featureDoc(), workflowId: epic.workflowId, criteria: [{id: 'AC101', requirementIds: ['REQ001', 'REQ002'], verification: 'v', expectedResult: 'e'}]}};
  const report: EvidenceReportV1 = {version: 1, workflowId: epic.workflowId, featureIssue: 11, productRef: verified, suiteRef: verified, criteria: [{id: 'AC101', status: 'pass', command: 't', exitCode: 0, logPath: 'l', logSha256: 'a'.repeat(64)}]};
  const run = (verifiedRef: string, cwd = work) => checkCompletion({epic, features: [f], reports: [{...report, productRef: verifiedRef, suiteRef: verifiedRef}], verifiedRef, git: reader, repoRoot: cwd});

  const ok = await run(verified);
  assert.equal(ok.status, 'validated', JSON.stringify(ok.problems));
  assert.deepEqual([ok.remoteMainRef, ok.defaultBranch], [main, 'trunk']);
  // A commit only in this clone (not pushed) is not contained in the default branch.
  git(work, 'checkout', '-q', '-b', 'side', verified); await writeFile(join(work, 'c.txt'), 'c'); git(work, 'add', '.'); git(work, 'commit', '-qm', 'side');
  const side = git(work, 'rev-parse', 'HEAD');
  assert.ok((await run(side)).problems.some(p => p.code === 'NOT_IN_DEFAULT_BRANCH'));
  // origin moved on but this clone has not fetched: stop and ask for a fetch.
  execFileSync('git', ['clone', '-q', origin, other], {env, stdio: 'ignore'});
  await writeFile(join(other, 'd.txt'), 'd'); git(other, 'add', '.'); git(other, 'commit', '-qm', 'remote only'); git(other, 'push', '-q', 'origin', 'HEAD:trunk');
  const notLocal = await run(verified);
  assert.ok(notLocal.problems.some(p => p.code === 'REMOTE_REF_NOT_LOCAL' && /git fetch origin/.test(p.message)), JSON.stringify(notLocal.problems));
  assert.equal(git(work, 'rev-parse', 'origin/trunk'), main, 'nothing was fetched');
});
