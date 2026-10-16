import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {formatProblemCodes, pinnedDocRefs, verifyPinnedDocs} from '../src/core/pinned-docs.js';
import {LIMITS, problem} from '../src/core/contracts.js';
import {populatedDoc} from './helpers/docs.js';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const A = sha('gdd'), B = sha('map');

test('pinnedDocRefs keeps only repo-relative docs/ refs with a sha256, dedups and sorts', () => {
  const d = populatedDoc();
  d.originalRequest.sourceRefs = ['https://github.com/o/r/issues/1', `docs/spec/gdd.md@sha256:${A}`, `docs/spec/map.md@sha256:${B}@commit:${'c'.repeat(40)}`,
    `docs/../etc/passwd@sha256:${A}`, `/abs/docs/x.md@sha256:${A}`, '企画Issue本文SHA-256: ' + A];
  d.decisions = d.decisions.map(x => ({...x, sourceRefs: [`docs/spec/gdd.md@sha256:${A}`]}));
  assert.deepEqual(pinnedDocRefs(d), [`doc:docs/spec/gdd.md@sha256:${A}`, `doc:docs/spec/map.md@sha256:${B}`]);
});

test('verifyPinnedDocs passes on matching files and names each missing or changed file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pinned-docs-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  await mkdir(join(dir, 'docs/spec'), {recursive: true});
  await writeFile(join(dir, 'docs/spec/gdd.md'), 'gdd');
  await writeFile(join(dir, 'docs/spec/map.md'), 'changed');
  assert.deepEqual(await verifyPinnedDocs(dir, [`doc:docs/spec/gdd.md@sha256:${A}`]), []);
  const p = await verifyPinnedDocs(dir, [`doc:docs/spec/map.md@sha256:${B}`, `doc:docs/spec/none.md@sha256:${A}`]);
  assert.deepEqual(p.map(x => [x.code, x.path]), [['RECEIVER_DOC_MISMATCH', 'docs/spec/map.md'], ['RECEIVER_DOC_MISMATCH', 'docs/spec/none.md']]);
});

test('verifyPinnedDocs refuses symlinks escaping cwd, oversized files and ".." segments', async t => {
  const base = await mkdtemp(join(tmpdir(), 'pinned-docs-'));
  t.after(() => rm(base, {recursive: true, force: true}));
  const dir = join(base, 'repo');
  await mkdir(join(dir, 'docs'), {recursive: true});
  await writeFile(join(base, 'outside.md'), 'gdd');
  await symlink(join(base, 'outside.md'), join(dir, 'docs/link.md'));
  const big = 'x'.repeat(LIMITS.artifactBytes + 1);
  await writeFile(join(dir, 'docs/big.md'), big);
  const p = await verifyPinnedDocs(dir, [`doc:docs/link.md@sha256:${A}`, `doc:docs/big.md@sha256:${sha(big)}`, `doc:docs/../x.md@sha256:${A}`]);
  assert.deepEqual(p.map(x => [x.code, x.path]), [['RECEIVER_DOC_MISMATCH', 'docs/link.md'], ['RECEIVER_DOC_MISMATCH', 'docs/big.md'], ['RECEIVER_DOC_MISMATCH', 'docs/../x.md']]);
  assert.match(p[0]!.message, /outside/);
  assert.match(p[1]!.message, /exceeds/);
});

test('formatProblemCodes shows the path only for RECEIVER_DOC_MISMATCH', () => {
  assert.equal(formatProblemCodes([problem('RECEIVER_DOC_MISMATCH', 'docs/a.md', 'm'), problem('REQUIRED_TOOL_MISSING', 'tools', 'm')]), 'RECEIVER_DOC_MISMATCH(docs/a.md), REQUIRED_TOOL_MISSING');
});
