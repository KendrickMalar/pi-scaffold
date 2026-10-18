import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
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
  return {store: new ApprovalStore(root), context, root};
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

// ---- agent decision stages ------------------------------------------------------------------------

const recordPath = (context: RepoContext, kind: string, digest: string) => join(context.workflowStateRoot, 'approvals', kind, `${digest}.json`);

test('in an agent-decision stage the parent records the approval itself: no dialog, also headless', async t => {
  const {store, context} = await setup(t);
  for (const [kind, stage] of [['epic-completion', 'verification'], ['implementation-start', 'implementation']] as const) {
    let asked = 0;
    const headless: ApprovalUi = {interactive: false, confirm: async () => { asked++; return false; }};
    const r = await store.confirmContent(kind, WORKFLOW_ID, view(), context, headless, makeScope(), {agentStage: stage});
    assert.equal(r.status, 'validated', JSON.stringify(r.problems));
    assert.equal(asked, 0, 'the human is not asked');
    assert.equal(r.data?.approvedBy, 'agent');
    assert.equal(r.data?.stage, stage);
    const digest = approvalViewDigest(kind, view());
    const record = JSON.parse(await readFile(recordPath(context, kind, digest), 'utf8')) as {approvedBy: string; stage: string; sessionId: string};
    assert.deepEqual([record.approvedBy, record.stage, record.sessionId], ['agent', stage, 'session-test']);
    const ref = await store.requireContentApproval(kind, WORKFLOW_ID, digest, context);
    assert.ok(ref.ok);
    assert.deepEqual([ref.value.approvedBy, ref.value.stage], ['agent', stage]);
  }
});

test('a child session never records an approval, not even in an agent-decision stage', async t => {
  const {store, context} = await setup(t);
  const child: ApprovalUi = {interactive: false, child: true, confirm: async () => true};
  const r = await store.confirmContent('epic-completion', WORKFLOW_ID, view(), context, child, makeScope(), {agentStage: 'verification'});
  assert.equal(r.status, 'blocked');
  assert.ok(r.problems.some(p => p.code === 'APPROVAL_UI_REQUIRED'));
  assert.equal((await store.requireContentApproval('epic-completion', WORKFLOW_ID, approvalViewDigest('epic-completion', view()), context)).ok, false);
});

test('an agent approval still needs the bound account/profile and a current session', async t => {
  const {store, context} = await setup(t);
  const u: ApprovalUi = {interactive: false, confirm: async () => true};
  assert.equal((await store.confirmContent('epic-completion', WORKFLOW_ID, view(), {...context, accountBinding: null}, u, makeScope(), {agentStage: 'verification'})).status, 'blocked');
  const scope = makeScope(); scope.expire();
  assert.equal((await store.confirmContent('epic-completion', WORKFLOW_ID, view(), context, u, scope, {agentStage: 'verification'})).status, 'cancelled');
  assert.equal((await store.requireContentApproval('epic-completion', WORKFLOW_ID, approvalViewDigest('epic-completion', view()), context)).ok, false);
});

test('without an agent stage the dialog is used exactly as before', async t => {
  const {store, context} = await setup(t);
  const {ui: u, shown} = ui(true);
  const r = await store.confirmContent('epic-completion', WORKFLOW_ID, view(), context, u, makeScope());
  assert.equal(shown.length, 1);
  assert.equal(r.data?.approvedBy, undefined);
  const record = JSON.parse(await readFile(recordPath(context, 'epic-completion', approvalViewDigest('epic-completion', view())), 'utf8')) as Record<string, unknown>;
  assert.equal(Object.hasOwn(record, 'approvedBy'), false, 'human records keep the original format');
  assert.equal(Object.hasOwn(record, 'stage'), false);
});

test('records without approvedBy/stage (older versions) are still accepted; malformed agent fields are not', async t => {
  const {store, context} = await setup(t);
  await store.confirmContent('specification', WORKFLOW_ID, view(), context, ui(true).ui, makeScope());
  const digest = approvalViewDigest('specification', view()), path = recordPath(context, 'specification', digest);
  const old = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  assert.equal((await store.requireContentApproval('specification', WORKFLOW_ID, digest, context)).ok, true);
  for (const bad of [{approvedBy: 'human'}, {approvedBy: 'agent'}, {approvedBy: 'agent', stage: 'basic-design'}, {stage: 'verification'}, {approvedBy: 'agent', stage: 7}]) {
    await writeFile(path, JSON.stringify({...old, ...bad}), {mode: 0o600});
    assert.equal((await store.requireContentApproval('specification', WORKFLOW_ID, digest, context)).ok, false, JSON.stringify(bad));
  }
  await writeFile(path, JSON.stringify({...old, approvedBy: 'agent', stage: 'verification'}), {mode: 0o600});
  assert.equal((await store.requireContentApproval('specification', WORKFLOW_ID, digest, context)).ok, true);
});

// ---- owner-policy approvals (agentApprovals) -------------------------------------------------------

test('a policy approval is recorded by the parent itself: no dialog, also headless, approvedBy agent with basis policy', async t => {
  const {store, context} = await setup(t);
  for (const kind of ['specification', 'implementation-start', 'epic-completion', 'specification-revision'] as const) {
    let asked = 0;
    const headless: ApprovalUi = {interactive: false, confirm: async () => { asked++; return false; }};
    const r = await store.confirmContent(kind, WORKFLOW_ID, view(), context, headless, makeScope(), {policy: true});
    assert.equal(r.status, 'validated', JSON.stringify(r.problems));
    assert.equal(asked, 0, 'the human is not asked');
    assert.deepEqual([r.data?.approvedBy, r.data?.basis, r.data?.stage], ['agent', 'policy', undefined]);
    const digest = approvalViewDigest(kind, view());
    const record = JSON.parse(await readFile(recordPath(context, kind, digest), 'utf8')) as {approvedBy: string; basis: string; profileInstructionsDigest: string};
    assert.deepEqual([record.approvedBy, record.basis, record.profileInstructionsDigest], ['agent', 'policy', SHA_B], 'the instructions digest is still recorded');
    const ref = await store.requireContentApproval(kind, WORKFLOW_ID, digest, context);
    assert.ok(ref.ok);
    assert.deepEqual([ref.value.approvedBy, ref.value.basis], ['agent', 'policy']);
  }
});

test('a policy approval stays valid after the profile instructions change; a human approval does not', async t => {
  const {store, context} = await setup(t);
  await store.confirmContent('specification', WORKFLOW_ID, view(SHA_A), context, ui(true).ui, makeScope(), {policy: true});
  await store.confirmContent('implementation-start', WORKFLOW_ID, view(SHA_A), context, ui(true).ui, makeScope());
  const changed = {...context, profileInstructionsDigest: SHA_A};
  assert.equal((await store.requireContentApproval('specification', WORKFLOW_ID, approvalViewDigest('specification', view(SHA_A)), changed)).ok, true);
  const human = await store.requireContentApproval('implementation-start', WORKFLOW_ID, approvalViewDigest('implementation-start', view(SHA_A)), changed);
  assert.ok(!human.ok && human.problems[0]!.code === 'APPROVAL_MISMATCH');
  // Other bindings still count for a policy approval.
  const digest = approvalViewDigest('specification', view(SHA_A));
  assert.equal((await store.requireContentApproval('specification', WORKFLOW_ID, digest, {...context, profileId: 'other'})).ok, false);
  assert.equal((await store.requireContentApproval('specification', WORKFLOW_ID, digest, {...context, accountBinding: SHA_B})).ok, false);
});

test('a child session never records a policy approval', async t => {
  const {store, context} = await setup(t);
  const child: ApprovalUi = {interactive: false, child: true, confirm: async () => true};
  const r = await store.confirmContent('specification', WORKFLOW_ID, view(), context, child, makeScope(), {policy: true});
  assert.equal(r.status, 'blocked');
  assert.ok(r.problems.some(p => p.code === 'APPROVAL_UI_REQUIRED'));
});

test('a policy approval is refused once the session changed', async t => {
  const {store, context} = await setup(t);
  const scope = makeScope();
  scope.expire();
  const r = await store.confirmContent('specification', WORKFLOW_ID, view(), context, ui(true).ui, scope, {policy: true});
  assert.equal(r.status, 'cancelled');
});

test('records with an unknown basis are invalid', async t => {
  const {store, context} = await setup(t);
  await store.confirmContent('specification', WORKFLOW_ID, view(), context, ui(true).ui, makeScope(), {policy: true});
  const digest = approvalViewDigest('specification', view());
  const path = recordPath(context, 'specification', digest);
  const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  for (const bad of [{basis: 'whatever'}, {basis: 'policy', approvedBy: undefined}]) {
    await writeFile(path, JSON.stringify({...record, ...bad}), {mode: 0o600});
    const r = await store.requireContentApproval('specification', WORKFLOW_ID, digest, context);
    assert.ok(!r.ok && r.problems[0]!.code === 'APPROVAL_INVALID', JSON.stringify(bad));
  }
});
