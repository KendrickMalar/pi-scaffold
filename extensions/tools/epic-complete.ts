import {Type} from '@earendil-works/pi-ai';
import {defineScaffoldTool, mutationInputFields} from '../tool-kit.ts';
import {completeEpic, decodeEpicCompleteInput, EPIC_COMPLETE, type EpicCompleteInput} from '../../dist/src/services/epic-complete.js';
import type {ScaffoldRuntime} from '../../dist/src/core/runtime.js';

export function createTool(runtime: ScaffoldRuntime) {
  return defineScaffoldTool<EpicCompleteInput>(runtime, {
    name: EPIC_COMPLETE,
    label: 'Scaffold: Epicの完了',
    description: 'Complete a verification-stage Epic after the parent\'s final acceptance in the TUI. Checks: complete specification, every requirement '
      + 'covered by Feature criteria whose final evidence (owned reports/logs, hashes) passed on verifiedRef or its ancestors, and verifiedRef (a full '
      + 'commit id) contained in origin\'s default branch as `git ls-remote` reports it — if that commit is not local, stop and ask the user to fetch '
      + '(never fetch/merge/push). Optional project {projectId,itemId,statusFieldId,doneOptionId} is validated up front. Then: body/Stage → Completed, '
      + 'close, read back, Project Done, read back. Partial progress resumes with the same operationId (no second close). No reopen, rollback, '
      + 'release or notification; evidence authenticity is not claimed.',
    parameters: Type.Object({
      ...mutationInputFields,
      verifiedRef: Type.String({pattern: '^([0-9a-f]{40}|[0-9a-f]{64})$'}),
      finalEvidenceRefs: Type.Array(Type.Object({relativePath: Type.String({minLength: 1}), sha256: Type.String({pattern: '^[0-9a-f]{64}$'})}, {additionalProperties: false}), {minItems: 1, maxItems: 50}),
      project: Type.Optional(Type.Object({projectId: Type.String({pattern: '^PVT_'}), itemId: Type.String({pattern: '^PVTI_'}), statusFieldId: Type.String({pattern: '^PVTSSF_'}), doneOptionId: Type.String({minLength: 1})}, {additionalProperties: false})),
    }, {additionalProperties: false}),
    executionMode: 'sequential', readOnly: false,
    decode: decodeEpicCompleteInput,
    run: completeEpic,
  });
}
