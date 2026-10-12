import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AGENT_DECISION_BLOCKED_TOOLS, PREREQUISITE_QUESTION_MARKER, QUESTION_BLOCK_REASON, isPrerequisiteRequest, questionGuard, resolveAgentDecisionStage, type AcceptedHandoff} from '../src/core/agent-decision.js';
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

const P = PREREQUISITE_QUESTION_MARKER;

test('a prerequisite-task request is recognised only when every question starts with the marker', () => {
  assert.equal(P, '【事前作業】');
  // ask_user (pi-ask-user): {question, context?, options?}
  assert.equal(isPrerequisiteRequest({question: `${P}Studio にログインしてください。終わったら「完了」を選んでください。`}), true);
  assert.equal(isPrerequisiteRequest({question: `  ${P}画面収録を許可してください。`, context: '検証が止まっています', options: ['完了']}), true, 'leading whitespace is ignored');
  assert.equal(isPrerequisiteRequest({question: 'どちらの案にしますか？'}), false, 'a decision question');
  assert.equal(isPrerequisiteRequest({question: `どちらにしますか？${P}`}), false, 'the marker must be at the start');
  assert.equal(isPrerequisiteRequest({question: '事前作業：ログインしてください'}), false, 'only the exact bracketed marker counts');
  assert.equal(isPrerequisiteRequest({question: 'どれにしますか？', context: `${P}`}), false, 'the context field does not count');
  // AskUserQuestion (Claude Code shape): {questions: [{question, header, options, multiSelect}]}
  assert.equal(isPrerequisiteRequest({questions: [{question: `${P}キーを登録してください。`, header: '事前作業', options: [{label: '完了'}], multiSelect: false}]}), true);
  assert.equal(isPrerequisiteRequest({questions: [{question: `${P}ログインしてください。`}, {question: `${P}収録を許可してください。`}]}), true);
  assert.equal(isPrerequisiteRequest({questions: [{question: `${P}ログインしてください。`}, {question: 'A案とB案のどちらにしますか？'}]}), false, 'one decision question mixed in');
  assert.equal(isPrerequisiteRequest({question: `${P}ログインしてください。`, questions: [{question: '仕様をどうしますか？'}]}), false, 'both fields count');
  // unknown or malformed shapes never pass
  for (const input of [undefined, null, {}, 'text', {question: 1}, {questions: []}, {questions: 'x'}, {questions: [{}]}, {questions: [{question: 2}]}, {header: P}]) {
    assert.equal(isPrerequisiteRequest(input), false, JSON.stringify(input));
  }
});

test('in a listed implementation/verification session, a prerequisite-task request passes and a decision question stays blocked', async t => {
  for (const stage of ['implementation', 'verification'] as const) {
    const call = await guardFor(t, policy([stage]), handoff(stage));
    assert.equal(await call('ask_user', 's1', {question: `${P}Roblox Studio にログインし、MCP プラグインを有効にしてください。終わったら「完了」を選んでください。`, options: ['完了']}), undefined, `${stage} ask_user`);
    assert.equal(await call('AskUserQuestion', 's1', {questions: [{question: `${P}キーチェーンに API キーを登録してください。`, header: '事前作業', options: [{label: '完了', description: '登録した'}], multiSelect: false}]}), undefined, `${stage} AskUserQuestion`);
    const blocked = await call('ask_user', 's1', {question: 'どちらの実装にしますか？', options: ['A', 'B']});
    assert.equal(blocked?.block, true);
    assert.equal(blocked!.reason, QUESTION_BLOCK_REASON(stage));
    assert.equal((await call('AskUserQuestion', 's1', {questions: [{question: `${P}ログインしてください。`}, {question: 'どちらにしますか？'}]}))?.block, true, 'a mixed call is blocked');
    assert.equal((await call('ask_user', 's1', {}))?.block, true, 'an empty input is blocked');
  }
});

test('the block reason explains the prerequisite exception in one line and keeps decision questions out', () => {
  for (const stage of ['implementation', 'verification'] as const) {
    const lines = QUESTION_BLOCK_REASON(stage).split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[1]!, /【事前作業】/);
    assert.match(lines[1]!, /判断を求める質問には使えません/);
  }
});
