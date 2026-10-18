import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AGENT_DECISION_BLOCKED_TOOLS, QUESTION_BLOCK_REASON, questionGuard, resolveAgentDecisionStage, resolveQuestionBlockedStage, type AcceptedHandoff} from '../src/core/agent-decision.js';
import type {OwnerPolicy} from '../src/core/model-bindings.js';
import type {Stage} from '../src/core/contracts.js';
import {WORKFLOW_ID} from './helpers/docs.js';

const policy = (stages?: unknown[], key = 'example/demo'): OwnerPolicy => ({version: 1, repos: {[key]: {authMode: 'file-backed', models: [], ...(stages ? {agentDecisionStages: stages as never} : {})}}});
const handoff = (targetStage: Stage, extra: Partial<AcceptedHandoff> = {}): AcceptedHandoff => ({sessionId: 's1', repo: 'example/demo', workflowId: WORKFLOW_ID, targetStage, ...extra});
const at = {sessionId: 's1', repo: 'example/demo', workflowId: WORKFLOW_ID};

test('the session stage counts only when the accepted packet is for this session/repo/workflow and the policy lists it', () => {
  const both = policy(['implementation', 'verification']);
  assert.equal(resolveAgentDecisionStage(handoff('implementation'), both, at), 'implementation');
  assert.equal(resolveAgentDecisionStage(handoff('verification'), both, at), 'verification');
  for (const stage of ['setup', 'specification', 'basic-design', 'completed'] as const) assert.equal(resolveAgentDecisionStage(handoff(stage), both, at), undefined, stage);
  assert.equal(resolveAgentDecisionStage(undefined, both, at), undefined, 'no accepted packet');
  assert.equal(resolveAgentDecisionStage(handoff('verification'), policy(['implementation']), at), undefined, 'stage not listed');
  assert.equal(resolveAgentDecisionStage(handoff('implementation'), policy(), at), undefined, 'absent field = []');
  assert.equal(resolveAgentDecisionStage(handoff('implementation'), undefined, at), undefined, 'no policy');
  assert.equal(resolveAgentDecisionStage(handoff('implementation', {sessionId: 'other'}), both, at), undefined, 'another session accepted it');
  assert.equal(resolveAgentDecisionStage(handoff('implementation', {repo: 'example/other'}), policy(['implementation'], 'example/*'), at), undefined, 'packet for another repo');
  assert.equal(resolveAgentDecisionStage(handoff('implementation'), both, {...at, repo: 'example/other'}), undefined, 'call for another repo');
  assert.equal(resolveAgentDecisionStage(handoff('implementation'), both, {...at, workflowId: '88888888-8888-4888-8888-888888888888'}), undefined, 'another workflow');
  assert.equal(resolveAgentDecisionStage(handoff('implementation'), policy(['implementation'], 'example/*'), at), 'implementation', 'OWNER/* entry applies');
  assert.equal(resolveAgentDecisionStage(handoff('implementation'), policy(['implementation'], 'example/other'), at), undefined, 'entry of another repo');
});

test('the blocked question tools are one exported list', () => {
  assert.ok(AGENT_DECISION_BLOCKED_TOOLS.includes('ask_user'));
  assert.ok(AGENT_DECISION_BLOCKED_TOOLS.includes('AskUserQuestion'));
});

async function guardFor(t: {after(fn: () => Promise<void>): void}, value: OwnerPolicy | undefined, accepted: AcceptedHandoff | undefined) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-scaffold-guard-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const agentDir = join(dir, 'agent');
  await mkdir(join(agentDir, 'pi-scaffold'), {recursive: true, mode: 0o700});
  if (value) await writeFile(join(agentDir, 'pi-scaffold', 'policy.json'), JSON.stringify(value), {mode: 0o600});
  const runtime: {agentDir: string; handoff?: AcceptedHandoff} = {agentDir, ...(accepted ? {handoff: accepted} : {})};
  const guard = questionGuard(runtime);
  return (toolName: string, sessionId = 's1', input?: unknown) => guard({toolName, ...(input !== undefined ? {input} : {})}, {sessionManager: {getSessionId: () => sessionId}});
}

test('question tools are blocked in a listed implementation/verification session, with a decide-yourself reason', async t => {
  for (const stage of ['implementation', 'verification'] as const) {
    const call = await guardFor(t, policy([stage]), handoff(stage));
    for (const name of AGENT_DECISION_BLOCKED_TOOLS) {
      const r = await call(name);
      assert.equal(r?.block, true, `${stage} ${name}`);
      assert.match(r!.reason, /承認済みの仕様・設計/);
      assert.match(r!.reason, /Issue/);
      assert.match(r!.reason, /最終報告/);
    }
    assert.equal(await call('bash'), undefined, 'other tools pass');
    assert.equal(await call('scaffold_epic_complete'), undefined);
  }
});

test('question tools pass when the stage is not listed, before basic design, without a packet, in another session, or with a broken policy', async t => {
  assert.equal(await (await guardFor(t, policy(['verification']), handoff('implementation')))('ask_user'), undefined);
  assert.equal(await (await guardFor(t, policy(['implementation', 'verification']), handoff('basic-design')))('ask_user'), undefined);
  assert.equal(await (await guardFor(t, policy(['implementation', 'verification']), handoff('specification')))('AskUserQuestion'), undefined);
  assert.equal(await (await guardFor(t, policy(['implementation']), undefined))('ask_user'), undefined);
  assert.equal(await (await guardFor(t, policy(['implementation']), handoff('implementation')))('ask_user', 'other-session'), undefined);
  assert.equal(await (await guardFor(t, policy(), handoff('implementation')))('ask_user'), undefined);
  assert.equal(await (await guardFor(t, policy(['implementation'], 'example/other'), handoff('implementation')))('ask_user'), undefined);
  const broken = await guardFor(t, undefined, handoff('implementation'));
  assert.equal(await broken('ask_user'), undefined, 'no policy file');
});

const blockedPolicy = (stages: string[], key = 'example/demo'): OwnerPolicy => ({version: 1, repos: {[key]: {authMode: 'file-backed', models: [], questionBlockedStages: stages as never}}});

test('questionBlockedStages: a listed basic-design/implementation/verification session never asks; specification always may', async t => {
  const all = blockedPolicy(['setup', 'basic-design', 'implementation', 'verification']);
  for (const stage of ['basic-design', 'implementation', 'verification'] as const) {
    assert.equal(resolveQuestionBlockedStage(handoff(stage), all, at), stage);
    const call = await guardFor(t, all, handoff(stage));
    for (const name of AGENT_DECISION_BLOCKED_TOOLS) {
      const r = await call(name, 's1', {question: 'どちらにしますか？'});
      assert.equal(r?.block, true, `${stage} ${name}`);
      assert.equal(r!.reason, QUESTION_BLOCK_REASON(stage));
    }
  }
  assert.equal(resolveQuestionBlockedStage(handoff('specification'), all, at), undefined, 'specification is never blocked');
  assert.equal(await (await guardFor(t, all, handoff('specification')))('ask_user'), undefined);
  assert.equal(await (await guardFor(t, blockedPolicy(['implementation']), handoff('basic-design')))('ask_user'), undefined, 'an unlisted stage asks');
  assert.equal(await (await guardFor(t, all, undefined))('ask_user'), undefined, 'no accepted packet, no stage');
  assert.equal(resolveQuestionBlockedStage(handoff('basic-design', {sessionId: 'other'}), all, at), undefined, 'another session');
});

test('a 【事前作業】 request is blocked like any other question (the exception was removed)', async t => {
  for (const p of [policy(['implementation', 'verification']), blockedPolicy(['implementation', 'verification'])]) {
    const call = await guardFor(t, p, handoff('implementation'));
    assert.equal((await call('ask_user', 's1', {question: '【事前作業】Studio にログインしてください。', options: ['完了']}))?.block, true);
    assert.equal((await call('AskUserQuestion', 's1', {questions: [{question: '【事前作業】キーを登録してください。'}]}))?.block, true);
  }
});

test('the block reason sends the agent to decide, record, or revise the specification, and offers no exception', () => {
  for (const stage of ['setup', 'basic-design', 'implementation', 'verification'] as const) {
    const reason = QUESTION_BLOCK_REASON(stage);
    assert.match(reason, /scaffold_specification_revise/);
    assert.doesNotMatch(reason, /【事前作業】/);
  }
});
