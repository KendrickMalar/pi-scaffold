import test from 'node:test';
import assert from 'node:assert/strict';
import {IDLE_GRACE_MS, MAX_NUDGES_PER_STAGE, MAX_NUDGES_PER_STOP, MAX_RELAUNCH, NUDGE_PROMPT, NUDGE_RETRY_MS, RELAUNCH_GAP_MS, planTarget} from '../src/watchdog/plan.js';
import {initialTargetState, type PaneObservation, type Target, type TargetObservation, type TargetState} from '../src/watchdog/types.js';
import {CONTINUE_PROMPT, RETRY_DELAYS_MS} from '../src/watch/decide.js';
import type {TailResult} from '../src/watch/session-tail.js';

const SESSION_PATH = '/home/u/.pi/agent/sessions/--repo--/2026-10-18T00-00-00-000Z_s1.jsonl';
const target = (o: Partial<Target> = {}): Target => ({key: 's1', agent: 'pi', repo: 'example/demo', epicIssue: 7, targetStage: 'implementation', cwd: '/repo', sessionId: 's1', handoffAt: 0, ...o});
const stopped = (at = 100): TailResult => ({kind: 'stopped', reason: 'stop', at});
const idle = (o: Partial<Extract<PaneObservation, {kind: 'agent'}>> = {}): PaneObservation => ({kind: 'agent', socket: '/s.sock', paneId: 'w1:p2', status: 'idle', revision: 5, sessionPath: SESSION_PATH, tail: stopped(), ...o});
const obs = (pane: PaneObservation, o: Partial<TargetObservation> = {}): TargetObservation => ({epic: {stageLabel: 'Stage: Implementation', closed: false}, pane, ownerAlive: false, ...o});

/** Runs ticks in order and returns every action with the final state. */
function run(t: Target, steps: {obs: TargetObservation; now: number}[], start: TargetState = initialTargetState()) {
  let s = start; const all = [];
  for (const step of steps) { const r = planTarget(t, step.obs, s, step.now); all.push(...r.actions); s = r.next; }
  return {actions: all, state: s};
}
const prompts = (a: {type: string}[]) => a.filter(x => x.type === 'prompt') as Extract<ReturnType<typeof planTarget>['actions'][number], {type: 'prompt'}>[];

test('a stage whose Epic moved on or closed is retired and never prompted', () => {
  for (const [epic, reason] of [[{stageLabel: 'Stage: Verification', closed: false}, 'later'], [{stageLabel: 'Stage: Implementation', closed: true}, 'closed'], [{stageLabel: 'Stage: Completed', closed: false}, 'later'], [{stageLabel: 'Stage: BasicDesign', closed: true}, 'closed']] as const) {
    const r = run(target(), [{obs: obs(idle(), {epic}), now: 0}, {obs: obs(idle(), {epic}), now: IDLE_GRACE_MS * 10}]);
    assert.equal(prompts(r.actions).length, 0);
    assert.equal(r.state.retired, true);
    assert.equal(r.state.retiredReason, reason);
    assert.deepEqual(r.actions.filter(a => a.type === 'log').map(a => (a as {event: string}).event), ['retired']);
  }
});

test('an Epic still labelled with an earlier stage has not started this one: watched, logged once, never retired', () => {
  for (const stageLabel of ['Stage: BasicDesign', 'Stage: Specification', undefined]) {
    const epic = stageLabel ? {stageLabel, closed: false} : {closed: false};
    const r = run(target(), [{obs: obs(idle(), {epic}), now: 0}, {obs: obs(idle(), {epic}), now: 1}, {obs: obs(idle(), {epic}), now: IDLE_GRACE_MS}]);
    assert.equal(r.state.retired, undefined);
    assert.equal(r.actions.filter(a => a.type === 'log' && a.event === 'stage-not-yet').length, 1);
    assert.equal(prompts(r.actions).length, 1, 'the pane is still looked after');
  }
});

test('an unknown stage label never retires the stage', () => {
  const epic = {stageLabel: 'Stage: Something', closed: false};
  const r = run(target(), [{obs: obs(idle(), {epic}), now: 0}, {obs: obs(idle(), {epic}), now: 1}]);
  assert.equal(r.state.retired, undefined);
  assert.equal(r.actions.filter(a => a.type === 'log' && a.event === 'stage-unknown').length, 1);
});

test('a stage retired by the old rule (no reason) is judged again: back when the label is earlier, kept with a reason when later', () => {
  const old = {...initialTargetState(), retired: true, nudges: 1};
  const back = run(target(), [{obs: obs(idle(), {epic: {stageLabel: 'Stage: BasicDesign', closed: false}}), now: 0}], old);
  assert.equal(back.state.retired, undefined);
  assert.equal(back.state.nudges, 1);
  assert.ok(back.actions.some(a => a.type === 'log' && a.event === 'unretired'));
  const kept = run(target(), [{obs: obs(idle(), {epic: {stageLabel: 'Stage: Verification', closed: false}}), now: 0}], old);
  assert.equal(kept.state.retired, true);
  assert.equal(kept.state.retiredReason, 'later');
  const unknown = run(target(), [{obs: obs(idle(), {epic: 'unknown'}), now: 0}], old);
  assert.equal(unknown.state.retired, true);
  assert.equal(unknown.state.retiredReason, undefined, 'judged again on a later tick');
  const fixed = {...initialTargetState(), retired: true, retiredReason: 'later' as const};
  const still = run(target(), [{obs: obs(idle()), now: 0}], fixed);
  assert.equal(still.state.retired, true);
  assert.equal(still.actions.length, 0);
});

test('an unreadable Epic is never acted on', () => {
  const r = run(target(), [{obs: obs(idle(), {epic: 'unknown'}), now: 0}, {obs: obs(idle(), {epic: 'unknown'}), now: IDLE_GRACE_MS * 2}]);
  assert.equal(prompts(r.actions).length, 0);
  assert.equal(r.state.retired, undefined);
});

test('specification waits for the human: idle is never prompted', () => {
  const t = target({targetStage: 'specification'});
  const r = run(t, [{obs: obs(idle(), {epic: {stageLabel: 'Stage: Specification', closed: false}}), now: 0}, {obs: obs(idle(), {epic: {stageLabel: 'Stage: Specification', closed: false}}), now: IDLE_GRACE_MS * 3}]);
  assert.equal(prompts(r.actions).length, 0);
});

test('an unfinished stage that went idle is prompted once after the grace period', () => {
  const early = run(target(), [{obs: obs(idle()), now: 0}, {obs: obs(idle()), now: IDLE_GRACE_MS - 1}]);
  assert.equal(prompts(early.actions).length, 0);
  const r = run(target(), [{obs: obs(idle()), now: 0}, {obs: obs(idle()), now: IDLE_GRACE_MS}, {obs: obs(idle()), now: IDLE_GRACE_MS + 1}]);
  assert.deepEqual(prompts(r.actions).map(p => ({text: p.text, revision: p.revision, paneId: p.paneId, reason: p.reason})), [{text: NUDGE_PROMPT, revision: 5, paneId: 'w1:p2', reason: 'nudge'}]);
});

test('the grace period restarts when the pane changes', () => {
  const r = run(target(), [{obs: obs(idle()), now: 0}, {obs: obs(idle({revision: 6})), now: IDLE_GRACE_MS}, {obs: obs(idle({revision: 6})), now: IDLE_GRACE_MS + 10}]);
  assert.equal(prompts(r.actions).length, 0);
});

test('one stop gets at most MAX_NUDGES_PER_STOP prompts, spaced by NUDGE_RETRY_MS', () => {
  const steps = [0, IDLE_GRACE_MS, IDLE_GRACE_MS + NUDGE_RETRY_MS - 1, IDLE_GRACE_MS + NUDGE_RETRY_MS, IDLE_GRACE_MS + NUDGE_RETRY_MS * 5].map(now => ({obs: obs(idle()), now}));
  const r = run(target(), steps);
  assert.equal(prompts(r.actions).length, MAX_NUDGES_PER_STOP);
  assert.ok(r.actions.some(a => a.type === 'log' && a.event === 'nudge-exhausted'));
});

test('a stage gets at most MAX_NUDGES_PER_STAGE prompts in total', () => {
  const steps = [];
  let now = 0;
  for (let i = 0; i < MAX_NUDGES_PER_STAGE + 3; i++) {
    steps.push({obs: obs(idle({revision: i, tail: stopped(i)})), now}); now += IDLE_GRACE_MS;
    steps.push({obs: obs(idle({revision: i, tail: stopped(i)})), now}); now += 1;
  }
  const r = run(target(), steps);
  assert.equal(prompts(r.actions).length, MAX_NUDGES_PER_STAGE);
  assert.ok(r.actions.some(a => a.type === 'log' && a.event === 'stage-exhausted'));
});

test('an aborted turn (the human pressed Esc) is left alone', () => {
  const tail: TailResult = {kind: 'stopped', reason: 'aborted', at: 1};
  const r = run(target(), [{obs: obs(idle({tail})), now: 0}, {obs: obs(idle({tail})), now: IDLE_GRACE_MS * 3}]);
  assert.equal(prompts(r.actions).length, 0);
});

test('working and blocked panes are not prompted', () => {
  for (const status of ['working', 'blocked']) {
    const r = run(target(), [{obs: obs(idle({status})), now: 0}, {obs: obs(idle({status})), now: IDLE_GRACE_MS * 3}]);
    assert.equal(prompts(r.actions).length, 0, status);
  }
});

test('a transient error with a live owner is left to the in-process watcher', () => {
  const tail: TailResult = {kind: 'error', transient: true, message: 'fetch failed', at: 9};
  const r = run(target({ownerSessionId: 'o'}), [{obs: obs(idle({tail}), {ownerAlive: true}), now: 0}, {obs: obs(idle({tail}), {ownerAlive: true}), now: RETRY_DELAYS_MS[0] * 3}]);
  assert.equal(prompts(r.actions).length, 0);
  assert.ok(r.actions.some(a => a.type === 'log' && a.event === 'transient-delegated'));
});

test('a transient error without a live owner reuses the stage watcher schedule', () => {
  const tail: TailResult = {kind: 'error', transient: true, message: 'fetch failed', at: 9};
  const r = run(target(), [{obs: obs(idle({tail})), now: 0}, {obs: obs(idle({tail})), now: RETRY_DELAYS_MS[0] - 1}, {obs: obs(idle({tail})), now: RETRY_DELAYS_MS[0]}]);
  assert.deepEqual(prompts(r.actions).map(p => [p.text, p.reason]), [[CONTINUE_PROMPT, 'transient']]);
  assert.equal(r.state.watch.retryCount, 1);
});

test('a non-transient error is logged once and not prompted', () => {
  const tail: TailResult = {kind: 'error', transient: false, message: 'usage limit', at: 9};
  const r = run(target(), [{obs: obs(idle({tail})), now: 0}, {obs: obs(idle({tail})), now: IDLE_GRACE_MS * 3}]);
  assert.equal(prompts(r.actions).length, 0);
  assert.equal(r.actions.filter(a => a.type === 'log' && a.event === 'error').length, 1);
});

test('a pi pane back at its shell is relaunched through the shim with its session', () => {
  const r = run(target(), [{obs: obs(idle()), now: 0}, {obs: obs({kind: 'shell', socket: '/s.sock', paneId: 'w1:p2'}), now: 1000}]);
  assert.deepEqual(r.actions.filter(a => a.type === 'relaunch'), [{type: 'relaunch', socket: '/s.sock', paneId: 'w1:p2', command: `pi --session '${SESSION_PATH}'`}]);
});

test('a claude pane back at its shell is resumed by session id', () => {
  const t = target({agent: 'claude', sessionId: 'c7f1a0de-0000-4000-8000-000000000001', key: 'c7f1a0de-0000-4000-8000-000000000001'});
  const r = run(t, [{obs: obs({kind: 'shell', socket: '/s.sock', paneId: 'w1:p2'}), now: 0}]);
  assert.deepEqual(r.actions.filter(a => a.type === 'relaunch').map(a => (a as {command: string}).command), [`claude --resume 'c7f1a0de-0000-4000-8000-000000000001'`]);
});

test('relaunches are spaced and capped', () => {
  const shell = obs({kind: 'shell', socket: '/s.sock', paneId: 'w1:p2'});
  const steps = [{obs: obs(idle()), now: 0}];
  for (let i = 0; i <= MAX_RELAUNCH + 1; i++) steps.push({obs: shell, now: 1 + i * RELAUNCH_GAP_MS}, {obs: shell, now: 2 + i * RELAUNCH_GAP_MS});
  const r = run(target(), steps);
  assert.equal(r.actions.filter(a => a.type === 'relaunch').length, MAX_RELAUNCH);
  assert.ok(r.actions.some(a => a.type === 'log' && a.event === 'relaunch-exhausted'));
});

test('a session path that is unsafe to type is never relaunched', () => {
  const r = run(target(), [{obs: obs(idle({sessionPath: "/x/it's;rm.jsonl"})), now: 0}, {obs: obs({kind: 'shell', socket: '/s.sock', paneId: 'w1:p2'}), now: 1}]);
  assert.equal(r.actions.filter(a => a.type === 'relaunch').length, 0);
  assert.ok(r.actions.some(a => a.type === 'log' && a.event === 'relaunch-refused'));
});

test('a missing pane is logged once', () => {
  const r = run(target(), [{obs: obs({kind: 'missing'}), now: 0}, {obs: obs({kind: 'missing'}), now: 1}]);
  assert.deepEqual(r.actions, [{type: 'log', event: 'missing'}]);
});
