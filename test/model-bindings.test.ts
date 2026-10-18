import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, chmod, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadOwnerPolicy, checkFeatureBindings, decodeOwnerPolicy, repoAgentApproves, repoPolicyFor, repoQuestionBlockedStages, type OwnerPolicy} from '../src/core/model-bindings.js';
import {featureDoc} from './helpers/docs.js';

const policy: OwnerPolicy = {version: 1, repos: {'example/demo': {authMode: 'file-backed', models: [
  {model: 'example-provider/manager-1', thinking: 'medium', tier: 'basic', roles: ['coding-manager']},
  {model: 'example-provider/coder-1', thinking: 'high', tier: 'basic', roles: ['coder']},
  {model: 'example-provider/tester-1', thinking: 'low', tier: 'basic', roles: ['tester']},
  {model: 'example-provider/big-1', thinking: 'xhigh', tier: 'upper', roles: ['coder']},
]}}};
const available = ['example-provider/manager-1', 'example-provider/coder-1', 'example-provider/tester-1', 'example-provider/big-1'];
const codes = (p: {code: string}[]) => p.map(x => x.code);
const check = (bindings = featureDoc().bindings, extra: Partial<Parameters<typeof checkFeatureBindings>[0]> = {}) =>
  checkFeatureBindings({repo: 'example/demo', bindings, policy, availableModels: available, scopedModels: [], ...extra});

test('bindings inside the owner policy pass', () => { assert.deepEqual(check(), []); });

test('models, thinking levels and roles outside the policy are rejected', () => {
  const b = featureDoc().bindings;
  assert.ok(codes(check({...b, coder: {...b.coder, model: 'example-provider/other'}})).includes('POLICY_MODEL'));
  assert.ok(codes(check({...b, coder: {...b.coder, thinking: 'low'}})).includes('POLICY_MODEL'));
  assert.ok(codes(check({...b, tester: {...b.coder}})).includes('POLICY_ROLE'));
  assert.ok(codes(check(b, {repo: 'example/other'})).includes('POLICY_REPO'));
  assert.ok(codes(check(b, {policy: undefined})).includes('POLICY_MISSING'));
});

test('upper-tier bindings are rejected rather than rewritten to basic', () => {
  const b = featureDoc().bindings;
  const r = check({...b, coder: {model: 'example-provider/big-1', thinking: 'xhigh', reason: '大規模'}});
  assert.ok(codes(r).includes('UPPER_TIER_UNSUPPORTED'));
});

test('unavailable or unscoped models are rejected', () => {
  assert.ok(codes(check(undefined, {availableModels: available.filter(m => m !== 'example-provider/coder-1')})).includes('MODEL_UNAVAILABLE'));
  assert.ok(codes(check(undefined, {scopedModels: ['example-provider/manager-1']})).includes('MODEL_NOT_SCOPED'));
  assert.deepEqual(check(undefined, {scopedModels: available}), []);
});

test('policy schema is strict', () => {
  assert.equal(decodeOwnerPolicy(policy).ok, true);
  for (const bad of [
    {...policy, extra: 1},
    {version: 2, repos: {}},
    {version: 1, repos: {'example/demo': {authMode: 'env', models: []}}},
    {version: 1, repos: {'not a repo': {authMode: 'file-backed', models: []}}},
    {version: 1, repos: {'example/demo': {authMode: 'file-backed', models: [{model: 'x/y', thinking: 'low', tier: 'basic', roles: ['admin']}]}}},
    {version: 1, repos: {'example/demo': {authMode: 'file-backed', models: [{model: 'x/y', thinking: 'low', tier: 'basic', roles: ['coder'], apiKey: 'k'}]}}},
  ]) assert.equal(decodeOwnerPolicy(bad).ok, false, JSON.stringify(bad));
});

test('policy file must be an owner-only regular file; absence is reported as missing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-scaffold-policy-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const agentDir = join(dir, 'agent'); await mkdir(join(agentDir, 'pi-scaffold'), {recursive: true, mode: 0o700});
  assert.deepEqual(await loadOwnerPolicy(agentDir), {ok: true, value: undefined});
  const path = join(agentDir, 'pi-scaffold', 'policy.json');
  await writeFile(path, JSON.stringify(policy), {mode: 0o600});
  const loaded = await loadOwnerPolicy(agentDir);
  assert.ok(loaded.ok && loaded.value?.repos['example/demo']);
  await chmod(path, 0o644);
  const open = await loadOwnerPolicy(agentDir);
  assert.ok(!open.ok && open.problems[0]!.code === 'INSECURE_MODE');
});

const ownerWide: OwnerPolicy = {version: 1, repos: {'example/*': {authMode: 'file-backed', models: policy.repos['example/demo']!.models}}};

test('an OWNER/* entry covers every repository of exactly that owner', () => {
  assert.deepEqual(checkFeatureBindings({repo: 'example/new-repo', bindings: featureDoc().bindings, policy: ownerWide, availableModels: available, scopedModels: []}), []);
  assert.ok(repoPolicyFor(ownerWide, 'Example/demo'));
  assert.equal(repoPolicyFor(ownerWide, 'example-other/demo'), undefined);
  assert.equal(repoPolicyFor(ownerWide, 'other/example'), undefined);
  assert.ok(codes(checkFeatureBindings({repo: 'other/demo', bindings: featureDoc().bindings, policy: ownerWide, availableModels: available, scopedModels: []})).includes('POLICY_REPO'));
});

test('an exact OWNER/REPO entry takes precedence over OWNER/*', () => {
  const both: OwnerPolicy = {version: 1, repos: {...ownerWide.repos, 'example/demo': {authMode: 'file-backed', models: []}}};
  assert.deepEqual(repoPolicyFor(both, 'example/demo')!.models, []);
  assert.equal(repoPolicyFor(both, 'example/other')!.models.length, 4);
  assert.ok(codes(checkFeatureBindings({repo: 'example/demo', bindings: featureDoc().bindings, policy: both, availableModels: available, scopedModels: []})).includes('POLICY_MODEL'));
});

test('only a whole-repository * after an exact owner is accepted in policy keys', () => {
  const entry = {authMode: 'file-backed', models: []};
  assert.ok(decodeOwnerPolicy({version: 1, repos: {'example/*': entry}}).ok);
  for (const key of ['*', '*/*', '*/demo', 'ex*/*', 'example/de*', 'example/**', 'example/*/x', '/*', 'example/'])
    assert.ok(!decodeOwnerPolicy({version: 1, repos: {[key]: entry}}).ok, key);
});

test('agentDecisionStages: optional, only implementation/verification, strictly decoded', () => {
  const entry = (extra: Record<string, unknown>) => ({version: 1, repos: {'example/demo': {authMode: 'file-backed', models: [], ...extra}}});
  const absent = decodeOwnerPolicy(entry({}));
  assert.ok(absent.ok);
  assert.deepEqual(repoPolicyFor(absent.value, 'example/demo')?.agentDecisionStages ?? [], [], 'absent means none');
  for (const stages of [[], ['implementation'], ['verification'], ['implementation', 'verification']]) {
    const r = decodeOwnerPolicy(entry({agentDecisionStages: stages}));
    assert.ok(r.ok, JSON.stringify(stages));
    assert.deepEqual(r.value.repos['example/demo']!.agentDecisionStages, stages);
  }
  for (const bad of [['specification'], ['basic-design'], ['setup'], ['completed'], ['Implementation'], ['implementation', 'implementation'], [1], [null], 'implementation', null, {implementation: true}]) {
    const r = decodeOwnerPolicy(entry({agentDecisionStages: bad}));
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(!r.ok && r.problems.every(p => p.path.startsWith('repos.example/demo.agentDecisionStages')), JSON.stringify(!r.ok && r.problems));
  }
});

test('agentApprovals and questionBlockedStages: optional, strictly decoded, beside the old agentDecisionStages', () => {
  const entry = (extra: Record<string, unknown>) => ({version: 1, repos: {'example/demo': {authMode: 'file-backed', models: [], ...extra}}});
  const kinds = ['specification', 'implementation-start', 'epic-completion', 'handoff-abandon', 'specification-revision'];
  const stages = ['setup', 'basic-design', 'implementation', 'verification'];
  const full = decodeOwnerPolicy(entry({agentApprovals: kinds, questionBlockedStages: stages}));
  assert.ok(full.ok, JSON.stringify(!full.ok && full.problems));
  assert.deepEqual(full.value.repos['example/demo']!.agentApprovals, kinds);
  assert.deepEqual(full.value.repos['example/demo']!.questionBlockedStages, stages);
  for (const k of kinds) assert.equal(repoAgentApproves(full.value, 'example/demo', k as never), true, k);
  assert.deepEqual(repoQuestionBlockedStages(full.value, 'example/demo'), stages);
  const none = decodeOwnerPolicy(entry({}));
  assert.ok(none.ok);
  assert.equal(repoAgentApproves(none.value, 'example/demo', 'specification'), false, 'absent means none');
  assert.deepEqual(repoQuestionBlockedStages(none.value, 'example/demo'), []);
  assert.equal(repoAgentApproves(undefined, 'example/demo', 'specification'), false, 'no policy');
  // The old field still counts for question blocking; it never turns on policy approvals by kind.
  const old = decodeOwnerPolicy(entry({agentDecisionStages: ['implementation', 'verification']}));
  assert.ok(old.ok);
  assert.deepEqual(repoQuestionBlockedStages(old.value, 'example/demo'), ['implementation', 'verification']);
  assert.equal(repoAgentApproves(old.value, 'example/demo', 'epic-completion'), false);
  const both = decodeOwnerPolicy(entry({agentDecisionStages: ['verification'], questionBlockedStages: ['basic-design', 'verification']}));
  assert.ok(both.ok);
  assert.deepEqual(repoQuestionBlockedStages(both.value, 'example/demo'), ['basic-design', 'verification'], 'union without duplicates');
  for (const [key, bad] of [['agentApprovals', ['approve-all']], ['agentApprovals', ['specification', 'specification']], ['agentApprovals', 'specification'],
    ['questionBlockedStages', ['specification']], ['questionBlockedStages', ['completed']], ['questionBlockedStages', ['setup', 'setup']], ['questionBlockedStages', null]] as const) {
    const r = decodeOwnerPolicy(entry({[key]: bad}));
    assert.equal(r.ok, false, `${key} ${JSON.stringify(bad)}`);
    assert.ok(!r.ok && r.problems.every(p => p.path.startsWith(`repos.example/demo.${key}`)), JSON.stringify(!r.ok && r.problems));
  }
});
