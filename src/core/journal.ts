// Private operation journal: intent (operationId + repo + workflow + payload digest) and per-step progress.
// It records only created IDs, phases and statuses — never credentials or Issue bodies.
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {isUuid, isSha256, type ScaffoldStatus, type Sha256, type UUID} from './contracts.js';
import {OwnedFileError, readOwnedJson, writeOwnedFile} from './files.js';

export type StepPhase = 'requested' | 'done' | 'failed' | 'unknown';
export interface JournalStep { name: string; phase: StepPhase; data?: unknown; /** Read-only progress, not a remote change. */ note?: true }
export interface OperationRecord {
  version: 1; operationId: UUID; repo: string; workflowId: string; operation: string; payloadDigest: Sha256;
  status: 'running' | ScaffoldStatus; steps: JournalStep[]; result?: unknown; startedAt: string; updatedAt: string;
  /** Set when a human abandoned this operation in the parent TUI; it is never resumed and holds nothing. */
  abandonedAt?: string;
}
export type BeginOutcome = {kind: 'new' | 'resume' | 'completed'; record: OperationRecord} | {kind: 'conflict'; code: 'OPERATION_PAYLOAD_MISMATCH' | 'WORKFLOW_UNRESOLVED' | 'JOURNAL_INVALID' | 'OPERATION_ABANDONED'; message: string};

/** A workflow is held only while a change may be in flight or has an unconfirmed outcome. */
const UNRESOLVED = new Set(['running', 'unknown']);
const hasUncertainStep = (r: OperationRecord) => r.steps.some(s => s.phase === 'requested' || s.phase === 'unknown');
const COMPLETED = new Set(['applied', 'noop', 'prepared', 'validated']);

function decodeRecord(v: unknown): OperationRecord | undefined {
  const r = v as OperationRecord;
  if (!r || typeof r !== 'object' || r.version !== 1 || !isUuid(r.operationId) || !isSha256(r.payloadDigest) || typeof r.repo !== 'string' || typeof r.workflowId !== 'string' || typeof r.operation !== 'string' || typeof r.status !== 'string' || !Array.isArray(r.steps)) return undefined;
  if (r.steps.some(s => !s || typeof s.name !== 'string' || !['requested', 'done', 'failed', 'unknown'].includes(s.phase))) return undefined;
  return r;
}

export class OperationJournal {
  readonly root: string;
  readonly workflowStateRoot: string;
  constructor(options: {root: string; workflowStateRoot: string}) { this.root = options.root; this.workflowStateRoot = options.workflowStateRoot; }
  private get dir() { return join(this.workflowStateRoot, 'operations'); }
  recordPath(operationId: UUID) { return join(this.dir, `${operationId}.json`); }

  async load(operationId: UUID): Promise<OperationRecord | undefined> {
    try {
      const record = decodeRecord(await readOwnedJson(this.recordPath(operationId), {root: this.root}));
      if (!record) throw new OwnedFileError('INVALID_JSON', this.recordPath(operationId), 'Journal record is malformed.');
      return record;
    } catch (e) { if (e instanceof OwnedFileError && e.code === 'NOT_FOUND') return undefined; throw e; }
  }
  /** All readable records of this workflow (malformed ones are skipped). */
  async list(): Promise<OperationRecord[]> {
    let names: string[];
    try { names = await readdir(this.dir); } catch { return []; }
    const out: OperationRecord[] = [];
    for (const n of names) { const id = n.replace(/\.json$/, ''); if (!n.endsWith('.json') || !isUuid(id)) continue; try { const r = await this.load(id); if (r) out.push(r); } catch { /* skip */ } }
    return out;
  }
  /** Marks an operation abandoned (after an explicit human confirmation). Remote state is left untouched. */
  async abandon(operationId: UUID): Promise<void> {
    const r = await this.load(operationId);
    if (!r || r.abandonedAt) return;
    r.status = 'cancelled'; r.abandonedAt = new Date().toISOString();
    await this.save(r);
  }
  async save(record: OperationRecord): Promise<void> {
    record.updatedAt = new Date().toISOString();
    await writeOwnedFile(this.recordPath(record.operationId), JSON.stringify(record, null, 2), {root: this.root});
  }
  private async unresolvedOthers(operationId: UUID): Promise<string[]> {
    let names: string[];
    try { names = await readdir(this.dir); } catch { return []; }
    const out: string[] = [];
    for (const name of names) {
      const id = name.replace(/\.json$/, '');
      if (!name.endsWith('.json') || id === operationId || !isUuid(id)) continue;
      const r = await this.load(id);
      if (!r || (!r.abandonedAt && (UNRESOLVED.has(r.status) || hasUncertainStep(r)))) out.push(id);
    }
    return out;
  }

  /** Records intent before any remote change. Same id + other payload is a conflict, never a new attempt. */
  async begin(intent: {operationId: UUID; repo: string; workflowId: string; operation: string; payloadDigest: Sha256}): Promise<BeginOutcome> {
    let existing: OperationRecord | undefined;
    try { existing = await this.load(intent.operationId); } catch (e) { return {kind: 'conflict', code: 'JOURNAL_INVALID', message: (e as Error).message}; }
    if (existing?.abandonedAt) return {kind: 'conflict', code: 'OPERATION_ABANDONED', message: 'This operation was abandoned; start a new one.'};
    if (existing) {
      if (existing.payloadDigest !== intent.payloadDigest || existing.repo !== intent.repo || existing.workflowId !== intent.workflowId || existing.operation !== intent.operation)
        return {kind: 'conflict', code: 'OPERATION_PAYLOAD_MISMATCH', message: 'This operationId was already used with a different repo/workflow/tool/payload.'};
      if (COMPLETED.has(existing.status)) return {kind: 'completed', record: existing};
    }
    const others = await this.unresolvedOthers(intent.operationId);
    if (others.length) return {kind: 'conflict', code: 'WORKFLOW_UNRESOLVED', message: `Workflow has unresolved operations (${others.join(', ')}); resume them with their own operationId after checking GitHub.`};
    if (existing) return {kind: 'resume', record: existing};
    const now = new Date().toISOString();
    const record: OperationRecord = {version: 1, ...intent, status: 'running', steps: [], startedAt: now, updatedAt: now};
    await this.save(record);
    return {kind: 'new', record};
  }
}
