import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness, loadToolModule} from './helpers/harness.js';
import {FakePiGh} from './helpers/fake-pi-gh.js';
import {renderEpicBlock} from '../src/core/epic-render.js';
import {populatedDoc} from './helpers/docs.js';

const READ = ['gh_capabilities', 'gh_issue_get', 'scaffold_waves_verify', 'scaffold_stage_check'];
const WRITE = ['scaffold_feature_create', 'scaffold_dependencies_apply', 'scaffold_waves_apply', 'scaffold_handoff_implementation'];

async function run(tools: string[]) {
  const d = populatedDoc(); d.stage = 'basic-design';
  const gh = new FakePiGh(); gh.add({number: 10, title: 'Epic', body: renderEpicBlock(d), labels: ['Type: Scaffold', 'Scope: Epic', 'Stage: BasicDesign'], state: 'open'});
  const {createTool} = await loadToolModule('extensions/tools/stage-check.ts');
  const h = await createHarness(createTool, {scenario: {gh, tools}});
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
