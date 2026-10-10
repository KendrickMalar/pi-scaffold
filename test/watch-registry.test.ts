import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, stat, writeFile, mkdir, readdir, readFile} from 'node:fs/promises';
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

test('upsert adds once per pane+session, keeps the progress of an existing watch, and writes an owner-only file', async t => {
  const r = await registry(t);
  await r.upsert(entry());
  await r.update({entry: entry(), progress: {...INITIAL_PROGRESS, retryCount: 2}});
  await r.upsert(entry('w9:p3'));
  assert.equal((await r.load()).records.find(x => x.entry.paneId === 'w9:p2')?.progress.retryCount, 2);
  await r.upsert(entry());
  const {records} = await r.load();
  assert.deepEqual(records.map(x => x.entry.paneId).sort(), ['w9:p2', 'w9:p3']);
  assert.equal(records.find(x => x.entry.paneId === 'w9:p2')?.progress.retryCount, 2, 'a replayed handoff must not reset the count');
  assert.equal(records.find(x => x.entry.paneId === 'w9:p3')?.progress.retryCount, 0);
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

test('a write over an unparseable file moves the original aside instead of overwriting it', async t => {
  const r = await registry(t);
  await mkdir(dirname(r.path), {recursive: true, mode: 0o700});
  await writeFile(r.path, '{not json', {mode: 0o600});
  await r.upsert(entry());
  const aside = (await readdir(dirname(r.path))).filter(n => n.startsWith('watches.json.corrupt-'));
  assert.equal(aside.length, 1);
  assert.equal(await readFile(join(dirname(r.path), aside[0]!), 'utf8'), '{not json');
  assert.deepEqual((await r.load()).records.map(x => x.entry.paneId), ['w9:p2']);
});

test('remove on a file with a malformed record keeps the good record and moves the original aside', async t => {
  const r = await registry(t);
  await mkdir(dirname(r.path), {recursive: true, mode: 0o700});
  const original = JSON.stringify({version: 1, watches: [{entry: entry(), progress: INITIAL_PROGRESS}, {entry: {paneId: 3}}]});
  await writeFile(r.path, original, {mode: 0o600});
  await r.remove(entry('w9:p9'));
  const aside = (await readdir(dirname(r.path))).filter(n => n.startsWith('watches.json.corrupt-'));
  assert.equal(aside.length, 1);
  assert.equal(await readFile(join(dirname(r.path), aside[0]!), 'utf8'), original);
  const loaded = await r.load();
  assert.equal(loaded.corrupt, false);
  assert.deepEqual(loaded.records.map(x => x.entry.paneId), ['w9:p2']);
});

test('a re-upsert keeps the cap state and refreshes the entry', async t => {
  const r = await registry(t);
  await r.upsert(entry());
  await r.update({entry: entry(), progress: {...INITIAL_PROGRESS, retryCount: 3, exhaustedErrorAt: 42, lastNoticeKey: 'exhausted:42'}});
  await r.upsert({...entry(), addedAt: '2026-10-12T00:00:00.000Z'});
  const [rec] = (await r.load()).records;
  assert.equal(rec!.entry.addedAt, '2026-10-12T00:00:00.000Z');
  assert.deepEqual(rec!.progress, {...INITIAL_PROGRESS, retryCount: 3, exhaustedErrorAt: 42, lastNoticeKey: 'exhausted:42'});
});

test('concurrent update and upsert on the same instance both persist; a failed write does not break later ones', async t => {
  const r = await registry(t);
  await r.upsert(entry());
  await Promise.all([
    r.update({entry: entry(), progress: {...INITIAL_PROGRESS, retryCount: 1}}),
    r.upsert(entry('w9:p3')),
    r.update({entry: entry(), progress: {...INITIAL_PROGRESS, retryCount: 2}}),
    r.upsert(entry('w9:p4')),
  ]);
  const {records} = await r.load();
  assert.deepEqual(records.map(x => x.entry.paneId).sort(), ['w9:p2', 'w9:p3', 'w9:p4']);
  assert.equal(records.find(x => x.entry.paneId === 'w9:p2')?.progress.retryCount, 2);
  const internals = r as unknown as {save(records: unknown[]): Promise<void>};
  const save = internals.save;
  let fails = 1;
  internals.save = async function (this: unknown, records) { if (fails-- > 0) throw new Error('disk full'); return save.call(this, records); };
  const outcomes = await Promise.allSettled([r.update({entry: entry(), progress: {...INITIAL_PROGRESS, retryCount: 9}}), r.remove(entry('w9:p4'))]);
  assert.deepEqual(outcomes.map(o => o.status), ['rejected', 'fulfilled']);
  assert.equal((await r.load()).records.find(x => x.entry.paneId === 'w9:p2')?.progress.retryCount, 2);
  assert.deepEqual((await r.load()).records.map(x => x.entry.paneId).sort(), ['w9:p2', 'w9:p3']);
});

test('progress fields with the wrong type make the record malformed', async t => {
  const r = await registry(t);
  await mkdir(dirname(r.path), {recursive: true, mode: 0o700});
  const bad = [{pendingRetryAt: 'soon'}, {pendingErrorAt: null}, {exhaustedErrorAt: 'x'}, {lastNoticeKey: 7}];
  const watches = [{entry: entry(), progress: {...INITIAL_PROGRESS, pendingRetryAt: 1, pendingErrorAt: 2, exhaustedErrorAt: 3, lastNoticeKey: 'k'}},
    ...bad.map((p, i) => ({entry: entry(`w9:p${i + 10}`), progress: {...INITIAL_PROGRESS, ...p}}))];
  await writeFile(r.path, JSON.stringify({version: 1, watches}), {mode: 0o600});
  const loaded = await r.load();
  assert.equal(loaded.corrupt, true);
  assert.deepEqual(loaded.records.map(x => x.entry.paneId), ['w9:p2']);
});
