import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness, loadToolModule} from './helpers/harness.js';
import {FakePiGh} from './helpers/fake-pi-gh.js';
import {renderEpicBlock, renderFeatureBlock} from '../src/core/epic-render.js';
import {populatedDoc, featureDoc} from './helpers/docs.js';

// Plan mode keeps only the gh reads.
const READ = ['gh_capabilities', 'gh_issue_get'];
const WRITE = ['scaffold_feature_create', 'scaffold_dependencies_apply', 'scaffold_waves_apply', 'scaffold_handoff_implementation'];

async function run(tools: string[], opts: {activeTools?: string[]; pin?: boolean; feature?: boolean} = {}) {
  const d = populatedDoc(); d.stage = 'basic-design';
  if (opts.pin) d.originalRequest.sourceRefs = [`docs/missing.md@sha256:${'a'.repeat(64)}`];
  const gh = new FakePiGh(); gh.add({number: 10, title: 'Epic', body: renderEpicBlock(d), labels: ['Type: Scaffold', 'Scope: Epic', 'Stage: BasicDesign'], state: 'open'});
  if (opts.feature) gh.add({number: 10, title: 'Feature', body: renderFeatureBlock(featureDoc()), labels: ['Type: Scaffold', 'Scope: Feature'], state: 'open'});
  const {createTool} = await loadToolModule('extensions/tools/stage-check.ts');
  const h = await createHarness(createTool, {scenario: {gh, tools, ...(opts.activeTools ? {activeTools: opts.activeTools} : {})}});
  return (await h.invoke({repo: 'example/demo', epicIssue: 10})).r;
}

test('passes with read tools present even when plan mode removed write tools', async () => {
  const r = await run(READ);
  assert.equal(r.status, 'validated');
  assert.deepEqual((r.data as {missingStageTools: string[]}).missingStageTools, WRITE);
});

test('fails naming the missing read tool (the gh_issue_get-under-plan-mode case)', async () => {
  const r = await run(READ.filter(t => t !== 'gh_issue_get'));
  assert.equal(r.status, 'blocked');
  assert.deepEqual((r.data as {missingReadTools: string[]}).missingReadTools, ['gh_issue_get']);
});

test('runtime.activeToolNames (production path) wins over ctx.tools', async () => {
  const r = await run([...READ, ...WRITE], {activeTools: READ.filter(t => t !== 'gh_issue_get')});
  assert.equal(r.status, 'blocked');
  assert.deepEqual((r.data as {missingReadTools: string[]}).missingReadTools, ['gh_issue_get']);
});

test('a pinned doc missing in cwd blocks and names the path', async () => {
  const r = await run(READ, {pin: true});
  const data = r.data as {passed: boolean; docProblems: {path: string}[]};
  assert.equal(r.status, 'blocked');
  assert.equal(data.passed, false);
  assert.ok(data.docProblems.some(p => p.path.includes('docs/missing.md')), JSON.stringify(data.docProblems));
});

test('a non-Epic issue is blocked as NOT_AN_EPIC', async () => {
  const r = await run(READ, {feature: true});
  assert.equal(r.status, 'blocked');
  assert.ok(r.problems.some(p => p.code === 'NOT_AN_EPIC'), JSON.stringify(r.problems));
});
