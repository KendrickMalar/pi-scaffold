// The wait gate of scaffold_handoff_basic_design: an Epic marked scaffold:plan-pending, or blocked by an open Epic of this repo, is not handed off.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness, loadToolModule, type Scenario} from './helpers/harness.js';
import {FakePiGh} from './helpers/fake-pi-gh.js';
import {FakeHerdr} from './helpers/fake-herdr.js';
import {renderEpicBlock} from '../src/core/epic-render.js';
import {parseIssueBody} from '../src/core/body-codec.js';
import {sha256Text} from '../src/core/digests.js';
import {labelDefinitions} from '../src/core/label-definitions.js';
import {acceptStartupPacket, recordTurnStarted} from '../src/handoff/receiver.js';
import type {EpicDocV1} from '../src/core/contracts.js';
import type {OwnerPolicy} from '../src/core/model-bindings.js';
import {populatedDoc, OPERATION_ID} from './helpers/docs.js';

const policy: OwnerPolicy = {version: 1, repos: {'example/demo': {authMode: 'file-backed', models: []}}};
const profile = (id = 'developer', instructions = '開発用（架空）') => ({type: 'custom', customType: 'startup-profile-state', data: {version: 1, id, label: id, instructions}});
const environment = {HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w9', HERDR_PANE_ID: 'w9:pA', HERDR_SOCKET_PATH: '/synthetic/herdr.sock'};
const TOOLS = ['gh_capabilities', 'gh_issue_get', 'gh_issue_edit_if_current', 'gh_issue_labels_if_current', 'scaffold_handoff_basic_design'];
const LABELS = ['Type: Scaffold', 'Scope: Epic', 'Stage: Specification'];

function readyDoc(): EpicDocV1 {
  const d = populatedDoc();
  d.stage = 'specification'; d.revision = 5; d.design = null; d.dependencyPlan = null; d.wavePlan = null; d.handoff = null;
  d.questions = d.questions.map(q => ({...q, answer: q.answer ?? '回答済み（架空）', sourceRef: q.sourceRef ?? 'hearing-1'}));
  d.research = d.research.map(r => ({...r, state: 'resolved' as const, claim: null, conclusion: r.conclusion ?? '結論（架空）', evidenceRefs: r.evidenceRefs.length ? r.evidenceRefs : ['https://example.com/evidence'], limitations: r.limitations}));
  d.constraints = d.constraints ?? []; d.outOfScope = [];
  return d;
}
function world(labels = LABELS, blockedBy: (number | string)[] = []) {
  const gh = new FakePiGh().seedLabels(labelDefinitions()).enableProposals();
  gh.add({number: 10, title: '一覧をCSVで保存できるようにする', body: renderEpicBlock(readyDoc()), labels: [...labels], state: 'open', blockedBy});
  return gh;
}
const docOf = (gh: FakePiGh) => (parseIssueBody(gh.issues.get(10)!.body) as {ok: true; value: {doc: EpicDocV1}}).value.doc;
const params = (gh: FakePiGh) => ({repo: 'example/demo', epicIssue: 10, operationId: OPERATION_ID, expectedRevision: docOf(gh).revision, expectedBodySha256: sha256Text(gh.issues.get(10)!.body)});
async function harness(t: {after(fn: () => Promise<void>): void}, gh: FakePiGh, opts: {holdTurn?: boolean} = {}, scenario: Scenario = {}) {
  const {createTool} = await loadToolModule('extensions/tools/handoff-basic-design.ts');
  const herdr = new FakeHerdr();
  let agentDir = '';
  let packetPath = '';
  let prompt = '';
  herdr.onPaneRun = async (_pane, command) => {
    packetPath = /--scaffold-handoff '([^']+)'/.exec(command)![1]!;
    const r = await acceptStartupPacket({packetPath, agentDir, cwd: '/synthetic/repo', sessionId: 'design-session', sessionEntries: [profile()], toolNames: TOOLS, policy});
    assert.ok(r.ok, JSON.stringify(r));
  };
  // holdTurn: the new session stays silent after the prompt, so the first call pauses after the stage commit.
  herdr.onPrompt = async (_pane, text) => { prompt = text; if (!opts.holdTurn) await startTurn(); };
  const startTurn = () => recordTurnStarted({packetPath, agentDir, sessionId: 'design-session', prompt});
  const h = await createHarness(createTool, {scenario: {gh, herdr, policy, sessionEntries: [profile()], environment, tools: TOOLS, waitMs: opts.holdTurn ? 60 : 300, pollMs: 10, defaultParams: params(gh), ...scenario}});
  agentDir = h.agentDir;
  t.after(h.dispose);
  return {h, herdr, startTurn};
}
const noLaunch = (herdr: FakeHerdr, gh: FakePiGh) => {
  assert.equal(herdr.tabCreates, 0); assert.equal(herdr.count('paneRun'), 0); assert.equal(herdr.count('agentPrompt'), 0);
  assert.equal(gh.conditionalChanges.length, 0, 'no Stage/body change');
  assert.equal(gh.writes, 0, 'nothing written');
};
const blocker = (repo: string, number: number, state: 'open' | 'closed', labels: string[]) => ({number, html_url: `https://github.com/${repo}/issues/${number}`, state, labels: labels.map(name => ({name}))});

test('a Epic labelled scaffold:plan-pending is not handed off (PLAN_PENDING)', async t => {
  const gh = world([...LABELS, 'Scaffold:Plan-Pending']);
  const {h, herdr} = await harness(t, gh);
  const out = await h.invoke();
  assert.equal(out.r.status, 'blocked', JSON.stringify(out.r));
  assert.equal(out.r.problems[0]!.code, 'PLAN_PENDING', JSON.stringify(out.r.problems));
  assert.equal(out.confirmCalls, 0);
  assert.equal(docOf(gh).stage, 'specification');
  noLaunch(herdr, gh);
});

test('an open Epic blocker stops the handoff (EPIC_WAITING) and names it', async t => {
  const gh = world();
  // A same-repo URL in another letter case is still this repo.
  gh.overrides.set('gh_dependencies_list', () => FakePiGh.ok([blocker('Example/Demo', 20, 'open', ['Type: Scaffold', 'Scope: Epic']), blocker('example/demo', 21, 'open', ['Scope: Epic']), blocker('example/demo', 22, 'closed', ['Scope: Epic'])]));
  const {h, herdr} = await harness(t, gh);
  const out = await h.invoke();
  assert.equal(out.r.status, 'blocked', JSON.stringify(out.r));
  assert.equal(out.r.problems[0]!.code, 'EPIC_WAITING', JSON.stringify(out.r.problems));
  assert.match(out.r.problems[0]!.message, /#20\b/);
  assert.match(out.r.problems[0]!.message, /#21\b/);
  assert.doesNotMatch(out.r.problems[0]!.message, /#22\b/);
  assert.equal(out.confirmCalls, 0);
  assert.equal(docOf(gh).stage, 'specification');
  noLaunch(herdr, gh);
});

test('a closed Epic blocker, a Feature blocker and a cross-repo blocker do not stop the handoff', async t => {
  const gh = world(LABELS, [20, 21]);
  gh.add({number: 20, title: '閉じた Epic（架空）', body: '', labels: ['Type: Scaffold', 'Scope: Epic'], state: 'closed'});
  gh.add({number: 21, title: '開いた Feature（架空）', body: '', labels: ['Type: Scaffold', 'Scope: Feature'], state: 'open'});
  // The cross-repo entry is an open Epic of another repository.
  gh.overrides.set('gh_dependencies_list', (args) => (args as {issue: number}).issue === 10
    ? FakePiGh.ok([gh.github(gh.issues.get(20)!), gh.github(gh.issues.get(21)!), blocker('other/repo', 30, 'open', ['Scope: Epic'])])
    : undefined);
  const {h} = await harness(t, gh);
  const out = await h.invoke();
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.equal(docOf(gh).stage, 'basic-design');
});

test('a resumed handoff this journal committed is not stopped by the gate', async t => {
  const gh = world();
  const {h, herdr, startTurn} = await harness(t, gh, {holdTurn: true});
  const first = await h.invoke();
  assert.equal(first.r.status, 'partial', JSON.stringify(first.r.problems));
  assert.equal(docOf(gh).stage, 'basic-design', 'the first call committed the stage');
  // The mark and an open Epic blocker appear after this journal committed the stage.
  gh.issues.get(10)!.labels.push('scaffold:plan-pending');
  gh.add({number: 20, title: '開いた Epic（架空）', body: '', labels: ['Type: Scaffold', 'Scope: Epic'], state: 'open'});
  gh.issues.get(10)!.blockedBy = [20];
  await startTurn();
  const second = await h.invoke();
  assert.equal(second.r.status, 'applied', JSON.stringify(second.r.problems));
  assert.equal(herdr.tabCreates, 1);
});

test('an unreadable dependency list blocks with the read problem, nothing written', async t => {
  const gh = world();
  gh.overrides.set('gh_dependencies_list', () => FakePiGh.err('rejected', 'GITHUB_READ'));
  const {h, herdr} = await harness(t, gh);
  const out = await h.invoke();
  assert.equal(out.r.status, 'blocked', JSON.stringify(out.r));
  assert.ok(out.r.problems.some(p => p.code === 'GITHUB_READ'), JSON.stringify(out.r.problems));
  assert.ok(out.r.problems.some(p => p.code === 'DEPENDENCIES_UNREADABLE'), JSON.stringify(out.r.problems));
  assert.equal(out.confirmCalls, 0);
  assert.equal(docOf(gh).stage, 'specification');
  noLaunch(herdr, gh);
});

test('a missing gh_dependencies_list capability stops before the approval is asked', async t => {
  const gh = world(); gh.operations = gh.operations.filter(o => o !== 'gh_dependencies_list');
  const {h, herdr} = await harness(t, gh);
  const out = await h.invoke();
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(p => p.code === 'CAPABILITY_MISSING' && p.path === 'gh_dependencies_list'), JSON.stringify(out.r.problems));
  assert.equal(out.confirmCalls, 0); noLaunch(herdr, gh);
});
