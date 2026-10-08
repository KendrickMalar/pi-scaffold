import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ApprovalStore, approvalViewDigest, type ApprovalUi} from '../src/core/approvals.js';
import type {RepoContext} from '../src/core/contracts.js';
import {makeScope} from './helpers/scope.js';
import {WORKFLOW_ID, SHA_A, SHA_B} from './helpers/docs.js';

async function setup(t: {after(fn: () => Promise<void>): void}) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-scaffold-approvals-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const root = join(dir, 'pi-scaffold');
  const context: RepoContext = {repo: 'example/demo', repoRoot: '/synthetic/repo', gitCommonDir: '/synthetic/repo/.git', workflowStateRoot: join(root, 'state', 'r', WORKFLOW_ID), accountBinding: SHA_A, profileId: 'developer', profileInstructionsDigest: SHA_B};
  return {store: new ApprovalStore(root), context};
}
function ui(answer: boolean | (() => boolean)) {
  const shown: {title: string; message: string}[] = [];
  const value: ApprovalUi = {interactive: true, confirm: async (title, message) => { shown.push({title, message}); return typeof answer === 'function' ? answer() : answer; }};
  return {ui: value, shown};
}
const view = (digest = SHA_A) => ({contentDigest: digest, text: '仕様の全文（架空）'});

test('the parent TUI confirmation records an approval bound to the shown content', async t => {
  const {store, context} = await setup(t);
  const {ui: u, shown} = ui(true);
  const r = await store.confirmContent('specification', WORKFLOW_ID, view(), context, u, makeScope());
  assert.equal(r.status, 'validated');
  assert.equal(shown.length, 1);
  assert.ok(shown[0]!.message.includes('仕様の全文（架空）'));
  assert.ok(shown[0]!.message.includes(approvalViewDigest('specification', view())));
  const ref = await store.requireContentApproval('specification', WORKFLOW_ID, approvalViewDigest('specification', view()), context);
  assert.ok(ref.ok);
  assert.deepEqual(Object.keys(ref.value).sort(), ['accountBinding', 'kind', 'repo', 'viewDigest', 'workflowId']);
});

test('declining or cancelling records nothing', async t => {
  const {store, context} = await setup(t);
  const r = await store.confirmContent('specification', WORKFLOW_ID, view(), context, ui(false).ui, makeScope());
  assert.equal(r.status, 'cancelled');
  assert.equal((await store.requireContentApproval('specification', WORKFLOW_ID, approvalViewDigest('specification', view()), context)).ok, false);
});

test('headless or child contexts cannot create approvals but can reference existing ones', async t => {
  const {store, context} = await setup(t);
  const shown: string[] = [];
  const headless: ApprovalUi = {interactive: false, confirm: async m => { shown.push(m); return true; }};
  const r = await store.confirmContent('implementation-start', WORKFLOW_ID, view(), context, headless, makeScope());
  assert.equal(r.status, 'blocked');
  assert.ok(r.problems.some(p => p.code === 'APPROVAL_UI_REQUIRED'));
  assert.equal(shown.length, 0);
  await store.confirmContent('implementation-start', WORKFLOW_ID, view(), context, ui(true).ui, makeScope());
  assert.equal((await store.requireContentApproval('implementation-start', WORKFLOW_ID, approvalViewDigest('implementation-start', view()), context)).ok, true);
});

test('content changes, other kinds, accounts and profiles invalidate reuse', async t => {
  const {store, context} = await setup(t);
  await store.confirmContent('specification', WORKFLOW_ID, view(SHA_A), context, ui(true).ui, makeScope());
  const digest = approvalViewDigest('specification', view(SHA_A));
  const missing = await store.requireContentApproval('specification', WORKFLOW_ID, approvalViewDigest('specification', view(SHA_B)), context);
  assert.ok(!missing.ok && missing.problems[0]!.code === 'APPROVAL_MISSING');
  assert.equal((await store.requireContentApproval('epic-completion', WORKFLOW_ID, digest, context)).ok, false);
  assert.equal((await store.requireContentApproval('specification', WORKFLOW_ID, digest, {...context, accountBinding: SHA_B})).ok, false);
  assert.equal((await store.requireContentApproval('specification', WORKFLOW_ID, digest, {...context, profileId: 'other'})).ok, false);
  assert.equal((await store.requireContentApproval('specification', WORKFLOW_ID, digest, {...context, profileInstructionsDigest: SHA_A})).ok, false);
  assert.equal((await store.requireContentApproval('specification', '88888888-8888-4888-8888-888888888888', digest, context)).ok, false);
});

test('a session switch during the dialog cancels without recording', async t => {
  const {store, context} = await setup(t);
  const scope = makeScope();
  const r = await store.confirmContent('specification', WORKFLOW_ID, view(), context, ui(() => { scope.expire(); return true; }).ui, scope);
  assert.equal(r.status, 'cancelled');
  assert.equal((await store.requireContentApproval('specification', WORKFLOW_ID, approvalViewDigest('specification', view()), context)).ok, false);
});

test('approvals need a bound account and profile', async t => {
  const {store, context} = await setup(t);
  for (const missing of [{accountBinding: null}, {profileId: null}, {profileInstructionsDigest: null}]) {
    const r = await store.confirmContent('specification', WORKFLOW_ID, view(), {...context, ...missing}, ui(true).ui, makeScope());
    assert.equal(r.status, 'blocked', JSON.stringify(missing));
  }
});
