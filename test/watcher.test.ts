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
  s.herdr.panes.set('w9:p2', {exists: true, agent: 'pi', status: 'idle'});
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
  s.herdr.panes.set('w9:p2', {exists: true, agent: 'pi', status: 'idle'});
  await s.watcher.add(entry());
  await s.watcher.tick();
  s.state.now = RETRY_DELAYS_MS[0];
  s.state.tails = [fetchFailed, {kind: 'stopped', reason: 'stop', at: 200}];
  await s.watcher.tick();
  assert.equal(s.herdr.count('agentPrompt'), 0);
  assert.equal((await s.registry.load()).records[0]!.progress.retryCount, 0);
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
  s.herdr.panes.set('w9:p2', {exists: true, agent: 'pi', status: 'idle'});
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

test('a pi pane whose session belongs to another session is treated as exited', async t => {
  const s = await setup(t);
  s.herdr.panes.set('w9:p2', {exists: true, agent: 'pi', status: 'idle', session: {kind: 'path', value: '/x/2026_other.jsonl'}});
  await s.watcher.add(entry());
  await s.watcher.tick();
  assert.match(s.notices[0]!.text, /pi が終了しました/);
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
