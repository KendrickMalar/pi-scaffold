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
