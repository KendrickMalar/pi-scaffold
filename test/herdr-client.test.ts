import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, chmod, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHerdrCli, HerdrError} from '../src/handoff/herdr-client.js';

async function fakeBin(t: {after(fn: () => Promise<void>): void}, script: string) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-scaffold-herdr-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const bin = join(dir, 'herdr');
  await writeFile(bin, `#!${process.execPath}\n${script}`); await chmod(bin, 0o755);
  return {dir, bin};
}

test('the caller pane identity is passed to herdr so --current means this pane, not the focused one', async t => {
  const {dir, bin} = await fakeBin(t, `require('fs').writeFileSync(${JSON.stringify('')} || process.argv[1] + '.env', JSON.stringify({pane: process.env.HERDR_PANE_ID, ws: process.env.HERDR_WORKSPACE_ID, sock: process.env.HERDR_SOCKET_PATH}));
console.log(JSON.stringify({result: {pane: {pane_id: process.env.HERDR_PANE_ID, workspace_id: process.env.HERDR_WORKSPACE_ID}}}));`);
  const cli = createHerdrCli({bin, socketPath: '/s.sock', caller: {HERDR_PANE_ID: 'w9:pA', HERDR_WORKSPACE_ID: 'w9', HERDR_TAB_ID: 'w9:t1'}});
  assert.deepEqual(await cli.currentPane(), {workspaceId: 'w9', paneId: 'w9:pA'});
  assert.deepEqual(JSON.parse(await readFile(bin + '.env', 'utf8')), {pane: 'w9:pA', ws: 'w9', sock: '/s.sock'});
  void dir;
});

test('a failed pane run or prompt may have been typed already, so it is unknown, not failed', async t => {
  const {bin} = await fakeBin(t, `process.exit(1);`);
  const cli = createHerdrCli({bin});
  await assert.rejects(cli.paneRun('w1:p2', 'echo'), (e: unknown) => e instanceof HerdrError && e.kind === 'unknown');
  await assert.rejects(cli.agentPrompt('w1:p2', 'hi'), (e: unknown) => e instanceof HerdrError && e.kind === 'unknown');
  await assert.rejects(cli.currentPane(), (e: unknown) => e instanceof HerdrError && e.kind === 'failed');
});
