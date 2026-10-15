// Fixed documents an Epic pins as `<docs/...>@sha256:<hex>[@commit:<sha>]` in its sourceRefs. The receiving stage session
// must be able to read each one from its cwd with the same bytes; otherwise it would work from the wrong checkout.
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {problem, type EpicDocV1, type Problem} from './contracts.js';

const PIN = /^(docs\/(?:[^@\s/.][^@\s/]*\/)*[^@\s/]+)@sha256:([0-9a-f]{64})(?:@commit:[0-9a-f]{40})?$/;
const REF = /^doc:(docs\/[^@\s]+)@sha256:([0-9a-f]{64})$/;

export function pinnedDocRefs(doc: EpicDocV1): string[] {
  const all = [...doc.originalRequest.sourceRefs, ...doc.decisions.flatMap(d => d.sourceRefs)];
  const refs = new Set<string>();
  for (const s of all) {
    const m = PIN.exec(s);
    if (m && !m[1]!.split('/').includes('..')) refs.add(`doc:${m[1]}@sha256:${m[2]}`);
  }
  return [...refs].sort();
}

export async function verifyPinnedDocs(cwd: string, refs: readonly string[]): Promise<Problem[]> {
  const problems: Problem[] = [];
  for (const ref of refs) {
    const m = REF.exec(ref);
    if (!m) continue;
    const [, path, want] = m as unknown as [string, string, string];
    let got: string | undefined;
    try { got = createHash('sha256').update(await readFile(join(cwd, path))).digest('hex'); } catch { got = undefined; }
    if (got !== want) problems.push(problem('RECEIVER_DOC_MISMATCH', path, got ? `${path} differs from the pinned sha256 in ${cwd}.` : `${path} is not readable in ${cwd}.`));
  }
  return problems;
}
