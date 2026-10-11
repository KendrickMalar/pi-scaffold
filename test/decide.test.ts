import test from 'node:test';
import assert from 'node:assert/strict';
import {CONTINUE_PROMPT, decide, INITIAL_PROGRESS, MAX_AUTO_CONTINUE, RETRY_DELAYS_MS, type Observation, type WatchEntry, type WatchProgress} from '../src/watch/decide.js';

const entry: WatchEntry = {ownerSessionId: 'parent', paneId: 'w9:p2', tabId: 'w9:t2', workspaceId: 'w9', targetSessionId: 'target-session', cwd: '/synthetic/repo', repo: 'example/demo', epicIssue: 10, targetStage: 'specification', addedAt: '2026-10-11T00:00:00.000Z'};
const transient = (at = 100): Observation => ({kind: 'idle', sessionConfirmed: true, tail: {kind: 'error', transient: true, message: 'fetch failed', at}});
const run = (obs: Observation, progress: WatchProgress = INITIAL_PROGRESS, now = 0) => decide(entry, progress, obs, now);
const types = (r: ReturnType<typeof decide>) => r.actions.map(a => a.type);

test('gone and exited notify once and stop watching', () => {
  for (const kind of ['gone', 'exited'] as const) {
    const r = run({kind});
    assert.deepEqual(types(r), ['notify', 'stop'], kind);
    assert.match((r.actions[0] as {text: string}).text, /^pi-scaffold: Epic #10（example\/demo・specification）: /);
  }
});

test('blocked notifies once; the same state again is silent; working clears the notice', () => {
  const first = run({kind: 'blocked'});
  assert.deepEqual(types(first), ['notify']);
  assert.equal((first.actions[0] as {level: string}).level, 'warning');
  assert.deepEqual(types(run({kind: 'blocked'}, first.next)), []);
  const working = run({kind: 'working'}, first.next);
  assert.deepEqual(types(working), []);
  assert.deepEqual(types(run({kind: 'blocked'}, working.next)), ['notify']);
});

test('a transient error is scheduled, then continued after the delay, and the count grows', () => {
  const scheduled = run(transient(), INITIAL_PROGRESS, 1_000);
  assert.deepEqual(types(scheduled), ['notify']);
  assert.equal(scheduled.next.pendingRetryAt, 1_000 + RETRY_DELAYS_MS[0]);
  assert.deepEqual(types(run(transient(), scheduled.next, 1_000 + RETRY_DELAYS_MS[0] - 1)), []);
  const sent = run(transient(), scheduled.next, 1_000 + RETRY_DELAYS_MS[0]);
  assert.deepEqual(sent.actions, [{type: 'prompt', text: CONTINUE_PROMPT, errorAt: 100}]);
  assert.equal(sent.next.retryCount, 1);
  assert.equal(sent.next.pendingRetryAt, undefined);
});

test('repeated errors exhaust: working does not reset the count, only a normal end does', () => {
  let p: WatchProgress = INITIAL_PROGRESS, now = 0;
  for (let i = 0; i < MAX_AUTO_CONTINUE; i++) {
    p = run(transient(100 + i), p, now).next;          // schedule
    now += RETRY_DELAYS_MS[i]!;
    const sent = run(transient(100 + i), p, now);      // send
    assert.equal(sent.actions[0]?.type, 'prompt', `attempt ${i + 1}`);
    p = run({kind: 'working'}, sent.next, now).next;   // the child ran, then failed again
  }
  assert.equal(p.retryCount, MAX_AUTO_CONTINUE);
  const exhausted = run(transient(999), p, now);
  assert.deepEqual(types(exhausted), ['notify']);
  assert.equal((exhausted.actions[0] as {level: string}).level, 'error');
  assert.deepEqual(types(run(transient(999), exhausted.next, now + 10 ** 7)), [], 'no more sends or notices for that error');
  const ended = run({kind: 'idle', sessionConfirmed: true, tail: {kind: 'stopped', reason: 'stop', at: 1000}}, exhausted.next, now);
  assert.equal(ended.next.retryCount, 0);
});

test('a prompt that did not take effect (same error still there) waits the next, longer delay', () => {
  const p = run(transient(), INITIAL_PROGRESS, 0).next;
  const sent = run(transient(), p, RETRY_DELAYS_MS[0]);
  const again = run(transient(), sent.next, RETRY_DELAYS_MS[0] + 60_000);
  assert.equal(again.next.pendingRetryAt, RETRY_DELAYS_MS[0] + 60_000 + RETRY_DELAYS_MS[1]);
  assert.deepEqual(types(again), ['notify']);
});

test('a non-transient error, an abort, a normal end and an unknown tail only notify, once each', () => {
  const cases: [Observation, string][] = [
    [{kind: 'idle', sessionConfirmed: true, tail: {kind: 'error', transient: false, message: '400 ' + 'x'.repeat(300), at: 5}}, 'error'],
    [{kind: 'idle', sessionConfirmed: true, tail: {kind: 'stopped', reason: 'aborted', at: 6}}, 'info'],
    [{kind: 'idle', sessionConfirmed: true, tail: {kind: 'stopped', reason: 'stop', at: 7}}, 'info'],
    [{kind: 'idle', sessionConfirmed: true, tail: {kind: 'unknown', reason: 'log-version'}}, 'warning'],
  ];
  for (const [obs, level] of cases) {
    const r = run(obs);
    assert.deepEqual(r.actions.map(a => [a.type, (a as {level?: string}).level]), [['notify', level]]);
    assert.ok((r.actions[0] as {text: string}).text.length < 220, 'error text is cut to 120 characters');
    assert.deepEqual(types(run(obs, r.next)), []);
  }
});

test('herdr failures notify once at the third in a row and reset on any good observation', () => {
  let p = INITIAL_PROGRESS;
  const seen: number[] = [];
  for (let i = 0; i < 5; i++) { const r = run({kind: 'unclear', reason: 'boom'}, p); seen.push(r.actions.length); p = r.next; }
  assert.deepEqual(seen, [0, 0, 1, 0, 0]);
  assert.equal(run({kind: 'working'}, p).next.herdrFailures, 0);
});

test('a stale schedule never sends on a newly seen error: it is rescheduled with a notice first', () => {
  const scheduled = run(transient(100), INITIAL_PROGRESS, 0);
  assert.equal(scheduled.next.pendingErrorAt, 100);
  const other = run({kind: 'idle', sessionConfirmed: true, tail: {kind: 'error', transient: false, message: '400 bad', at: 150}}, scheduled.next, 10);
  assert.deepEqual(types(other), ['notify']);
  const later = run(transient(200), other.next, RETRY_DELAYS_MS[0] * 10);
  assert.deepEqual(types(later), ['notify'], 'no prompt at first sight of at=200');
  assert.match((later.actions[0] as {text: string}).text, /1分後に自動で再開します/);
  assert.equal(later.next.pendingRetryAt, RETRY_DELAYS_MS[0] * 11);
  assert.equal(later.next.pendingErrorAt, 200);
  // Even if a schedule somehow survived, it applies only to its own error.
  const stale = run(transient(300), {...INITIAL_PROGRESS, pendingRetryAt: 5, pendingErrorAt: 100}, 1_000);
  assert.deepEqual(types(stale), ['notify']);
  assert.equal(stale.next.pendingErrorAt, 300);
});

test('every non-transient outcome clears the pending schedule', () => {
  const pending = run(transient(100), INITIAL_PROGRESS, 0).next;
  const outcomes: Observation[] = [
    {kind: 'blocked'}, {kind: 'working'}, {kind: 'gone'}, {kind: 'exited'}, {kind: 'replaced'},
    {kind: 'idle', sessionConfirmed: true, tail: {kind: 'unknown', reason: 'log-version'}},
    {kind: 'idle', sessionConfirmed: true, tail: {kind: 'error', transient: false, message: '400 bad', at: 150}},
    {kind: 'idle', sessionConfirmed: true, tail: {kind: 'stopped', reason: 'stop', at: 160}},
  ];
  for (const obs of outcomes) {
    const r = run(obs, pending, 10);
    assert.equal(r.next.pendingRetryAt, undefined, obs.kind);
    assert.equal(r.next.pendingErrorAt, undefined, obs.kind);
  }
});

test('replaced: another session runs in the pane, a warning and stop', () => {
  const r = run({kind: 'replaced'});
  assert.deepEqual(types(r), ['notify', 'stop']);
  assert.equal((r.actions[0] as {level: string}).level, 'warning');
  assert.match((r.actions[0] as {text: string}).text, /下位の pane で別のセッションが動いています。監視を終えます。$/);
});

test('a transient error in a pane whose session is unconfirmed is notified once and never continued', () => {
  const obs: Observation = {kind: 'idle', sessionConfirmed: false, tail: {kind: 'error', transient: true, message: 'fetch failed', at: 100}};
  const first = run(obs, INITIAL_PROGRESS, 0);
  assert.deepEqual(types(first), ['notify']);
  assert.equal(first.next.pendingRetryAt, undefined);
  assert.match((first.actions[0] as {text: string}).text, /セッションを確認できないため、自動再開はしません: fetch failed$/);
  assert.deepEqual(types(run(obs, first.next, RETRY_DELAYS_MS[2] * 2)), []);
  // A schedule made while the session was confirmed is dropped once it no longer is.
  const scheduled = run(transient(100), INITIAL_PROGRESS, 0).next;
  const dropped = run(obs, scheduled, RETRY_DELAYS_MS[0]);
  assert.deepEqual(types(dropped), ['notify']);
  assert.equal(dropped.next.pendingRetryAt, undefined);
});
