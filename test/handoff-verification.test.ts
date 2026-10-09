import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, symlink, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {createHarness, loadToolModule, type Scenario} from './helpers/harness.js';
import {FakePiGh} from './helpers/fake-pi-gh.js';
import {FakeHerdr} from './helpers/fake-herdr.js';
import {renderEpicBlock, renderFeatureBlock} from '../src/core/epic-render.js';
import {parseIssueBody} from '../src/core/body-codec.js';
import {sha256Text} from '../src/core/digests.js';
import {labelDefinitions} from '../src/core/label-definitions.js';
import {repoHash} from '../src/core/repo-context.js';
import {acceptStartupPacket, recordTurnStarted} from '../src/handoff/receiver.js';
import type {EpicDocV1, FeatureDocV1} from '../src/core/contracts.js';
import type {OwnerPolicy} from '../src/core/model-bindings.js';
import {populatedDoc, featureDoc, OPERATION_ID} from './helpers/docs.js';

const INTEGRATION = 'a1'.repeat(20), FEATURE_A = 'b2'.repeat(20), SUITE = 'c3'.repeat(20), UNRELATED = 'd4'.repeat(20);
const commits = {exists: [INTEGRATION, FEATURE_A, SUITE, UNRELATED], ancestors: [[FEATURE_A, INTEGRATION], [SUITE, INTEGRATION]] as [string, string][]};
const policy: OwnerPolicy = {version: 1, repos: {'example/demo': {authMode: 'file-backed', models: []}}};
const profile = {type: 'custom', customType: 'startup-profile-state', data: {version: 1, id: 'developer', label: 'developer', instructions: '開発用（架空）'}};
const environment = {HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w9', HERDR_PANE_ID: 'w9:pA', HERDR_SOCKET_PATH: '/synthetic/herdr.sock'};
const TOOLS = ['gh_capabilities', 'gh_issue_get', 'gh_issue_edit_if_current', 'gh_issue_labels_if_current', 'scaffold_handoff_verification'];
const ISSUES = [11, 12];

const epicDoc = (mutate: (d: EpicDocV1) => void = () => {}) => { const d = {...populatedDoc(), stage: 'implementation' as const, revision: 12, handoff: null}; mutate(d); return d; };
function feature(epic: EpicDocV1, n: number): FeatureDocV1 {
  return {...featureDoc(), workflowId: epic.workflowId, featureKey: `F00${n - 10}`, parentEpic: 10, stage: 'implementation', editScope: [`src/f${n}/`],
    criteria: [{id: `AC10${n - 10}`, requirementIds: ['REQ001'], verification: '単体テスト', expectedResult: '期待どおり'}, ...(n === 11 ? [{id: 'AC120', requirementIds: ['REQ002'], verification: 'E2E', expectedResult: '保存される'}] : [])],
    createOperationId: `eeeeeeee-eeee-4eee-8eee-${String(n).padStart(12, '0')}`};
}
function world(opts: {epic?: EpicDocV1; closed?: number[]; epicLabels?: string[]} = {}) {
  const gh = new FakePiGh().seedLabels(labelDefinitions()).enableProposals();
  const epic = opts.epic ?? epicDoc();
  gh.add({number: 10, title: 'Epic', body: renderEpicBlock(epic), labels: opts.epicLabels ?? ['Type: Scaffold', 'Scope: Epic', 'Stage: Implementation'], state: 'open', subIssues: [...ISSUES]});
  for (const n of ISSUES) gh.add({number: n, title: `F${n}`, body: renderFeatureBlock(feature(epic, n)), labels: ['Type: Scaffold', 'Scope: Feature', 'Stage: Implementation', 'Wave: 1'], state: opts.closed?.includes(n) ? 'closed' : 'open'});
  return gh;
}
const docOf = (gh: FakePiGh) => (parseIssueBody(gh.issues.get(10)!.body) as {ok: true; value: {doc: EpicDocV1}}).value.doc;
type Report = {version: 1; workflowId: string; featureIssue: number; productRef: string; suiteRef: string; criteria: {id: string; status: string; command: string; exitCode: number | null; logPath: string; logSha256: string}[]};
const evidenceRoot = (agentDir: string) => join(agentDir, 'pi-scaffold', 'state', repoHash('example/demo'), epicDoc().workflowId, 'evidence');
async function owned(path: string, text: string) { await mkdir(dirname(path), {recursive: true, mode: 0o700}); await writeFile(path, text, {mode: 0o600}); }
/** Writes reports and logs into the owned evidence root; returns the evidenceRefs input. */
async function writeEvidence(agentDir: string, mutate: (reports: Report[]) => void = () => {}, opts: {skipLogs?: string[]} = {}) {
  const root = evidenceRoot(agentDir);
  const reports: Report[] = ISSUES.map(n => ({version: 1, workflowId: epicDoc().workflowId, featureIssue: n, productRef: INTEGRATION, suiteRef: SUITE,
    criteria: feature(epicDoc(), n).criteria.map(c => ({id: c.id, status: 'pass', command: 'npm test', exitCode: 0, logPath: `logs/${n}-${c.id}.log`, logSha256: sha256Text(`ok ${n} ${c.id}\n`)}))}));
  mutate(reports);
  for (const r of reports) for (const c of r.criteria) if (!opts.skipLogs?.includes(c.logPath)) await owned(join(root, c.logPath), `ok ${r.featureIssue} ${c.id}\n`);
  const refs: {relativePath: string; sha256: string}[] = [];
  for (const r of reports) { const text = JSON.stringify(r); await owned(join(root, `reports/${r.featureIssue}.json`), text); refs.push({relativePath: `reports/${r.featureIssue}.json`, sha256: sha256Text(text)}); }
  return refs;
}
function receiver(herdr: FakeHerdr, agentDir: () => string, seen: {packet?: Record<string, unknown>}) {
  let packetPath = '';
  herdr.onPaneRun = async (_pane, command) => {
    packetPath = /--scaffold-handoff '([^']+)'/.exec(command)![1]!;
    seen.packet = JSON.parse((await import('node:fs')).readFileSync(packetPath, 'utf8'));
    const r = await acceptStartupPacket({packetPath, agentDir: agentDir(), cwd: '/synthetic/repo', sessionId: 'verify-session', sessionEntries: [profile], toolNames: TOOLS, policy});
    assert.ok(r.ok, JSON.stringify(r));
  };
  herdr.onPrompt = async (_pane, text) => { await recordTurnStarted({packetPath, agentDir: agentDir(), sessionId: 'verify-session', prompt: text}); };
}
async function harness(t: {after(fn: () => Promise<void>): void}, gh: FakePiGh, scenario: Scenario = {}) {
  const {createTool} = await loadToolModule('extensions/tools/handoff-verification.ts');
  const herdr = new FakeHerdr(); const seen: {packet?: Record<string, unknown>} = {};
  let agentDir = '';
  receiver(herdr, () => agentDir, seen);
  const h = await createHarness(createTool, {scenario: {gh, herdr, policy, sessionEntries: [profile], environment, tools: TOOLS, waitMs: 300, pollMs: 10, commits, ...scenario}});
  agentDir = h.agentDir;
  t.after(h.dispose);
  return {h, herdr, seen};
}
const params = (gh: FakePiGh, evidenceRefs: unknown, extra: Record<string, unknown> = {}) => ({
  repo: 'example/demo', epicIssue: 10, operationId: OPERATION_ID, expectedRevision: docOf(gh).revision, expectedBodySha256: sha256Text(gh.issues.get(10)!.body),
  integrationRef: INTEGRATION, evidenceRefs, ...extra,
});
const noLaunch = (herdr: FakeHerdr, gh: FakePiGh) => {
  assert.equal(herdr.tabCreates, 0); assert.equal(herdr.count('paneRun'), 0);
  assert.equal(gh.conditionalChanges.length, 0); assert.equal(gh.count('gh_issue_close_if_current') + gh.count('gh_issue_close'), 0);
};
async function expectBlocked(t: {after(fn: () => Promise<void>): void}, mutate: (r: Report[]) => void, code: string, opts: {skipLogs?: string[]; extra?: Record<string, unknown>; gh?: FakePiGh; refs?: (refs: {relativePath: string; sha256: string}[], agentDir: string) => Promise<unknown> | unknown} = {}) {
  const gh = opts.gh ?? world();
  const {h, herdr} = await harness(t, gh);
  let refs: unknown = await writeEvidence(h.agentDir, mutate, opts);
  if (opts.refs) refs = await opts.refs(refs as {relativePath: string; sha256: string}[], h.agentDir);
  const out = await h.invoke(params(gh, refs, opts.extra));
  assert.equal(out.r.status, 'blocked', JSON.stringify(out.r));
  assert.ok(out.r.problems.some(p => p.code === code), JSON.stringify(out.r.problems));
  noLaunch(herdr, gh);
}

// ---- evidence gate --------------------------------------------------------------------------------

test('a missing criterion in a report is blocked', async t => { await expectBlocked(t, r => { r[0]!.criteria.pop(); }, 'CRITERION_EVIDENCE_MISSING'); });
test('an unknown criterion is blocked', async t => { await expectBlocked(t, r => { r[1]!.criteria.push({...r[1]!.criteria[0]!, id: 'AC999'}); }, 'UNKNOWN_CRITERION'); });
for (const status of ['fail', 'unverified']) test(`status ${status} is blocked`, async t => { await expectBlocked(t, r => { r[0]!.criteria[0]!.status = status; }, 'CRITERION_NOT_PASSED'); });
test('exitCode != 0 is blocked', async t => { await expectBlocked(t, r => { r[0]!.criteria[0]!.exitCode = 1; }, 'EXIT_CODE'); });
test('a productRef outside the integration history is blocked', async t => { await expectBlocked(t, r => { r[0]!.productRef = UNRELATED; }, 'REF_NOT_INTEGRATED'); });
test('a suiteRef that does not exist is blocked', async t => { await expectBlocked(t, r => { r[0]!.suiteRef = 'e5'.repeat(20); }, 'REF_NOT_FOUND'); });
test('an integrationRef that does not exist is blocked', async t => { await expectBlocked(t, () => {}, 'REF_NOT_FOUND', {extra: {integrationRef: 'f6'.repeat(20)}}); });
test('a mutable ref like HEAD is rejected', async t => {
  const gh = world(); const {h, herdr} = await harness(t, gh);
  const out = await h.invoke(params(gh, await writeEvidence(h.agentDir), {integrationRef: 'HEAD'}));
  assert.equal(out.r.status, 'blocked'); noLaunch(herdr, gh);
});
test('a missing log is blocked', async t => { await expectBlocked(t, () => {}, 'EVIDENCE_NOT_FOUND', {skipLogs: ['logs/11-AC101.log']}); });
test('a log hash mismatch is blocked', async t => { await expectBlocked(t, r => { r[0]!.criteria[0]!.logSha256 = 'f'.repeat(64); }, 'LOG_HASH_MISMATCH'); });
test('a report whose hash differs from its reference is blocked', async t => {
  await expectBlocked(t, () => {}, 'REPORT_HASH_MISMATCH', {refs: refs => refs.map((r, i) => i === 0 ? {...r, sha256: 'f'.repeat(64)} : r)});
});
test('a log path outside the evidence root is blocked and never read', async t => { await expectBlocked(t, r => { r[0]!.criteria[0]!.logPath = '../../../../auth.json'; }, 'INVALID_PATH'); });
test('a symlinked log is blocked', async t => {
  await expectBlocked(t, () => {}, 'SYMLINK', {skipLogs: ['logs/11-AC101.log'], refs: async (refs, agentDir) => { await symlink('/etc/hosts', join(evidenceRoot(agentDir), 'logs/11-AC101.log')); return refs; }});
});
test('a FIFO log is blocked', async t => {
  await expectBlocked(t, () => {}, 'NOT_REGULAR_FILE', {skipLogs: ['logs/11-AC101.log'], refs: async (refs, agentDir) => { execFileSync('mkfifo', [join(evidenceRoot(agentDir), 'logs/11-AC101.log')]); return refs; }});
});
test('a closed Feature without a report is blocked (closed is not passing)', async t => {
  await expectBlocked(t, () => {}, 'FEATURE_EVIDENCE_MISSING', {gh: world({closed: [12]}), refs: refs => refs.slice(0, 1)});
});
test('two reports for one Feature are blocked', async t => {
  await expectBlocked(t, () => {}, 'DUPLICATE_REPORT', {refs: refs => [...refs, refs[0]!]});
});

test('Blocked, a duplicate Stage, a stale body and the wrong stage launch nothing', async t => {
  for (const [gh, code] of [
    [world({epicLabels: ['Type: Scaffold', 'Scope: Epic', 'Stage: Implementation', 'Blocked']}), 'BLOCKED'],
    [world({epicLabels: ['Type: Scaffold', 'Scope: Epic', 'Stage: Implementation', 'Stage: Verification']}), 'DUPLICATE_MANAGED_LABEL'],
    [world({epic: epicDoc(d => { d.stage = 'basic-design'; }), epicLabels: ['Type: Scaffold', 'Scope: Epic', 'Stage: BasicDesign']}), 'STAGE_MISMATCH'],
  ] as const) await expectBlocked(t, () => {}, code, {gh});
  await expectBlocked(t, () => {}, 'STALE_BODY', {extra: {expectedBodySha256: 'f'.repeat(64)}});
});

// ---- handing off --------------------------------------------------------------------------------

test('valid evidence hands the open Epic to a new Verification session with the evidence pinned in the packet', async t => {
  const gh = world();
  const {h, herdr, seen} = await harness(t, gh);
  const refs = await writeEvidence(h.agentDir, r => { r[1]!.productRef = FEATURE_A; });
  const out = await h.invoke(params(gh, refs));
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.equal(gh.issues.get(10)!.state, 'open');
  assert.deepEqual(gh.issues.get(10)!.labels.sort(), ['Scope: Epic', 'Stage: Verification', 'Type: Scaffold']);
  assert.equal(docOf(gh).stage, 'verification');
  assert.equal(gh.count('gh_issue_close_if_current') + gh.count('gh_issue_close'), 0);
  assert.equal(herdr.tabCreates, 1);
  const resources = seen.packet!.resourceRefs as string[];
  assert.ok(resources.includes(`integration:${INTEGRATION}`), JSON.stringify(resources));
  for (const r of refs) assert.ok(resources.includes(`evidence:${r.relativePath}@sha256:${r.sha256}`));
  const data = out.r.data as Record<string, unknown>;
  assert.equal(data.testedOnIntegration, false, '#12 was tested on a pre-integration commit');
  assert.equal(data.evidenceChecked, 'refs-and-hashes-only', 'never reported as authenticated');
  assert.ok(!('verified' in data) && !('accepted' in data));
  assert.match(herdr.calls.filter(c => c.command === 'agentPrompt').map(c => (c.args as {text: string}).text).join(), /検証（Verification）/);
});

test('input with close/accept flags is rejected', async t => {
  const gh = world(); const {h, herdr} = await harness(t, gh);
  for (const extra of [{close: true}, {accepted: true}]) {
    const out = await h.invoke(params(gh, await writeEvidence(h.agentDir), extra));
    assert.equal(out.inputSchemaValid, false); assert.equal(out.r.status, 'blocked');
  }
  noLaunch(herdr, gh);
});
