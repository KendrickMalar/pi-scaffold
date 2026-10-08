// Session-bound cancellation and the single place where operations record intent, steps and stops.
import {problem, type CallScope, type Problem, type ScaffoldResult, type ScaffoldStatus, type Sha256, type UUID} from './contracts.js';
import type {OperationJournal, OperationRecord} from './journal.js';
import type {GhOutcome} from '../ports/pi-gh.js';

/** Generation counter invalidated on session switch/fork/tree/reload/shutdown. Mirrors pi-gh's scope. */
export class RuntimeScope {
  private generation = 0;
  private leases = new Set<AbortController>();
  private tail: Promise<unknown> = Promise.resolve();
  get stamp() { return String(this.generation); }
  get current() { return this.generation; }
  isCurrent(stamp: string) { return stamp === this.stamp; }
  acquire(caller?: AbortSignal): {stamp: string; signal: AbortSignal; dispose(): void} {
    const controller = new AbortController(), stamp = this.stamp;
    this.leases.add(controller);
    const abort = () => controller.abort();
    caller?.addEventListener('abort', abort, {once: true});
    if (caller?.aborted) abort();
    let disposed = false;
    return {stamp, signal: controller.signal, dispose: () => { if (disposed) return; disposed = true; caller?.removeEventListener('abort', abort); this.leases.delete(controller); }};
  }
  invalidate() { this.generation++; for (const c of this.leases) c.abort(); this.leases.clear(); }
  /** Serializes mutating tools in this runtime; queued work expires when the session changes. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const stamp = this.stamp;
    const result = this.tail.then(() => { if (!this.isCurrent(stamp)) throw new Error('Session changed; queued operation expired.'); return fn(); });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function createCallScope(runtime: RuntimeScope, identity: () => {sessionId: string; leafId: string}, caller?: AbortSignal): CallScope & {dispose(): void} {
  const lease = runtime.acquire(caller), captured = identity();
  return {
    sessionId: captured.sessionId, leafId: captured.leafId, generation: runtime.current, signal: lease.signal,
    isCurrent: () => runtime.isCurrent(lease.stamp) && !lease.signal.aborted && (() => { const now = identity(); return now.sessionId === captured.sessionId && now.leafId === captured.leafId; })(),
    dispose: lease.dispose,
  };
}

class Stop extends Error { constructor(readonly status: ScaffoldStatus, readonly problems: Problem[]) { super(status); } }
export type Reconcile = () => Promise<'applied' | 'not-applied' | 'unknown'>;
export interface OperationRun {
  readonly record: OperationRecord;
  readonly scope: CallScope;
  /** Data of a step finished by an earlier run of this operation, for resuming without repeating it. */
  done(step: string): unknown;
  /** Throws (stops the operation) if the session changed. */
  checkpoint(): void;
  /** Stop with a definite reason; becomes `partial` once any write of this operation is done. */
  stop(problems: Problem[]): never;
  /**
   * Performs one remote change exactly once. A step left `requested`/`unknown` by an earlier run is never
   * resent blindly: `reconcile` must read the remote state back first.
   */
  write<T>(step: string, fn: () => Promise<GhOutcome<T>>, options?: {reconcile?: Reconcile}): Promise<T | undefined>;
}
export interface OperationSpec {
  operation: string; repo: string; workflowId: string; operationId: UUID; payloadDigest: Sha256;
  journal: OperationJournal; scope: CallScope;
}
export type WorkResult<T> = {status: 'applied' | 'noop' | 'prepared' | 'validated'; data: T};

export async function withOperation<T>(spec: OperationSpec, work: (run: OperationRun) => Promise<WorkResult<T>>): Promise<ScaffoldResult<T | {steps: {name: string; phase: string}[]}>> {
  const base = {operation: spec.operation};
  if (!spec.scope.isCurrent()) return {...base, status: 'cancelled', problems: [problem('STALE_SCOPE', '', 'Session changed or the call was cancelled before the operation started.')]};
  const begun = await spec.journal.begin({operationId: spec.operationId, repo: spec.repo, workflowId: spec.workflowId, operation: spec.operation, payloadDigest: spec.payloadDigest});
  if (begun.kind === 'conflict') return {...base, status: 'blocked', problems: [problem(begun.code, 'operationId', begun.message)]};
  const record = begun.record;
  if (begun.kind === 'completed') return {...base, status: 'noop', data: record.result as T, problems: []};
  const anyDone = () => record.steps.some(s => s.phase === 'done');
  const save = () => spec.journal.save(record);
  let inFlight = false;
  const run: OperationRun = {
    record, scope: spec.scope,
    done: step => record.steps.find(s => s.name === step && s.phase === 'done')?.data,
    checkpoint() { if (!spec.scope.isCurrent()) throw new Stop(anyDone() ? 'partial' : 'cancelled', [problem('STALE_SCOPE', '', 'Session changed or the call was cancelled; stopped before the next change.')]); },
    stop(problems) { throw new Stop(anyDone() ? 'partial' : 'blocked', problems); },
    async write(step, fn, options = {}) {
      const prev = record.steps.find(s => s.name === step);
      if (prev?.phase === 'done') return prev.data as never;
      run.checkpoint();
      if (prev && (prev.phase === 'requested' || prev.phase === 'unknown')) {
        const state = options.reconcile ? await options.reconcile() : 'unknown';
        if (state === 'applied') { prev.phase = 'done'; await save(); return prev.data as never; }
        if (state === 'unknown') throw new Stop('unknown', [problem('RECONCILE_REQUIRED', step, `Step ${step} has an uncertain outcome; inspect GitHub before continuing.`)]);
        run.checkpoint();
      }
      const entry = prev ?? {name: step, phase: 'requested' as const};
      entry.phase = 'requested'; delete entry.data;
      if (!prev) record.steps.push(entry);
      await save();
      inFlight = true;
      const outcome = await fn();
      inFlight = false;
      if (outcome.status === 'ok' || outcome.status === 'noop') {
        entry.phase = 'done'; if (outcome.data !== undefined) entry.data = outcome.data; await save(); return outcome.data;
      }
      if (outcome.status === 'unknown') { entry.phase = 'unknown'; await save(); throw new Stop('unknown', outcome.problems); }
      entry.phase = 'failed'; await save();
      if (outcome.status === 'cancelled') throw new Stop(anyDone() ? 'partial' : 'cancelled', outcome.problems);
      throw new Stop(anyDone() ? 'partial' : 'blocked', outcome.problems);
    },
  };
  const finish = async (status: ScaffoldStatus, problems: Problem[], data?: unknown): Promise<ScaffoldResult<never>> => {
    record.status = status;
    if (data !== undefined) record.result = data;
    await save();
    const progress = {steps: record.steps.map(s => ({name: s.name, phase: s.phase}))};
    const resumable = status === 'partial' || status === 'unknown';
    return {...base, status, problems, data: (data ?? progress) as never, ...(resumable ? {resumeToken: spec.operationId} : {})};
  };
  try {
    const result = await work(run);
    return await finish(result.status, [], result.data);
  } catch (error) {
    if (error instanceof Stop) return finish(error.status, error.problems);
    if (inFlight) return finish('unknown', [problem('WRITE_INTERRUPTED', '', 'A change was requested but its outcome could not be confirmed; inspect GitHub before retrying.')]);
    return finish(anyDone() ? 'partial' : 'blocked', [problem('INTERNAL_ERROR', '', (error as Error)?.message ?? 'Operation failed.')]);
  }
}
