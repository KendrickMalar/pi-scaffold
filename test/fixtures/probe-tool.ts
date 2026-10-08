// Test-only tool that exercises the #2 foundation end to end. It is never registered in extensions/register-tools.ts.
import {Type} from '@earendil-works/pi-ai';
import {join} from 'node:path';
import {defineScaffoldTool, mutationInputFields} from '../../extensions/tool-kit.ts';
import {decodeMutationInput, problem, type MutationInput} from '../../dist/src/core/contracts.js';
import {readIssue} from '../../dist/src/ports/pi-gh.js';
import {withOperation} from '../../dist/src/core/lifecycle.js';
import {taggedDigest} from '../../dist/src/core/digests.js';
import {writeOwnedFile} from '../../dist/src/core/files.js';
import type {ScaffoldRuntime} from '../../dist/src/core/runtime.js';

export function createTool(runtime: ScaffoldRuntime) {
  return defineScaffoldTool<MutationInput>(runtime, {
    name: 'scaffold_test_probe', label: 'Foundation probe (test only)', description: 'Test-only probe of the pi-scaffold foundation.',
    parameters: Type.Object(mutationInputFields, {additionalProperties: false}),
    executionMode: 'sequential', readOnly: false,
    decode: raw => decodeMutationInput(raw),
    async run(input, call) {
      const operation = 'scaffold_test_probe';
      const caps = await call.bridge.requireCapabilities(['gh_issue_get', 'gh_issue_edit'], call.scope);
      if (!caps.ok) return {status: 'blocked', operation, problems: caps.problems};
      const repoOnly = await call.repoContext(input.repo, null);
      if (!repoOnly.ok) return {status: 'blocked', operation, problems: repoOnly.problems};
      const snap = await readIssue(input.repo, input.epicIssue, call.bridge, call.scope);
      if (!snap.ok) return {status: 'blocked', operation, problems: snap.problems};
      const context = await call.repoContext(input.repo, snap.value.doc.workflowId);
      if (!context.ok) return {status: 'blocked', operation, problems: context.problems};
      const body = snap.value.body + '\n(probe)';
      return withOperation({operation, repo: input.repo, workflowId: snap.value.doc.workflowId, operationId: input.operationId, payloadDigest: taggedDigest('probe', input), journal: call.journal(context.value), scope: call.scope}, async run => {
        if (snap.value.bodySha256 !== input.expectedBodySha256) run.stop([problem('STALE_BODY', 'expectedBodySha256', 'Issue body changed.')]);
        if (snap.value.doc.revision !== input.expectedRevision) run.stop([problem('STALE_REVISION', 'expectedRevision', 'Revision changed.')]);
        const changePath = join(context.value.workflowStateRoot, 'artifacts', `${input.operationId}.json`);
        await writeOwnedFile(changePath, JSON.stringify({version: 1, repo: input.repo, operation: 'issue-edit', issue: input.epicIssue, body}), {root: call.namespaceRoot});
        const data = await run.write('issue-edit', () => call.bridge.call('gh_issue_edit', {changePath}, d => d, call.scope));
        return {status: 'applied', data: {edited: data !== undefined}};
      });
    },
  });
}
