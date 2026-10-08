import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, chmod, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadOwnerPolicy, checkFeatureBindings, decodeOwnerPolicy, type OwnerPolicy} from '../src/core/model-bindings.js';
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
