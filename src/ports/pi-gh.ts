// The only path to GitHub: public pi-gh tools reached through Pi's ctx.executeTool(). No gh/API fallback.
import {LIMITS, failed, okValue, problem, type CallScope, type Decoded, type IssueSnapshot, type Problem} from '../core/contracts.js';
import {buildSnapshot} from '../core/body-codec.js';

export interface ToolOutcome { result: {content?: unknown; structuredContent?: unknown; details?: unknown}; isError: boolean }
export type ToolExecutor = (name: string, args: unknown, options?: {signal?: AbortSignal}) => Promise<ToolOutcome>;
export interface GhOutcome<T> { status: 'ok' | 'noop' | 'blocked' | 'unknown' | 'cancelled'; data?: T; problems: Problem[]; isError: boolean }

export const PI_GH_CONTRACT_VERSION = 1;
/** B1/B2/B3: generic pi-gh additions proposed in Epic #1. They do not exist in pi-gh 0.2.0. */
export const B_PROPOSAL_TOOLS = ['gh_issue_edit_if_current', 'gh_issue_labels_if_current', 'gh_issue_close_if_current'] as const;
const READ_TOOLS = new Set(['gh_labels_list', 'gh_capabilities', 'gh_issue_get', 'gh_issue_list', 'gh_subissues_list', 'gh_dependencies_list', 'gh_project_get', 'gh_project_items', 'gh_issue_validate', 'gh_issue_preview', 'gh_labels_validate', 'gh_labels_preview', 'gh_issue_form']);
export const isReadTool = (name: string) => READ_TOOLS.has(name);
/** Replacement text pi-gh 0.2.0 uses when masking secret candidates in results. */
export const PI_GH_MASK = '[REDACTED]';
const SUCCESS = new Set(['read', 'validated', 'preview', 'generated', 'created', 'applied']);

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
function upstreamProblems(sc: Rec): Problem[] {
  return Array.isArray(sc.problems) ? sc.problems.filter(isRecord).map(p => problem(String(p.code ?? 'PI_GH_PROBLEM'), String(p.path ?? ''), String(p.message ?? ''))) : [];
}

export class PiGhBridge {
  private readonly timeoutMs: number;
  private readonly interactiveWrites: boolean;
  /**
   * `interactiveWrites`: pi-gh may hold a write open for a human TUI approval, so writes are bounded only by
   * cancellation/session change, never by the call limit (a timed-out approval would be recorded as unknown).
   */
  constructor(private readonly execute: ToolExecutor, options: {timeoutMs?: number; interactiveWrites?: boolean} = {}) {
    this.timeoutMs = options.timeoutMs ?? LIMITS.callTimeoutMs;
    this.interactiveWrites = options.interactiveWrites ?? false;
  }

  /** Calls one pi-gh tool. Writes whose result cannot be decoded are `unknown`; reads are `blocked`. */
  async call<T>(name: string, args: unknown, decode: (data: unknown) => T | undefined, scope: CallScope): Promise<GhOutcome<T>> {
    const write = !isReadTool(name);
    const lost = (code: string, message: string): GhOutcome<T> => ({status: write ? 'unknown' : 'blocked', problems: [problem(code, name, message)], isError: true});
    if (!scope.isCurrent() || scope.signal.aborted) return {status: 'cancelled', problems: [problem('STALE_SCOPE', name, 'Session changed or the call was cancelled before it started.')], isError: true};
    const timeout = write && this.interactiveWrites ? undefined : AbortSignal.timeout(this.timeoutMs);
    const signal = timeout ? AbortSignal.any([scope.signal, timeout]) : scope.signal;
    let outcome: ToolOutcome;
    try {
      outcome = await new Promise<ToolOutcome>((resolve, reject) => {
        const onAbort = () => reject(timeout?.aborted ? new Error('TIMEOUT') : new Error('ABORTED'));
        signal.addEventListener('abort', onAbort, {once: true});
        this.execute(name, args, {signal}).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
      });
    } catch (error) {
      const m = (error as Error)?.message;
      return m === 'TIMEOUT' ? lost('TIMEOUT', `${name} did not answer within ${this.timeoutMs} ms.`) : lost(m === 'ABORTED' ? 'ABORTED' : 'EXECUTE_FAILED', `${name} could not be completed.`);
    }
    const sc = outcome?.result?.structuredContent;
    if (!isRecord(sc) || typeof sc.status !== 'string') return lost('MISSING_STRUCTURED_CONTENT', `${name} returned no structured result.`);
    const status = sc.status, upstream = upstreamProblems(sc);
    if (status === 'unknown') return {status: 'unknown', problems: upstream.length ? upstream : [problem('PI_GH_UNKNOWN', name, String(sc.message ?? 'Outcome is uncertain.'))], isError: true};
    if (status === 'rejected' || status === 'not-started') return {status: 'blocked', problems: upstream.length ? upstream : [problem('PI_GH_REJECTED', name, String(sc.message ?? status))], isError: true};
    if (outcome.isError) return lost('PI_GH_IS_ERROR', `${name} reported an error with status ${status}.`);
    if (status === 'noop') return {status: 'noop', problems: [], isError: false};
    if (!SUCCESS.has(status)) return lost('PI_GH_STATUS', `${name} returned unexpected status ${status}.`);
    let data: T | undefined;
    try { data = decode(sc.data); } catch { data = undefined; }
    if (data === undefined) return lost('DECODE_FAILED', `${name} returned data that does not match the expected schema.`);
    return {status: 'ok', data, problems: [], isError: false};
  }

  async requireCapabilities(required: readonly string[], scope: CallScope): Promise<Decoded<void>> {
    const r = await this.call('gh_capabilities', {}, d => isRecord(d) ? d : undefined, scope);
    if (r.status === 'cancelled') return failed(r.problems);
    if (r.status !== 'ok') return failed([problem('PI_GH_UNAVAILABLE', 'gh_capabilities', 'pi-gh is not loaded in this Pi process or did not answer.')]);
    const info = r.data!;
    if (info.contractVersion !== PI_GH_CONTRACT_VERSION || !Array.isArray(info.operations)) return failed([problem('CONTRACT_MISMATCH', 'gh_capabilities', `pi-gh contract ${String(info.contractVersion)} is not supported (need ${PI_GH_CONTRACT_VERSION}).`)]);
    const missing = required.filter(op => !(info.operations as unknown[]).includes(op));
    return missing.length ? failed(missing.map(op => problem('CAPABILITY_MISSING', op, `pi-gh does not provide ${op}; this operation stops instead of bypassing it.`))) : okValue(undefined);
  }
}

interface GithubIssue { number: number; title: string; body: string | null; state: 'open' | 'closed'; labels: string[]; html_url: string; pull_request?: unknown }
function decodeGithubIssue(d: unknown): GithubIssue | undefined {
  if (!isRecord(d) || !Number.isSafeInteger(d.number) || typeof d.title !== 'string' || (d.body !== null && typeof d.body !== 'string') || (d.state !== 'open' && d.state !== 'closed') || !Array.isArray(d.labels) || typeof d.html_url !== 'string') return undefined;
  const labels = d.labels.map(l => isRecord(l) ? l.name : l);
  if (labels.some(l => typeof l !== 'string')) return undefined;
  return {number: d.number as number, title: d.title, body: d.body as string | null, state: d.state, labels: labels as string[], html_url: d.html_url, ...(d.pull_request !== undefined ? {pull_request: d.pull_request} : {})};
}

/** Reads one Issue through pi-gh and returns a validated snapshot; any inconsistency blocks. */
export async function readIssue(repo: string, number: number, bridge: PiGhBridge, scope: CallScope): Promise<Decoded<IssueSnapshot>> {
  const r = await bridge.call('gh_issue_get', {repo, issue: number}, decodeGithubIssue, scope);
  if (r.status !== 'ok') return failed(r.problems);
  const issue = r.data!;
  if (issue.pull_request !== undefined || issue.number !== number || issue.html_url.toLowerCase() !== `https://github.com/${repo}/issues/${number}`.toLowerCase()) return failed([problem('GITHUB_IDENTITY', `issues/${number}`, 'Expected exactly this repository Issue (not a PR).')]);
  // pi-gh 0.2.0 redacts secret candidates in results without a flag; such text is not the real Issue content.
  if ((issue.body ?? '').includes(PI_GH_MASK) || issue.title.includes(PI_GH_MASK)) return failed([problem('BODY_MASKED', `issues/${number}`, 'pi-gh redacted part of this Issue as a secret candidate, so its exact content cannot be read. Remove the secret-like text from the Issue first.')]);
  return buildSnapshot({repo, number, title: issue.title, body: issue.body ?? '', labels: issue.labels, state: issue.state});
}
export {decodeGithubIssue};
