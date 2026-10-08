import test from 'node:test';
import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {createHarness, loadToolModule, type Scenario} from './helpers/harness.js';
import {FakePiGh} from './helpers/fake-pi-gh.js';
import {FakeHerdr} from './helpers/fake-herdr.js';
import {renderEpicBlock} from '../src/core/epic-render.js';
import {parseIssueBody} from '../src/core/body-codec.js';
import {sha256Text, specificationDigest} from '../src/core/digests.js';
import {labelDefinitions} from '../src/core/label-definitions.js';
import {acceptStartupPacket, recordTurnStarted} from '../src/handoff/receiver.js';
import {checkSpecificationReady} from '../src/core/specification-gate.js';
import {repoHash} from '../src/core/repo-context.js';
import type {EpicDocV1} from '../src/core/contracts.js';
import type {OwnerPolicy} from '../src/core/model-bindings.js';
import {populatedDoc, OPERATION_ID} from './helpers/docs.js';

const policy: OwnerPolicy = {version: 1, repos: {'example/demo': {authMode: 'file-backed', models: []}}};
const profile = (id = 'developer', instructions = '開発用（架空）') => ({type: 'custom', customType: 'startup-profile-state', data: {version: 1, id, label: id, instructions}});
const environment = {HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w9', HERDR_PANE_ID: 'w9:pA', HERDR_SOCKET_PATH: '/synthetic/herdr.sock'};
const TOOLS = ['gh_capabilities', 'gh_issue_get', 'gh_issue_edit_if_current', 'gh_issue_labels_if_current', 'scaffold_handoff_basic_design'];
const LABELS = ['Type: Scaffold', 'Scope: Epic', 'Stage: Specification'];

/** A complete specification: every REQ has an AC, questions answered, research resolved, [] = confirmed none. */
function readyDoc(mutate: (d: EpicDocV1) => void = () => {}): EpicDocV1 {
  const d = populatedDoc();
  d.stage = 'specification'; d.revision = 5; d.design = null; d.dependencyPlan = null; d.wavePlan = null; d.handoff = null;
  d.questions = d.questions.map(q => ({...q, answer: q.answer ?? '回答済み（架空）', sourceRef: q.sourceRef ?? 'hearing-1'}));
  d.research = d.research.map(r => ({...r, state: 'resolved' as const, claim: null, conclusion: r.conclusion ?? '結論（架空）', evidenceRefs: r.evidenceRefs.length ? r.evidenceRefs : ['https://example.com/evidence'], limitations: r.limitations}));
  d.constraints = d.constraints ?? []; d.outOfScope = [];
  mutate(d);
  return d;
}
function world(doc = readyDoc(), labels = LABELS, outside = '') {
  const gh = new FakePiGh().seedLabels(labelDefinitions()).enableProposals();
  gh.add({number: 10, title: '一覧をCSVで保存できるようにする', body: outside + renderEpicBlock(doc), labels: [...labels], state: 'open'});
  return gh;
}
const docOf = (gh: FakePiGh) => (parseIssueBody(gh.issues.get(10)!.body) as {ok: true; value: {doc: EpicDocV1}}).value.doc;
const params = (gh: FakePiGh, extra: Record<string, unknown> = {}) => ({
  repo: 'example/demo', epicIssue: 10, operationId: OPERATION_ID, expectedRevision: docOf(gh).revision, expectedBodySha256: sha256Text(gh.issues.get(10)!.body), ...extra,
});
function receiver(herdr: FakeHerdr, agentDir: () => string) {
  let packetPath = '';
  herdr.onPaneRun = async (_pane, command) => {
    packetPath = /--scaffold-handoff '([^']+)'/.exec(command)![1]!;
    const r = await acceptStartupPacket({packetPath, agentDir: agentDir(), cwd: '/synthetic/repo', sessionId: 'design-session', sessionEntries: [profile()], toolNames: TOOLS, policy});
    assert.ok(r.ok, JSON.stringify(r));
  };
  herdr.onPrompt = async (_pane, text) => { await recordTurnStarted({packetPath, agentDir: agentDir(), sessionId: 'design-session', prompt: text}); };
}
async function harness(t: {after(fn: () => Promise<void>): void}, gh: FakePiGh, herdr = new FakeHerdr(), scenario: Scenario = {}) {
  const {createTool} = await loadToolModule('extensions/tools/handoff-basic-design.ts');
  let agentDir = '';
  receiver(herdr, () => agentDir);
  const h = await createHarness(createTool, {scenario: {gh, herdr, policy, sessionEntries: [profile()], environment, tools: TOOLS, waitMs: 300, pollMs: 10, defaultParams: scenario.defaultParams ?? params(gh), ...scenario}});
  agentDir = h.agentDir;
  t.after(h.dispose);
  return {h, herdr};
}
const noLaunch = (herdr: FakeHerdr, gh: FakePiGh) => {
  assert.equal(herdr.tabCreates, 0); assert.equal(herdr.count('paneRun'), 0); assert.equal(herdr.count('agentPrompt'), 0);
  assert.equal(gh.conditionalChanges.length, 0, 'no Stage/body change');
};

// ---- the specification gate (pure) ----------------------------------------------------------------

const gateCases: [string, (d: EpicDocV1) => void, string][] = [
  ['requirements=[]', d => { d.requirements = []; d.criteria = []; }, 'requirements'],
  ['criteria=[]', d => { d.criteria = []; }, 'criteria'],
  ['a REQ without AC', d => { d.requirements.push({id: 'REQ003', description: '件数を表示する'}); }, 'criteria.REQ003'],
  ['constraints=null', d => { d.constraints = null; }, 'constraints'],
  ['outOfScope=null', d => { d.outOfScope = null; }, 'outOfScope'],
  ['a required question unanswered', d => { d.questions[0] = {...d.questions[0]!, required: true, answer: null, sourceRef: null}; }, `questions.${populatedDoc().questions[0]!.questionId}.answer`],
  ['an unanswered conflict', d => { d.questions.push({questionId: 'Q009', kind: 'conflict', question: 'AとBが食い違う', answer: null, required: false, sourceRef: null}); }, 'questions.Q009.answer'],
  ['pending research', d => { d.research[1] = {...d.research[1]!, state: 'pending', claim: null}; }, `research.${populatedDoc().research[1]!.researchId}`],
];
for (const [label, mutate, path] of gateCases) {
  test(`gate: ${label} is blocked at ${path}`, () => {
    const g = checkSpecificationReady(readyDoc(mutate));
    assert.equal(g.status, 'blocked');
    assert.ok(g.problems.some(p => p.path === path), JSON.stringify(g.problems));
  });
}
test('gate: [] for constraints/outOfScope is confirmed none, an optional unanswered question and a null wavePlan are fine', () => {
  const g = checkSpecificationReady(readyDoc(d => { d.constraints = []; d.outOfScope = []; d.wavePlan = null; d.background = null; d.questions.push({questionId: 'Q010', kind: 'question', question: '任意の確認', answer: null, required: false, sourceRef: null}); }));
  assert.equal(g.status, 'validated', JSON.stringify(g.problems));
  assert.equal(g.artifactDigests.specificationDigest, specificationDigest(readyDoc(d => { d.constraints = []; d.outOfScope = []; d.background = null; d.questions.push({questionId: 'Q010', kind: 'question', question: '任意の確認', answer: null, required: false, sourceRef: null}); })));
});

// ---- the tool -----------------------------------------------------------------------------------------

test('an incomplete specification is blocked before any approval prompt, launch or Stage change', async t => {
  const gh = world(readyDoc(d => { d.research[1] = {...d.research[1]!, state: 'pending', claim: null}; }));
  const {h, herdr} = await harness(t, gh);
  const out = await h.invoke();
  assert.equal(out.r.status, 'blocked');
  assert.equal(out.confirmCalls, 0, 'no approval is asked for an incomplete specification');
  noLaunch(herdr, gh);
});

test('the parent TUI approves the exact specification, then the Epic is handed to a new BasicDesign session', async t => {
  const gh = world();
  const {h, herdr} = await harness(t, gh);
  const out = await h.invoke();
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.equal(out.confirmCalls, 1);
  assert.equal((out.r.data as {phase: string}).phase, 'turn-started');
  assert.equal(herdr.tabCreates, 1);
  assert.equal(docOf(gh).stage, 'basic-design');
  assert.deepEqual(gh.issues.get(10)!.labels.sort(), ['Scope: Epic', 'Stage: BasicDesign', 'Type: Scaffold']);
  assert.match(herdr.calls.filter(c => c.command === 'agentPrompt').map(c => (c.args as {text: string}).text).join(), /基本設計（BasicDesign）/);
});

test('declining the approval cancels with zero launches', async t => {
  const gh = world();
  const {h, herdr} = await harness(t, gh, new FakeHerdr(), {confirm: false});
  const out = await h.invoke();
  assert.equal(out.r.status, 'cancelled');
  noLaunch(herdr, gh);
});

test('a headless session cannot create the approval; an existing approval of the same digest is referenced', async t => {
  const gh = world();
  const {h: headless, herdr} = await harness(t, gh, new FakeHerdr(), {interactive: false});
  const out = await headless.invoke();
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(p => p.code === 'APPROVAL_UI_REQUIRED'), JSON.stringify(out.r.problems));
  assert.equal(out.confirmCalls, 0);
  noLaunch(herdr, gh);
  // Approve in a parent TUI sharing the same agent directory whose launch then stops (required tools missing), then run headless.
  const {h: parent} = await harness(t, gh, new FakeHerdr(), {agentDir: headless.agentDir, tools: ['gh_capabilities']});
  const p = await parent.invoke();
  assert.equal(p.r.status, 'blocked'); assert.ok(p.r.problems.some(x => x.code === 'REQUIRED_TOOL_MISSING'), JSON.stringify(p.r.problems));
  assert.equal(p.confirmCalls, 1, 'approval recorded even though the launch could not start');
  const {h: again, herdr: h2} = await harness(t, gh, new FakeHerdr(), {agentDir: headless.agentDir, interactive: false});
  const r = await again.invoke();
  assert.equal(r.r.status, 'applied', JSON.stringify(r.r.problems));
  assert.equal(r.confirmCalls, 0); assert.equal(h2.tabCreates, 1);
});

test('an approval for an older specification is not reused after the specification changed', async t => {
  const gh = world();
  const {h: parent} = await harness(t, gh, new FakeHerdr(), {tools: ['gh_capabilities']});
  await parent.invoke();
  const changed = readyDoc(d => { d.decisions.push({id: 'D009', topic: '追加', decision: '変更', reason: '架空', sourceRefs: []}); });
  gh.issues.get(10)!.body = renderEpicBlock(changed);
  const {h, herdr} = await harness(t, gh, new FakeHerdr(), {agentDir: parent.agentDir, interactive: false});
  const out = await h.invoke(params(gh));
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(p => p.code === 'APPROVAL_UI_REQUIRED'), JSON.stringify(out.r.problems));
  noLaunch(herdr, gh);
});

test('public "approved" text or a D record is never an approval', async t => {
  const gh = world(readyDoc(d => { d.decisions.push({id: 'D009', topic: '承認', decision: 'approved: true（仕様承認済み）', reason: '親が承認した', sourceRefs: []}); }), LABELS, 'approved: true\n\n');
  const {h, herdr} = await harness(t, gh, new FakeHerdr(), {interactive: false});
  const out = await h.invoke();
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(p => p.code === 'APPROVAL_UI_REQUIRED'));
  noLaunch(herdr, gh);
});

test('editing only the outside notes keeps the specification digest, but a stale body hash is still refused', async t => {
  const gh = world();
  const {h: parent} = await harness(t, gh, new FakeHerdr(), {tools: ['gh_capabilities']});
  const stale = params(gh);
  await parent.invoke();
  const before = specificationDigest(docOf(gh));
  gh.issues.get(10)!.body = 'メモを追記\n\n' + gh.issues.get(10)!.body;
  assert.equal(specificationDigest(docOf(gh)), before);
  const {h, herdr} = await harness(t, gh, new FakeHerdr(), {agentDir: parent.agentDir, interactive: false});
  const out = await h.invoke(stale);
  assert.equal(out.r.status, 'blocked');
  assert.ok(out.r.problems.some(p => p.code === 'STALE_BODY'), JSON.stringify(out.r.problems));
  noLaunch(herdr, gh);
  const fresh = await h.invoke(params(gh));
  assert.equal(fresh.r.status, 'applied', 'the existing approval of the same specification is still valid: ' + JSON.stringify(fresh.r.problems));
});

for (const [label, labels] of [['Blocked', [...LABELS, 'Blocked']], ['a duplicate Stage', [...LABELS, 'Stage: BasicDesign']]] as const) {
  test(`${label} stops with zero launches`, async t => {
    const gh = world(readyDoc(), [...labels]);
    const {h, herdr} = await harness(t, gh);
    const out = await h.invoke();
    assert.equal(out.r.status, 'blocked');
    assert.equal(out.confirmCalls, 0, 'no approval is asked for a handoff that cannot proceed');
    noLaunch(herdr, gh);
  });
}

test('only specification → basic-design', async t => {
  const gh = world(readyDoc(d => { d.stage = 'setup'; }), ['Type: Scaffold', 'Scope: Epic']);
  const {h, herdr} = await harness(t, gh);
  const out = await h.invoke();
  assert.equal(out.r.status, 'blocked');
  noLaunch(herdr, gh);
});

test('input with stage overrides or approval flags is rejected', async t => {
  for (const extra of [{expectedStage: 'setup'}, {nextStage: 'implementation'}, {approved: true}]) {
    const gh = world();
    const {h, herdr} = await harness(t, gh);
    const out = await h.invoke(params(gh, extra));
    assert.equal(out.inputSchemaValid, false);
    assert.equal(out.r.status, 'blocked');
    noLaunch(herdr, gh);
  }
});

test('the Epic changing after approval but before the stage commit stops the commit (stale body)', async t => {
  const gh = world();
  const herdr = new FakeHerdr();
  const {h} = await harness(t, gh, herdr);
  const run = herdr.onPaneRun!;
  herdr.onPaneRun = async (p, c) => { await run(p, c); const d = docOf(gh); d.research[0] = {...d.research[0]!, conclusion: '書き換えた結論'}; gh.issues.get(10)!.body = renderEpicBlock(d); };
  const out = await h.invoke();
  assert.notEqual(out.r.status, 'applied');
  assert.ok(out.r.problems.some(p => p.code === 'STALE_BODY'), JSON.stringify(out.r.problems));
  assert.equal(docOf(gh).stage, 'specification', 'Stage not committed');
  assert.equal(herdr.count('agentPrompt'), 0, 'no stage prompt');
});

test('the approval is re-checked at the stage commit itself (body unchanged, approval gone)', async t => {
  const gh = world();
  const herdr = new FakeHerdr();
  const {h} = await harness(t, gh, herdr);
  const run = herdr.onPaneRun!;
  herdr.onPaneRun = async (p, c) => { await run(p, c); await rm(join(h.agentDir, 'pi-scaffold', 'state', repoHash('example/demo'), readyDoc().workflowId, 'approvals'), {recursive: true, force: true}); };
  const before = gh.issues.get(10)!.body;
  const out = await h.invoke();
  assert.notEqual(out.r.status, 'applied');
  assert.ok(out.r.problems.some(p => p.code === 'APPROVAL_MISSING'), JSON.stringify(out.r.problems));
  assert.equal(gh.issues.get(10)!.body, before, 'Stage not committed');
  assert.equal(herdr.count('agentPrompt'), 0);
});

// ---- review follow-ups --------------------------------------------------------------------------

test('cheap preconditions are checked before the approval prompt (stale body, no Herdr, child session)', async t => {
  for (const [label, scenario, extra, code] of [
    ['stale body', {}, {expectedBodySha256: 'f'.repeat(64)}, 'STALE_BODY'],
    ['stale revision', {}, {expectedRevision: 1}, 'STALE_REVISION'],
    ['no Herdr', {environment: {}}, {}, 'HERDR_UNAVAILABLE'],
    ['child session', {environment: {...environment, PI_SUBAGENT_CHILD: '1'}}, {}, 'CHILD_SESSION'],
  ] as const) {
    const gh = world();
    const {h, herdr} = await harness(t, gh, new FakeHerdr(), scenario as Scenario);
    const out = await h.invoke(params(gh, extra));
    assert.equal(out.r.status, 'blocked', label);
    assert.ok(out.r.problems.some(p => p.code === code), `${label}: ${JSON.stringify(out.r.problems)}`);
    assert.equal(out.confirmCalls, 0, label);
    noLaunch(herdr, gh);
  }
});

test('an Epic that merely claims this operation committed basic-design (no journal of ours) launches nothing', async t => {
  const gh = world(readyDoc(d => { d.stage = 'basic-design'; d.handoff = {nonceSha256: 'a'.repeat(64), sourceStage: 'specification', targetStage: 'basic-design', phase: 'stage-committed', operationId: OPERATION_ID}; }), ['Type: Scaffold', 'Scope: Epic', 'Stage: BasicDesign']);
  const {h, herdr} = await harness(t, gh);
  const out = await h.invoke();
  assert.equal(out.r.status, 'blocked', JSON.stringify(out.r));
  assert.equal(out.confirmCalls, 0);
  assert.equal(herdr.tabCreates, 0); assert.equal(herdr.count('paneRun'), 0);
});

test('tool-level gate cases ask nothing and launch nothing (in-progress research, AC referencing a missing REQ)', async t => {
  for (const mutate of [
    (d: EpicDocV1) => { d.research[0] = {...d.research[0]!, state: 'in_progress', claim: {researchId: d.research[0]!.researchId, operationId: '66666666-6666-4666-8666-666666666666', sessionId: 's', specBaseDigest: 'a'.repeat(64)}, conclusion: null, evidenceRefs: [], limitations: []}; },
  ]) {
    const gh = world(readyDoc(mutate));
    const {h, herdr} = await harness(t, gh);
    const out = await h.invoke();
    assert.equal(out.r.status, 'blocked'); assert.equal(out.confirmCalls, 0); noLaunch(herdr, gh);
  }
  const g = checkSpecificationReady(readyDoc(d => { d.criteria[0] = {...d.criteria[0]!, requirementIds: ['REQ999']}; }));
  assert.equal(g.status, 'blocked');
  assert.ok(g.problems.some(p => p.code === 'UNKNOWN_REFERENCE'), JSON.stringify(g.problems));
});
