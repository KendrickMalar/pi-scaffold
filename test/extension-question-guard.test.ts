// The real extension entry (extensions/index.ts) with a fake Pi host: the accepted packet's stage drives the tool_call guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createJiti} from 'jiti';
import {writePacket, type HandoffPacketV1} from '../src/handoff/packet.js';
import {taggedDigest} from '../src/core/digests.js';
import {readProfileSnapshot} from '../src/core/repo-context.js';
import type {Stage} from '../src/core/contracts.js';
import {WORKFLOW_ID, SHA_A} from './helpers/docs.js';

type Handler = (event: unknown, ctx: unknown) => unknown;
const root = fileURLToPath(new URL('../../', import.meta.url));
const profile = {type: 'custom', customType: 'startup-profile-state', data: {version: 1, id: 'developer', label: 'developer', instructions: '開発用（架空）'}};

async function boot(t: {after(fn: () => Promise<void>): void}, opts: {stages: string[]; targetStage: Stage; withPacket?: boolean; field?: 'agentDecisionStages' | 'questionBlockedStages'}) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-scaffold-ext-'));
  const agentDir = await realpath(dir).then(d => join(d, 'agent')), cwd = join(dir, 'repo');
  await mkdir(join(agentDir, 'pi-scaffold'), {recursive: true, mode: 0o700}); await mkdir(cwd);
  await writeFile(join(agentDir, 'pi-scaffold', 'policy.json'), JSON.stringify({version: 1, repos: {'example/demo': {authMode: 'file-backed', models: [], [opts.field ?? 'agentDecisionStages']: opts.stages}}}), {mode: 0o600});
  const snapshot = readProfileSnapshot([profile]).snapshot!;
  const packet: HandoffPacketV1 = {
    version: 1, nonce: 'c'.repeat(64), workflowId: WORKFLOW_ID, repo: 'example/demo', epicIssue: 10, sourceStage: 'basic-design', targetStage: opts.targetStage,
    artifactDigests: {epicBodySha256: SHA_A, epicLabelsSha256: SHA_A}, cwd, profileId: 'developer', profileInstructionsDigest: snapshot.instructionsDigest,
    accountBinding: taggedDigest('account-binding', {agentDir, authMode: 'file-backed'}), requiredTools: [], resourceRefs: [],
  };
  const {path} = await writePacket(join(agentDir, 'pi-scaffold', 'state', 'x', 'handoff', 'op'), packet, join(agentDir, 'pi-scaffold'));
  const saved = {agent: process.env.PI_CODING_AGENT_DIR, herdr: process.env.HERDR_ENV};
  process.env.PI_CODING_AGENT_DIR = agentDir; delete process.env.HERDR_ENV;
  t.after(async () => {
    for (const [k, v] of [['PI_CODING_AGENT_DIR', saved.agent], ['HERDR_ENV', saved.herdr]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    await rm(dir, {recursive: true, force: true});
  });
  const handlers = new Map<string, Handler[]>();
  const pi = {
    registerTool: () => {}, registerFlag: () => {}, getAllTools: () => [], events: {on: () => () => {}, emit: () => {}},
    getFlag: (name: string) => name === 'scaffold-handoff' && opts.withPacket !== false ? path : undefined,
    on: (name: string, h: Handler) => { handlers.set(name, [...(handlers.get(name) ?? []), h]); },
  };
  const jiti = createJiti(import.meta.url, {moduleCache: false, fsCache: false});
  const mod = await jiti.import(join(root, 'extensions/index.ts')) as {default: (pi: unknown) => void};
  mod.default(pi);
  const notes: string[] = [];
  let resolveNote: () => void = () => {};
  const noted = new Promise<void>(res => { resolveNote = res; });
  const ctx = {cwd, sessionManager: {getSessionId: () => 'stage-session', getEntries: () => [profile]}, ui: {notify: (text: string) => { notes.push(text); resolveNote(); }}};
  for (const h of handlers.get('session_start') ?? []) h({}, ctx);
  if (opts.withPacket !== false) await noted;
  const toolCall = async (toolName: string, sessionId = 'stage-session', input: Record<string, unknown> = {}) => {
    const hs = handlers.get('tool_call') ?? [];
    assert.equal(hs.length, 1, 'one tool_call handler is registered');
    return await hs[0]!({type: 'tool_call', toolCallId: 't1', toolName, input}, {...ctx, sessionManager: {...ctx.sessionManager, getSessionId: () => sessionId}}) as {block: true; reason: string} | undefined;
  };
  return {toolCall, notes};
}

test('extension: in an accepted Implementation packet session listed in the policy, ask_user/AskUserQuestion are blocked', async t => {
  const {toolCall, notes} = await boot(t, {stages: ['implementation'], targetStage: 'implementation'});
  assert.ok(notes.some(n => n.includes('受け付けました')), notes.join('\n'));
  assert.equal((await toolCall('ask_user'))?.block, true);
  assert.equal((await toolCall('AskUserQuestion'))?.block, true);
  assert.equal(await toolCall('bash'), undefined);
  assert.equal(await toolCall('ask_user', 'another-session'), undefined, 'a later session of this process is not the stage session');
});

test('extension: an unlisted stage, a basic-design packet or no packet leaves questions allowed', async t => {
  assert.equal(await (await boot(t, {stages: ['verification'], targetStage: 'implementation'})).toolCall('ask_user'), undefined);
  assert.equal(await (await boot(t, {stages: ['implementation', 'verification'], targetStage: 'basic-design'})).toolCall('ask_user'), undefined);
  assert.equal(await (await boot(t, {stages: ['implementation'], targetStage: 'implementation', withPacket: false})).toolCall('ask_user'), undefined);
});

test('extension: a 【事前作業】 request is blocked too', async t => {
  const {toolCall} = await boot(t, {stages: ['implementation'], targetStage: 'implementation'});
  const r = await toolCall('ask_user', 'stage-session', {question: '【事前作業】Studio にログインしてください。終わったら「完了」を選んでください。', options: ['完了']});
  assert.equal(r?.block, true);
  assert.doesNotMatch(r!.reason, /【事前作業】/);
});

test('extension: questionBlockedStages blocks questions in an accepted Basic design session', async t => {
  const {toolCall} = await boot(t, {stages: ['basic-design', 'implementation'], targetStage: 'basic-design', field: 'questionBlockedStages'});
  assert.equal((await toolCall('ask_user'))?.block, true);
  assert.equal((await toolCall('AskUserQuestion'))?.block, true);
});
