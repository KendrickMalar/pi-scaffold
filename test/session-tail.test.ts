import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {findSessionLog, isTransientError, readSessionTail, sessionDirName, tailReader, TAIL_BYTES} from '../src/watch/session-tail.js';

const SID = '01a114af-7ef9-71a5-aee6-c19bd9b05a65';
const header = (version = 3) => JSON.stringify({type: 'session', version, id: SID, timestamp: '2026-10-07T04:46:48.057Z', cwd: '/synthetic/repo'});
const assistant = (stopReason: string, at: number, errorMessage?: string) => JSON.stringify({
  type: 'message', id: `m${at}`, parentId: null, timestamp: '2026-10-07T04:47:38.840Z',
  message: {role: 'assistant', content: [], api: 'anthropic-messages', provider: 'anthropic', model: 'example-1', stopReason, timestamp: at, ...(errorMessage !== undefined ? {errorMessage} : {})},
});
const user = (text: string) => JSON.stringify({type: 'message', id: 'u', parentId: null, timestamp: 't', message: {role: 'user', content: [{type: 'text', text}]}});

async function tmp(t: {after(fn: () => Promise<void>): void}) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-scaffold-tail-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}
async function log(dir: string, lines: string[]) { const p = join(dir, `2026-10-07T04-46-48-057Z_${SID}.jsonl`); await writeFile(p, lines.join('\n') + '\n'); return p; }

test('a transient error stop is reported with its message and timestamp', async t => {
  const p = await log(await tmp(t), [header(), user('hi'), assistant('toolUse', 1), assistant('error', 1791348458154, 'fetch failed')]);
  assert.deepEqual(await readSessionTail(p), {kind: 'error', transient: true, message: 'fetch failed', at: 1791348458154});
});

test('a 400 invalid_request error is not transient', async t => {
  const msg = '400 {"type":"error","error":{"type":"invalid_request_error","message":"bad"}}';
  const p = await log(await tmp(t), [header(), assistant('error', 7, msg)]);
  assert.deepEqual(await readSessionTail(p), {kind: 'error', transient: false, message: msg, at: 7});
});

test('a normal end and an aborted turn are stopped, with their reason', async t => {
  const dir = await tmp(t);
  assert.deepEqual(await readSessionTail(await log(dir, [header(), assistant('error', 1, 'fetch failed'), assistant('stop', 2)])), {kind: 'stopped', reason: 'stop', at: 2});
  assert.deepEqual(await readSessionTail(await log(dir, [header(), assistant('aborted', 3)])), {kind: 'stopped', reason: 'aborted', at: 3});
});

test('broken and non-assistant trailing lines are skipped', async t => {
  const p = await log(await tmp(t), [header(), assistant('error', 5, 'Connection error.'), user('later'), '{"type":"message","mess']);
  assert.deepEqual(await readSessionTail(p), {kind: 'error', transient: true, message: 'Connection error.', at: 5});
});

test('another log version, a broken header, no assistant, or a missing file is unknown', async t => {
  const dir = await tmp(t);
  assert.deepEqual(await readSessionTail(await log(dir, [header(2), assistant('stop', 1)])), {kind: 'unknown', reason: 'log-version'});
  assert.deepEqual(await readSessionTail(await log(dir, ['not json', assistant('stop', 1)])), {kind: 'unknown', reason: 'log-header'});
  assert.deepEqual(await readSessionTail(await log(dir, [header(), user('only')])), {kind: 'unknown', reason: 'no-assistant-message'});
  assert.deepEqual(await readSessionTail(join(dir, 'missing.jsonl')), {kind: 'unknown', reason: 'log-missing'});
});

test('large log: only the tail is read, the header is still checked, and a cut first line is ignored', async t => {
  const filler = user('x'.repeat(1000));
  const lines = [header(), ...Array.from({length: Math.ceil((TAIL_BYTES * 2) / filler.length)}, () => filler), assistant('error', 9, '529 overloaded')];
  const p = await log(await tmp(t), lines);
  assert.deepEqual(await readSessionTail(p), {kind: 'error', transient: true, message: '529 overloaded', at: 9});
});

test('transient classification follows the real error texts', () => {
  for (const m of ['fetch failed', 'Connection error.', '429 rate limited', '503 Service Unavailable', '{"type":"error","error":{"type":"overloaded_error"}}',
    'Codex SSE response headers timed out after 300000ms', 'upstream connect error or disconnect/reset before headers', 'exceeded request buffer limit while retrying upstream', 'socket hang up'])
    assert.equal(isTransientError(m), true, m);
  for (const m of ['400 {"type":"error"}', '403 {}', '404 {}', 'Codex error: The usage limit has been reached', '429 You have hit your usage limit',
    'Your authentication token has been invalidated. Please try signing in again.', "400 This endpoint's maximum context length is 64000 tokens.", ''])
    assert.equal(isTransientError(m), false, m);
});

test('the session log is found in the cwd directory first, then anywhere under sessions/', async t => {
  const root = await tmp(t);
  assert.equal(sessionDirName('/Users/me/Documents/Github/demo'), '--Users-me-Documents-Github-demo--');
  const preferred = join(root, sessionDirName('/synthetic/repo'));
  await mkdir(preferred);
  const p1 = await log(preferred, [header(), assistant('stop', 1)]);
  assert.equal(await findSessionLog(root, '/synthetic/repo', SID), p1);
  const other = join(root, '--elsewhere--');
  await mkdir(other);
  const p2 = join(other, `x_${'01b00000-0000-7000-8000-000000000000'}.jsonl`);
  await writeFile(p2, header() + '\n');
  assert.equal(await findSessionLog(root, '/synthetic/repo', '01b00000-0000-7000-8000-000000000000'), p2);
  assert.equal(await findSessionLog(root, '/synthetic/repo', 'nope'), undefined);
  assert.deepEqual(await tailReader(root)({cwd: '/synthetic/repo', targetSessionId: 'nope'}), {kind: 'unknown', reason: 'log-missing'});
  assert.deepEqual(await tailReader(root)({cwd: '/synthetic/repo', targetSessionId: SID}), {kind: 'stopped', reason: 'stop', at: 1});
});
