import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OperationJournal} from '../src/core/journal.js';
import {withOperation, RuntimeScope, type OperationRun} from '../src/core/lifecycle.js';
import type {GhOutcome} from '../src/ports/pi-gh.js';
import {makeScope} from './helpers/scope.js';
import {OPERATION_ID, WORKFLOW_ID, SHA_A, SHA_B} from './helpers/docs.js';

const OTHER_OP = '77777777-7777-4777-8777-777777777777';
async function setup(t: {after(fn: () => Promise<void>): void}) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-scaffold-journal-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const root = join(dir, 'pi-scaffold');
  return {root, journal: new OperationJournal({root, workflowStateRoot: join(root, 'state', 'repo', WORKFLOW_ID)})};
}
const ok = (data: unknown = {}): GhOutcome<unknown> => ({status: 'ok', data, problems: [], isError: false});
const unknown = (): GhOutcome<unknown> => ({status: 'unknown', problems: [{code: 'UNKNOWN', path: '', message: 'uncertain'}], isError: true});
const rejected = (): GhOutcome<unknown> => ({status: 'blocked', problems: [{code: 'REJECTED', path: '', message: 'no'}], isError: true});

function spec(journal: OperationJournal, scope = makeScope(), operationId = OPERATION_ID, payloadDigest = SHA_A) {
  return {operation: 'scaffold_example', repo: 'example/demo', workflowId: WORKFLOW_ID, operationId, payloadDigest, journal, scope};
}
/** Four sequential writes; `plan[i]` decides the outcome of write i. */
function fourWrites(plan: (() => GhOutcome<unknown>)[], log: string[], reconcile?: (step: string) => Promise<'applied' | 'not-applied' | 'unknown'>) {
  return async (run: OperationRun) => {
    for (let i = 0; i < 4; i++) {
      const step = `write-${i + 1}`;
      await run.write(step, async () => { log.push(step); return plan[i]!(); }, reconcile ? {reconcile: () => reconcile(step)} : {});
    }
    return {status: 'applied' as const, data: {done: true}};
  };
}

test('a new operation records intent and completes', async t => {
  const {journal} = await setup(t);
  const log: string[] = [];
  const r = await withOperation(spec(journal), fourWrites([ok, ok, ok, ok], log));
  assert.equal(r.status, 'applied');
  assert.deepEqual(log, ['write-1', 'write-2', 'write-3', 'write-4']);
  const record = await journal.load(OPERATION_ID);
  assert.equal(record?.status, 'applied');
  assert.equal((await stat(journal.recordPath(OPERATION_ID))).mode & 0o777, 0o600);
});

test('the same operationId with another payload is blocked before any write', async t => {
  const {journal} = await setup(t);
  await withOperation(spec(journal), fourWrites([ok, ok, ok, ok], []));
  const log: string[] = [];
  const r = await withOperation(spec(journal, makeScope(), OPERATION_ID, SHA_B), fourWrites([ok, ok, ok, ok], log));
  assert.equal(r.status, 'blocked');
  assert.ok(r.problems.some(p => p.code === 'OPERATION_PAYLOAD_MISMATCH'));
  assert.deepEqual(log, []);
});

test('re-running a completed operation is a no-op without writes', async t => {
  const {journal} = await setup(t);
  await withOperation(spec(journal), fourWrites([ok, ok, ok, ok], []));
  const log: string[] = [];
  const r = await withOperation(spec(journal), fourWrites([ok, ok, ok, ok], log));
  assert.equal(r.status, 'noop');
  assert.deepEqual(log, []);
});

test('an expired scope before start is cancelled with zero writes', async t => {
  const {journal} = await setup(t);
  const scope = makeScope(); scope.expire();
  const log: string[] = [];
  const r = await withOperation(spec(journal, scope), fourWrites([ok, ok, ok, ok], log));
  assert.equal(r.status, 'cancelled');
  assert.deepEqual(log, []);
  assert.equal(await journal.load(OPERATION_ID), undefined);
});

test('two applied writes then an unknown third stops before the fourth and keeps progress', async t => {
  const {journal} = await setup(t);
  const log: string[] = [];
  const r = await withOperation(spec(journal), fourWrites([ok, ok, unknown, ok], log));
  assert.equal(r.status, 'unknown');
  assert.deepEqual(log, ['write-1', 'write-2', 'write-3']);
  assert.equal(r.resumeToken, OPERATION_ID);
  const record = (await journal.load(OPERATION_ID))!;
  assert.deepEqual(record.steps.map(s => [s.name, s.phase]), [['write-1', 'done'], ['write-2', 'done'], ['write-3', 'unknown']]);

  const rerun: string[] = [];
  const blind = await withOperation(spec(journal), fourWrites([ok, ok, ok, ok], rerun));
  assert.equal(blind.status, 'unknown', 'an unknown step is never resent without reconciliation');
  assert.deepEqual(rerun, []);

  const reconciled: string[] = [];
  const resumed = await withOperation(spec(journal), fourWrites([ok, ok, ok, ok], reconciled, async () => 'applied'));
  assert.equal(resumed.status, 'applied');
  assert.deepEqual(reconciled, ['write-4']);
});

test('a definite rejection after earlier writes is partial', async t => {
  const {journal} = await setup(t);
  const log: string[] = [];
  const r = await withOperation(spec(journal), fourWrites([ok, ok, rejected, ok], log));
  assert.equal(r.status, 'partial');
  assert.deepEqual(log, ['write-1', 'write-2', 'write-3']);
  const first = await withOperation(spec(await setup(t).then(s => s.journal)), fourWrites([rejected, ok, ok, ok], []));
  assert.equal(first.status, 'blocked');
});

test('another operation on a workflow with an unresolved operation is blocked', async t => {
  const {journal} = await setup(t);
  await withOperation(spec(journal), fourWrites([ok, unknown, ok, ok], []));
  const log: string[] = [];
  const r = await withOperation(spec(journal, makeScope(), OTHER_OP), fourWrites([ok, ok, ok, ok], log));
  assert.equal(r.status, 'blocked');
  assert.ok(r.problems.some(p => p.code === 'WORKFLOW_UNRESOLVED'));
  assert.deepEqual(log, []);
});

test('scope expiry mid-operation stops further writes as partial', async t => {
  const {journal} = await setup(t);
  const scope = makeScope();
  const log: string[] = [];
  const r = await withOperation(spec(journal, scope), fourWrites([() => { scope.expire(); return ok(); }, ok, ok, ok], log));
  assert.equal(r.status, 'partial');
  assert.deepEqual(log, ['write-1']);
});

test('thrown errors: before any write is blocked, inside a write is unknown', async t => {
  const {journal} = await setup(t);
  const before = await withOperation(spec(journal), async () => { throw new Error('bug'); });
  assert.equal(before.status, 'blocked');
  const {journal: j2} = await setup(t);
  const inside = await withOperation(spec(j2), async run => { await run.write('w', async () => { throw new Error('lost'); }); return {status: 'applied' as const, data: {}}; });
  assert.equal(inside.status, 'unknown');
});

test('runtime scope invalidation aborts leases and expires queued work', async () => {
  const runtime = new RuntimeScope();
  const lease = runtime.acquire();
  const queued = runtime.runExclusive(async () => 'ran');
  assert.equal(await queued, 'ran');
  const stamp = runtime.stamp;
  runtime.invalidate();
  assert.equal(lease.signal.aborted, true);
  assert.equal(runtime.isCurrent(stamp), false);
  const blocker = runtime.runExclusive(() => new Promise(r => setTimeout(r, 5)));
  await new Promise(r => setImmediate(r));
  const after = runtime.runExclusive(async () => 'late');
  runtime.invalidate();
  await blocker;
  await assert.rejects(after, /expired/);
});
