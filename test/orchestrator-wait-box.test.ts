import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BOX_READ, BOX_SEP, createBoxReader, execKecOrb} from '../src/orchestrator-wait/box.js';

const PANES = '{"result":{"panes":[{"pane_id":"w1:p1","revision":1,"agent":"claude","agent_status":"blocked","tab_id":"w1:t1"},{"pane_id":"w2:p1","revision":1,"agent":"claude","agent_status":"working","tab_id":"w2:t1"}]}}';
const TABS = '{"result":{"tabs":[{"tab_id":"w1:t1","label":"1"},{"tab_id":"w2:t1","label":"design-e12"}]}}';
const OUT = `${PANES}\n${BOX_SEP}\n${TABS}\n`;

test('BOX_READ is a fixed herdr read', () => {
  assert.equal(BOX_READ, `herdr pane list && printf '\\n%s\\n' '${BOX_SEP}' && herdr tab list`);
});

test('createBoxReader labels box panes', async () => {
  const r = createBoxReader({run: async () => OUT});
  const panes = await r.boxPanes('web-e12-rust');
  assert.deepEqual(panes.map(p => [p.socket, p.paneId, p.status, p.tabLabel]), [
    ['box:web-e12-rust', 'w1:p1', 'blocked', '1'],
    ['box:web-e12-rust', 'w2:p1', 'working', 'design-e12'],
  ]);
});

test('createBoxReader passes fixed argv', async () => {
  const seen: string[][] = [];
  const r = createBoxReader({run: async args => { seen.push(args); return OUT; }});
  await r.boxPanes('web-e12-rust');
  assert.deepEqual(seen, [['ssh', 'web-e12-rust', BOX_READ]]);
});

test('createBoxReader throws without separator', async () => {
  const r = createBoxReader({run: async () => `${PANES}\n${TABS}`});
  await assert.rejects(r.boxPanes('web-e12-rust'), /separator/);
});

test('createBoxReader throws on unreadable tab list', async () => {
  const r = createBoxReader({run: async () => `${PANES}\n${BOX_SEP}\nnope`});
  await assert.rejects(r.boxPanes('web-e12-rust'), /tab list/);
});

test('createBoxReader throws on unreadable pane list', async () => {
  const r = createBoxReader({run: async () => `nope\n${BOX_SEP}\n${TABS}`});
  await assert.rejects(r.boxPanes('web-e12-rust'), /pane list/);
});

async function fakeKecOrb(t: test.TestContext, body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orch-wait-kec-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const bin = join(dir, 'kec-orb');
  await writeFile(bin, `#!/bin/sh\n${body}\n`);
  await chmod(bin, 0o755);
  return bin;
}

test('execKecOrb returns stdout', async t => {
  const bin = await fakeKecOrb(t, 'printf "%s|%s|%s" "$1" "$2" "$3"');
  assert.equal(await execKecOrb(bin, 5000)(['ssh', 'web-e12-rust', 'x y']), 'ssh|web-e12-rust|x y');
});

test('execKecOrb reports exit 255', async t => {
  const bin = await fakeKecOrb(t, 'echo "connect refused" >&2; exit 255');
  await assert.rejects(execKecOrb(bin, 5000)(['ssh', 'web-e12-rust', BOX_READ]), /kec-orb ssh web-e12-rust failed \(exit 255\): connect refused/);
});

test('execKecOrb times out', async t => {
  const bin = await fakeKecOrb(t, 'exec sleep 5');
  const start = Date.now();
  await assert.rejects(execKecOrb(bin, 200)(['ssh', 'web-e12-rust', BOX_READ]), /kec-orb ssh web-e12-rust failed/);
  assert.ok(Date.now() - start < 3000);
});

test('execKecOrb kills the ssh child on timeout', async t => {
  // kec-orb runs ssh as a child of a bash function (no exec); a timeout must not leave it behind.
  const dir = await mkdtemp(join(tmpdir(), 'orch-wait-kec-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const pidFile = join(dir, 'child.pid');
  const bin = join(dir, 'kec-orb');
  await writeFile(bin, `#!/bin/bash\nrun() { sleep 30 & echo $! > '${pidFile}'; wait; }\nrun\n`);
  await chmod(bin, 0o755);
  await assert.rejects(execKecOrb(bin, 300)(['ssh', 'web-e12-rust', BOX_READ]), /failed/);
  const pid = Number((await readFile(pidFile, 'utf8')).trim());
  await new Promise(r => setTimeout(r, 300));
  assert.throws(() => process.kill(pid, 0), 'child sleep still running');
});

test('execKecOrb passes kec-orb and ssh agent settings', async t => {
  const bin = await fakeKecOrb(t, 'printf "%s|%s|%s" "$KEC_ORB_STATE_DIR" "$SSH_AUTH_SOCK" "$UNRELATED"');
  const keep = {KEC_ORB_STATE_DIR: process.env.KEC_ORB_STATE_DIR, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK, UNRELATED: process.env.UNRELATED};
  t.after(() => { for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  process.env.KEC_ORB_STATE_DIR = '/x/state'; process.env.SSH_AUTH_SOCK = '/x/agent.sock'; process.env.UNRELATED = 'no';
  assert.equal(await execKecOrb(bin, 5000)(['ssh', 'b', 'c']), '/x/state|/x/agent.sock|');
});
