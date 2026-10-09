import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkFeatureIntegration} from '../src/core/evidence.js';
import {createGitReader} from '../src/ports/git-read.js';
import type {EpicDocV1, EvidenceReportV1, FeatureSnapshot} from '../src/core/contracts.js';
import {populatedDoc, featureDoc} from './helpers/docs.js';

test('refs are checked against a real git history: ancestors pass, unrelated and missing commits do not', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-scaffold-evidence-git-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const env = {...process.env, GIT_AUTHOR_NAME: 'f', GIT_AUTHOR_EMAIL: 'f@example.com', GIT_COMMITTER_NAME: 'f', GIT_COMMITTER_EMAIL: 'f@example.com'};
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], {env}).toString().trim();
  execFileSync('git', ['init', '-q', dir]);
  await writeFile(join(dir, 'a.txt'), 'a'); git('add', '.'); git('commit', '-qm', 'feature');
  const feature = git('rev-parse', 'HEAD');
  await writeFile(join(dir, 'b.txt'), 'b'); git('add', '.'); git('commit', '-qm', 'integration');
  const integration = git('rev-parse', 'HEAD');
  git('checkout', '-q', '--orphan', 'other'); await writeFile(join(dir, 'c.txt'), 'c'); git('add', '.'); git('commit', '-qm', 'unrelated');
  const unrelated = git('rev-parse', 'HEAD');
  const epic: EpicDocV1 = {...populatedDoc(), stage: 'implementation', handoff: null};
  const f: FeatureSnapshot = {repo: 'example/demo', number: 11, title: 'F', body: '', bodySha256: 'a'.repeat(64), labels: [], labelsSha256: 'a'.repeat(64), state: 'open', projectionChecked: true,
    doc: {...featureDoc(), workflowId: epic.workflowId, criteria: [{id: 'AC101', requirementIds: ['REQ001'], verification: 'v', expectedResult: 'e'}]}};
  const report = (productRef: string): EvidenceReportV1 => ({version: 1, workflowId: epic.workflowId, featureIssue: 11, productRef, suiteRef: feature,
    criteria: [{id: 'AC101', status: 'pass', command: 'npm test', exitCode: 0, logPath: 'l.log', logSha256: 'a'.repeat(64)}]});
  const run = (productRef: string, integrationRef = integration) => checkFeatureIntegration({epic, features: [f], reports: [report(productRef)], integrationRef, git: createGitReader(), repoRoot: dir});
  const onIntegration = await run(integration);
  assert.equal(onIntegration.status, 'validated', JSON.stringify(onIntegration.problems)); assert.equal(onIntegration.testedOnIntegration, true);
  const ancestor = await run(feature);
  assert.equal(ancestor.status, 'validated', JSON.stringify(ancestor.problems)); assert.equal(ancestor.testedOnIntegration, false);
  assert.ok((await run(unrelated)).problems.some(p => p.code === 'REF_NOT_INTEGRATED'));
  assert.ok((await run('e'.repeat(40))).problems.some(p => p.code === 'REF_NOT_FOUND'));
  assert.ok((await run(integration, 'e'.repeat(40))).problems.some(p => p.code === 'REF_NOT_FOUND' && p.path === 'integrationRef'));
});
