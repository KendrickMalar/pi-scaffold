// Fixed documents an Epic pins as `<docs/...>@sha256:<hex>[@commit:<sha>]` in its sourceRefs. The receiving stage session
// must be able to read each one from its cwd with the same bytes; otherwise it would work from the wrong checkout.
import {readFile, realpath, stat} from 'node:fs/promises';
import {join, sep} from 'node:path';
import {createHash} from 'node:crypto';
import {LIMITS, problem, type EpicDocV1, type Problem} from './contracts.js';

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

/** Problem codes with a path worth showing render as `CODE(path)`; others stay bare. */
export function formatProblemCodes(problems: readonly Problem[]): string {
  return problems.map(p => p.code === 'RECEIVER_DOC_MISMATCH' ? `${p.code}(${p.path})` : p.code).join(', ');
}

export async function verifyPinnedDocs(cwd: string, refs: readonly string[]): Promise<Problem[]> {
  const problems: Problem[] = [];
  const bad = (path: string, msg: string) => problems.push(problem('RECEIVER_DOC_MISMATCH', path, msg));
  for (const ref of refs) {
    const m = REF.exec(ref);
    if (!m) continue;
    const [, path, want] = m as unknown as [string, string, string];
    if (path.split('/').includes('..')) { bad(path, `${path} contains a ".." segment and is not read.`); continue; }
    let real: string;
    let root: string;
    try { [real, root] = await Promise.all([realpath(join(cwd, path)), realpath(cwd)]); } catch { bad(path, `${path} is not readable in ${cwd}.`); continue; }
    if (!real.startsWith(root.endsWith(sep) ? root : root + sep)) { bad(path, `${path} resolves outside ${cwd} and is not read.`); continue; }
    let got: string | undefined;
    try {
      if ((await stat(real)).size > LIMITS.artifactBytes) { bad(path, `${path} exceeds ${LIMITS.artifactBytes} bytes and is not hashed.`); continue; }
      got = createHash('sha256').update(await readFile(real)).digest('hex');
    } catch { got = undefined; }
    if (got !== want) bad(path, got ? `${path} differs from the pinned sha256 in ${cwd}.` : `${path} is not readable in ${cwd}.`);
  }
  return problems;
}
