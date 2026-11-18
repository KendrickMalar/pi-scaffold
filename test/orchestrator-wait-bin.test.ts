import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';

// dist/test/… → repo root
const BIN = resolve(import.meta.dirname, '..', '..', 'bin', 'scaffold-orchestrator-wait');

function run(args: string[], env: Record<string, string>): Promise<{code: number; stdout: string; stderr: string}> {
  return new Promise(res => execFile(process.execPath, [BIN, ...args], {env: {...process.env, ...env}}, (error, stdout, stderr) => {
    res({code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr)});
  }));
}

async function fakeHerdr(t: test.TestContext, status: string) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-wait-bin-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const sock = join(dir, 'a.sock');
  const herdr = join(dir, 'herdr');
  await writeFile(herdr, `#!/bin/sh
case "$1 $2" in
  "session list") printf '%s' '{"sessions":[{"running":true,"socket_path":"${sock}"}]}' ;;
  "pane list") printf '%s' '{"result":{"panes":[{"pane_id":"w1:p1","revision":1,"agent":"claude","agent_status":"${status}","tab_id":"w1:t1"}]}}' ;;
  "tab list") printf '%s' '{"result":{"tabs":[{"tab_id":"w1:t1","label":"1"}]}}' ;;
  *) exit 9 ;;
esac
`);
  await chmod(herdr, 0o755);
  const state = join(dir, 'state.json');
  await writeFile(state, JSON.stringify({tabs: [{socket: sock, pane: 'w1:p1', epics: [12], status: 'running'}]}));
  return {herdr, state, env: {SCAFFOLD_ORCH_WAIT_HERDR: herdr, SCAFFOLD_ORCH_WAIT_INTERVAL_MS: '20', SCAFFOLD_ORCH_WAIT_MAX_MS: '200'}};
}

test('bin prints timeout when nothing changes', async t => {
  const f = await fakeHerdr(t, 'working');
  assert.deepEqual(await run([f.state], f.env), {code: 0, stdout: 'timeout\n', stderr: ''});
});

test('bin prints one line for a blocked body', async t => {
  const f = await fakeHerdr(t, 'blocked');
  assert.deepEqual(await run([f.state], f.env), {code: 0, stdout: 'Epic #12 w1:p1 new->blocked\n', stderr: ''});
});

test('bin exits 2 without a state file argument', async () => {
  const r = await run([], {});
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage/i);
});

test('bin exits 2 when the state file cannot be read', async t => {
  const f = await fakeHerdr(t, 'working');
  const r = await run([`${f.state}.missing`], f.env);
  assert.equal(r.code, 2);
  assert.notEqual(r.stderr, '');
});

test('bin expands a leading ~/ in the state file path', async t => {
  const f = await fakeHerdr(t, 'blocked');
  const home = dirname(f.state);
  assert.deepEqual(await run(['~/state.json'], {...f.env, HOME: home}), {code: 0, stdout: 'Epic #12 w1:p1 new->blocked\n', stderr: ''});
});

test('bin reads a box tab through kec-orb', async t => {
  const f = await fakeHerdr(t, 'working');
  const dir = dirname(f.state);
  const kec = join(dir, 'kec-orb');
  await writeFile(kec, `#!/bin/sh
[ "$1" = ssh ] && [ "$2" = web-e12-rust ] || exit 9
printf '%s\n' '{"result":{"panes":[{"pane_id":"w1:p1","revision":1,"agent":"claude","agent_status":"blocked","tab_id":"w1:t1"}]}}'
printf '\n%s\n' '--- scaffold-orchestrator-wait tab list ---'
printf '%s\n' '{"result":{"tabs":[{"tab_id":"w1:t1","label":"1"}]}}'
`);
  await chmod(kec, 0o755);
  await writeFile(f.state, JSON.stringify({tabs: [{socket: join(dir, 'a.sock'), box: 'web-e12-rust', pane: 'w1:p1', epics: [12], status: 'running'}]}));
  assert.deepEqual(await run([f.state], {...f.env, SCAFFOLD_ORCH_WAIT_KEC_ORB: kec}), {code: 0, stdout: 'Epic #12 box web-e12-rust w1:p1 new->blocked\n', stderr: ''});
});

test('bin --manager reads stage tabs of the summary Epic and skips its own pane', async t => {
  const f = await fakeHerdr(t, 'blocked');
  const dir = dirname(f.state);
  const summary = join(dir, 'summary.json');
  await writeFile(summary, JSON.stringify({epic: 12, repo: 'o/r'}));
  const herdr = join(dir, 'herdr2');
  await writeFile(herdr, `#!/bin/sh
case "$1 $2" in
  "pane list") printf '%s' '{"result":{"panes":[{"pane_id":"w1:p1","revision":1,"agent":"claude","agent_status":"blocked","tab_id":"w1:t1"},{"pane_id":"w2:p1","revision":1,"agent":"claude","agent_status":"blocked","tab_id":"w2:t1"}]}}' ;;
  "tab list") printf '%s' '{"result":{"tabs":[{"tab_id":"w1:t1","label":"impl-e12"},{"tab_id":"w2:t1","label":"mgr-e12"}]}}' ;;
  *) exit 9 ;;
esac
`);
  await chmod(herdr, 0o755);
  const env = {...f.env, SCAFFOLD_ORCH_WAIT_HERDR: herdr, SCAFFOLD_ORCH_WAIT_WATCHDOG_LOG: join(dir, 'none.log'), HERDR_PANE_ID: 'w2:p1'};
  assert.deepEqual(await run(['--manager', summary], env), {code: 0, stdout: 'Epic #12 w1:p1 new->blocked\n', stderr: ''});
  const quiet = await run(['--manager', summary], {...env, HERDR_PANE_ID: 'w5:p5'});
  assert.equal(quiet.code, 0);
  assert.match(quiet.stdout, /^timeout \(errors: watchdog log: /);
});

test('bin --manager without a file exits 2', async () => {
  assert.equal((await run(['--manager'], {})).code, 2);
});
