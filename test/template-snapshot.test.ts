import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildTemplateSnapshot} from '../src/core/template-snapshot.js';
import {ensureOwnedDir} from '../src/core/files.js';

async function root(t: {after(fn: () => Promise<void>): void}) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-scaffold-tpl-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const r = join(dir, 'pi-scaffold'); await ensureOwnedDir(r, r); return r;
}
const binding = (model: string) => ({model, thinking: 'medium' as const, reason: 'r'});

test('epic snapshot is pi-gh kind parent with a planner policy from the binding only', async t => {
  const r = await root(t);
  const s = await buildTemplateSnapshot('epic', {planner: binding('example-provider/planner-1')}, join(r, 'a'), r);
  const yml = await readFile(s.templatePath, 'utf8');
  assert.match(yml, /^id: scaffold-epic-v1$/m);
  assert.match(yml, /^kind: parent$/m);
  assert.match(yml, /^modelPolicy: models\.yml$/m);
  assert.deepEqual(JSON.parse(await readFile(s.policyPath, 'utf8')), {version: 1, agents: {planner: [{model: 'example-provider/planner-1', thinking: 'medium', tier: 'basic'}]}});
  assert.equal((await stat(s.policyPath)).mode & 0o777, 0o600);
  assert.equal(s.templateId, 'scaffold-epic-v1');
});

test('feature and task snapshots are kind task and need every role', async t => {
  const r = await root(t);
  const f = await buildTemplateSnapshot('feature', {'coding-manager': binding('p/m'), coder: binding('p/c'), tester: binding('p/t')}, join(r, 'f'), r);
  assert.match(await readFile(f.templatePath, 'utf8'), /^kind: task$/m);
  const tk = await buildTemplateSnapshot('task', {coder: binding('p/c'), tester: binding('p/t')}, join(r, 't'), r);
  assert.match(await readFile(tk.templatePath, 'utf8'), /^id: scaffold-task-v1$/m);
  await assert.rejects(buildTemplateSnapshot('feature', {coder: binding('p/c')}, join(r, 'x'), r), /coding-manager/);
  await assert.rejects(buildTemplateSnapshot('epic', {planner: binding('p/m'), coder: binding('p/c')}, join(r, 'y'), r), /coder/);
});
