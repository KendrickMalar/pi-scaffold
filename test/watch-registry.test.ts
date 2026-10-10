import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, stat, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {WatchRegistry} from '../src/watch/registry.js';
import {INITIAL_PROGRESS, type WatchEntry} from '../src/watch/decide.js';

const entry = (paneId = 'w9:p2', owner = 'parent'): WatchEntry => ({ownerSessionId: owner, paneId, tabId: 'w9:t2', workspaceId: 'w9', targetSessionId: `s-${paneId}`, cwd: '/synthetic/repo', repo: 'example/demo', epicIssue: 10, targetStage: 'specification', addedAt: '2026-10-11T00:00:00.000Z'});
async function registry(t: {after(fn: () => Promise<void>): void}) {
  const agentDir = await mkdtemp(join(tmpdir(), 'pi-scaffold-watch-'));
  t.after(() => rm(agentDir, {recursive: true, force: true}));
  return new WatchRegistry(agentDir);
}

test('a missing registry is empty and not corrupt', async t => {
  assert.deepEqual(await (await registry(t)).load(), {records: [], corrupt: false});
});

test('upsert adds once per pane+session, resets progress, and writes an owner-only file', async t => {
  const r = await registry(t);
  await r.upsert(entry());
  await r.update({entry: entry(), progress: {...INITIAL_PROGRESS, retryCount: 2}});
  await r.upsert(entry('w9:p3'));
  assert.equal((await r.load()).records.find(x => x.entry.paneId === 'w9:p2')?.progress.retryCount, 2);
  await r.upsert(entry());
  const {records} = await r.load();
  assert.deepEqual(records.map(x => x.entry.paneId).sort(), ['w9:p2', 'w9:p3']);
  assert.equal(records.find(x => x.entry.paneId === 'w9:p2')?.progress.retryCount, 0);
  assert.equal((await stat(r.path)).mode & 0o777, 0o600);
});

test('remove drops only that watch', async t => {
  const r = await registry(t);
  await r.upsert(entry()); await r.upsert(entry('w9:p3'));
  await r.remove(entry());
  assert.deepEqual((await r.load()).records.map(x => x.entry.paneId), ['w9:p3']);
});

test('an unreadable file or a malformed record is reported as corrupt and skipped', async t => {
  const r = await registry(t);
  await mkdir(dirname(r.path), {recursive: true, mode: 0o700});
  await writeFile(r.path, '{not json', {mode: 0o600});
  assert.deepEqual(await r.load(), {records: [], corrupt: true});
  await writeFile(r.path, JSON.stringify({version: 1, watches: [{entry: entry(), progress: INITIAL_PROGRESS}, {entry: {paneId: 3}}]}), {mode: 0o600});
  const loaded = await r.load();
  assert.equal(loaded.corrupt, true);
  assert.deepEqual(loaded.records.map(x => x.entry.paneId), ['w9:p2']);
});
