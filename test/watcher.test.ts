import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StageWatcher} from '../src/watch/watcher.js';
import {WatchRegistry} from '../src/watch/registry.js';
import {CONTINUE_PROMPT, RETRY_DELAYS_MS, type WatchEntry} from '../src/watch/decide.js';
import type {TailResult} from '../src/watch/session-tail.js';
import {FakeHerdr} from './helpers/fake-herdr.js';

const entry = (paneId = 'w9:p2', owner = 'parent'): WatchEntry => ({ownerSessionId: owner, paneId, tabId: 'w9:t2', workspaceId: 'w9', targetSessionId: `s-${paneId}`, cwd: '/synthetic/repo', repo: 'example/demo', epicIssue: 10, targetStage: 'specification', addedAt: '2026-10-11T00:00:00.000Z'});
/** The session Herdr reports for a pane whose pi is the handed-off target. */
const mine = (paneId = 'w9:p2') => ({kind: 'id', value: `s-${paneId}`});
const fetchFailed: TailResult = {kind: 'error', transient: true, message: 'fetch failed', at: 100};

async function setup(t: {after(fn: () => Promise<void>): void}, opts: {owner?: string} = {}) {
  const agentDir = await mkdtemp(join(tmpdir(), 'pi-scaffold-watcher-'));
  t.after(() => rm(agentDir, {recursive: true, force: true}));
  const herdr = new FakeHerdr();
  const registry = new WatchRegistry(agentDir);
  const notices: {text: string; level: string}[] = [];
  const timers: {fn: () => void; ms: number}[] = [];
  let cleared = 0;
  const state = {now: 0, tails: [] as TailResult[], lastTail: fetchFailed as TailResult};
  const watcher = new StageWatcher({
    ownerSessionId: opts.owner ?? 'parent', registry, herdr, now: () => state.now,
    readTail: async () => { state.lastTail = state.tails.shift() ?? state.lastTail; return state.lastTail; },
    notify: (text, level) => notices.push({text, level}),
    setInterval: (fn, ms) => { timers.push({fn, ms}); return timers.length; },
    clearInterval: () => { cleared += 1; },
  });
  return {herdr, registry, notices, timers, state, watcher, cleared: () => cleared};
}

test('add registers the pane and starts one 60-second timer', async t => {
  const s = await setup(t);
  await s.watcher.add(entry()); await s.watcher.add(entry());
  assert.equal(s.timers.length, 1);
  assert.equal(s.timers[0]!.ms, 60_000);
  assert.equal(s.watcher.active, true);
  assert.equal((await s.registry.load()).records.length, 1);
});

test('a transient error: notice first, then exactly one continue after the delay', async t => {
  const s = await setup(t);
  s.herdr.panes.set('w9:p2', {exists: true, agent: 'pi', status: 'idle', session: mine()});
  await s.watcher.add(entry());
  await s.watcher.tick();
  assert.equal(s.herdr.count('agentPrompt'), 0);
  assert.equal(s.notices.length, 1);
  s.state.now = RETRY_DELAYS_MS[0];
  await s.watcher.tick();
  assert.deepEqual(s.herdr.calls.filter(c => c.command === 'agentPrompt').map(c => c.args), [{paneId: 'w9:p2', text: CONTINUE_PROMPT}]);
  assert.match(s.notices.at(-1)!.text, /自動で再開を送りました（1\/3回目）/);
  assert.equal((await s.registry.load()).records[0]!.progress.retryCount, 1, 'progress survives a restart');
});

test('precheck mismatch: if the child moved on before sending, nothing is sent and progress is kept', async t => {
  const s = await setup(t);
  s.herdr.panes.set('w9:p2', {exists: true, agent: 'pi', status: 'idle', session: mine()});
  await s.watcher.add(entry());
  await s.watcher.tick();
  s.state.now = RETRY_DELAYS_MS[0];
  s.state.tails = [fetchFailed, {kind: 'stopped', reason: 'stop', at: 200}];
  await s.watcher.tick();
  assert.equal(s.herdr.count('agentPrompt'), 0);
  const {progress} = (await s.registry.load()).records[0]!;
  assert.equal(progress.retryCount, 0);
  assert.equal(progress.pendingRetryAt, undefined, 'no stale schedule is left behind');
  assert.equal(progress.pendingErrorAt, undefined);
  // A later transient error is announced with its own wait, never sent on first sight.
  s.state.tails = [{...fetchFailed, at: 300}];
  s.state.now = RETRY_DELAYS_MS[0] * 5;
  await s.watcher.tick();
  assert.equal(s.herdr.count('agentPrompt'), 0);
  assert.match(s.notices.at(-1)!.text, /1分後に自動で再開します/);
});

test('a gone pane is notified and removed; the next check with nothing owned stops the timer', async t => {
  const s = await setup(t);
  await s.watcher.add(entry());
  await s.watcher.tick();
  assert.equal(s.notices[0]!.level, 'error');
  assert.deepEqual((await s.registry.load()).records, []);
  await s.watcher.tick();
  assert.equal(s.watcher.active, false);
});

test('a pane whose agent is gone and whose shell is in front is an exited pi', async t => {
  const s = await setup(t);
  s.herdr.panes.set('w9:p2', {exists: true, status: 'unknown'});
  s.herdr.shellReady = true;
  await s.watcher.add(entry());
  await s.watcher.tick();
  assert.match(s.notices[0]!.text, /pi が終了しました/);
});

test('other owner: watches of another session are neither checked nor resumed', async t => {
  const s = await setup(t);
  await s.registry.upsert(entry('w9:p7', 'someone-else'));
  await s.watcher.resume();
  assert.equal(s.timers.length, 0);
  await s.watcher.add(entry());
  s.herdr.panes.set('w9:p2', {exists: true, agent: 'pi', status: 'working'});
  await s.watcher.tick();
  assert.deepEqual(s.herdr.calls.filter(c => c.command === 'paneGet').map(c => c.args), [{paneId: 'w9:p2'}]);
});

test('resume restarts the timer when this session still owns watches', async t => {
  const s = await setup(t);
  await s.registry.upsert(entry());
  await s.watcher.resume();
  assert.equal(s.timers.length, 1);
});

test('an unsupported Herdr notifies once and stops; a failing version call only skips the check', async t => {
  const s = await setup(t);
  await s.watcher.add(entry());
  const original = s.herdr.version.bind(s.herdr);
  s.herdr.version = async () => { throw new Error('socket down'); };
  await s.watcher.tick(); await s.watcher.tick();
  assert.equal(s.watcher.active, true);
  assert.equal(s.notices.length, 0);
  await s.watcher.tick();
  assert.equal(s.notices.length, 1);
  assert.match(s.notices[0]!.text, /3 回続けて接続できませんでした/);
  await s.watcher.tick();
  assert.equal(s.notices.length, 1);
  assert.equal(s.watcher.active, true);
  s.herdr.version = original;
  s.herdr.version_ = {version: '0.9.2', protocol: 23};
  await s.watcher.tick(); await s.watcher.tick();
  assert.equal(s.notices.length, 2);
  assert.equal(s.watcher.active, false);
});

test('a check still running makes the next one a no-op', async t => {
  const s = await setup(t);
  s.herdr.panes.set('w9:p2', {exists: true, agent: 'pi', status: 'working'});
  await s.watcher.add(entry());
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const original = s.herdr.paneGet.bind(s.herdr);
  s.herdr.paneGet = async id => { await gate; return original(id); };
  const first = s.watcher.tick();
  await s.watcher.tick();
  release(); await first;
  assert.equal(s.herdr.count('paneGet'), 1);
});

test('the retry count is saved before sending; if that save fails nothing is sent', async t => {
  const s = await setup(t);
  s.herdr.panes.set('w9:p2', {exists: true, agent: 'pi', status: 'idle', session: mine()});
  await s.watcher.add(entry());
  await s.watcher.tick();
  s.state.now = RETRY_DELAYS_MS[0];
  let updates = 0;
  s.registry.update = async () => { updates += 1; throw new Error('disk full'); };
  await s.watcher.tick();
  assert.equal(updates, 1);
  assert.equal(s.herdr.count('agentPrompt'), 0);
  assert.match(s.notices.at(-1)!.text, /監視台帳を更新できませんでした/);
});

test('a pi pane whose session belongs to another session is reported as replaced', async t => {
  const s = await setup(t);
  s.herdr.panes.set('w9:p2', {exists: true, agent: 'pi', status: 'idle', session: {kind: 'path', value: '/x/2026_other.jsonl'}});
  await s.watcher.add(entry());
  await s.watcher.tick();
  assert.match(s.notices[0]!.text, /下位の pane で別のセッションが動いています。監視を終えます。/);
  assert.equal(s.notices[0]!.level, 'warning');
  assert.equal(s.herdr.count('agentPrompt'), 0);
  assert.deepEqual((await s.registry.load()).records, []);
});

test('a pi pane whose session path ends with the target session id is checked normally', async t => {
  const s = await setup(t);
  s.herdr.panes.set('w9:p2', {exists: true, agent: 'pi', status: 'idle', session: {kind: 'path', value: '/x/2026_s-w9:p2.jsonl'}});
  await s.watcher.add(entry());
  await s.watcher.tick();
  assert.match(s.notices[0]!.text, /fetch failed|エラー|API/);
  assert.equal((await s.registry.load()).records.length, 1);
});

test('a failed send is counted before typing, warned about, and not resent for the same error', async t => {
  const s = await setup(t);
  s.herdr.panes.set('w9:p2', {exists: true, agent: 'pi', status: 'idle', session: mine()});
  await s.watcher.add(entry());
  await s.watcher.tick();
  s.state.now = RETRY_DELAYS_MS[0];
  s.herdr.fail.agentPrompt = 'unknown';
  await s.watcher.tick();
  assert.equal(s.herdr.count('agentPrompt'), 1);
  assert.equal((await s.registry.load()).records[0]!.progress.retryCount, 1, 'counted although the send failed');
  assert.equal(s.notices.at(-1)!.level, 'warning');
  assert.match(s.notices.at(-1)!.text, /再開の送信を確認できませんでした/);
  delete s.herdr.fail.agentPrompt;
  s.state.now = RETRY_DELAYS_MS[0] + 60_000;
  await s.watcher.tick();
  assert.equal(s.herdr.count('agentPrompt'), 1, 'no resend on the next check for the same error');
  assert.match(s.notices.at(-1)!.text, /5分後に自動で再開します/);
});

test('an unchanged progress is not written again', async t => {
  const s = await setup(t);
  s.herdr.panes.set('w9:p2', {exists: true, agent: 'pi', status: 'working'});
  await s.watcher.add(entry());
  let updates = 0;
  const update = s.registry.update.bind(s.registry);
  s.registry.update = async r => { updates += 1; return update(r); };
  await s.watcher.tick(); await s.watcher.tick();
  assert.equal(updates, 0);
  s.herdr.panes.set('w9:p2', {exists: true, agent: 'pi', status: 'blocked'});
  await s.watcher.tick(); await s.watcher.tick();
  assert.equal(updates, 1);
});

test('a terminal notice is shown once even when removing the watch keeps failing', async t => {
  const s = await setup(t);
  await s.watcher.add(entry());
  s.registry.remove = async () => { throw new Error('disk full'); };
  await s.watcher.tick(); await s.watcher.tick(); await s.watcher.tick();
  assert.equal(s.notices.filter(n => /pane が消えました/.test(n.text)).length, 1);
  assert.equal(s.notices.filter(n => /監視台帳を更新できませんでした/.test(n.text)).length, 1);
});

test('a pane reporting no session gets notices but never an automatic continue', async t => {
  const s = await setup(t);
  s.herdr.panes.set('w9:p2', {exists: true, agent: 'pi', status: 'idle'});
  await s.watcher.add(entry());
  await s.watcher.tick();
  s.state.now = RETRY_DELAYS_MS[0];
  await s.watcher.tick();
  s.state.now = RETRY_DELAYS_MS[2] * 2;
  await s.watcher.tick();
  assert.equal(s.herdr.count('agentPrompt'), 0);
  assert.equal(s.notices.length, 1, 'one notice, not one per check');
  assert.match(s.notices[0]!.text, /セッションを確認できないため、自動再開はしません: fetch failed/);
  assert.equal(s.notices[0]!.level, 'warning');
});

test('a session that disappears just before sending stops the send', async t => {
  const s = await setup(t);
  s.herdr.panes.set('w9:p2', {exists: true, agent: 'pi', status: 'idle', session: mine()});
  await s.watcher.add(entry());
  await s.watcher.tick();
  s.state.now = RETRY_DELAYS_MS[0];
  const paneGet = s.herdr.paneGet.bind(s.herdr);
  let calls = 0;
  s.herdr.paneGet = async id => { calls += 1; const p = await paneGet(id); return calls === 2 && p.exists ? {exists: true, agent: p.agent, status: p.status} : p; };
  await s.watcher.tick();
  assert.equal(s.herdr.count('agentPrompt'), 0);
});

test('a watch whose removal failed is never acted on again, even after its session comes back or the parent restarts', async t => {
  const s = await setup(t);
  s.herdr.panes.set('w9:p2', {exists: true, agent: 'pi', status: 'idle', session: mine()});
  await s.watcher.add(entry());
  await s.watcher.tick(); // a transient error: a continue is scheduled
  s.herdr.panes.set('w9:p2', {exists: true, agent: 'pi', status: 'idle', session: {kind: 'id', value: 'someone-else'}});
  const remove = s.registry.remove.bind(s.registry);
  s.registry.remove = async () => { throw new Error('disk full'); };
  await s.watcher.tick(); // replaced: the watch ends but stays in the registry
  const [left] = (await s.registry.load()).records;
  assert.equal(left!.progress.pendingRetryAt, undefined, 'the schedule is not left behind');
  assert.equal(typeof left!.progress.endedAt, 'number');
  // The target session returns (e.g. /resume) long after the scheduled time.
  s.herdr.panes.set('w9:p2', {exists: true, agent: 'pi', status: 'idle', session: mine()});
  s.state.now = RETRY_DELAYS_MS[2] * 2;
  await s.watcher.tick();
  assert.equal(s.herdr.count('agentPrompt'), 0);
  // A restarted parent (fresh watcher, same registry) does not act on it either; it only finishes the removal.
  const notices: string[] = [];
  const restarted = new StageWatcher({ownerSessionId: 'parent', registry: s.registry, herdr: s.herdr, now: () => s.state.now,
    readTail: async () => fetchFailed, notify: text => notices.push(text), setInterval: () => 1, clearInterval: () => undefined});
  s.registry.remove = remove;
  await restarted.tick();
  assert.equal(s.herdr.count('agentPrompt'), 0);
  assert.deepEqual(notices, []);
  assert.deepEqual((await s.registry.load()).records, []);
});
