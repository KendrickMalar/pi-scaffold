import {Type} from '@earendil-works/pi-ai';
import {defineScaffoldTool} from '../tool-kit.ts';
import {decodeLabelsEnsureInput, ensureLabels, LABELS_ENSURE, type LabelsEnsureInput} from '../../dist/src/services/labels-ensure.js';
import type {ScaffoldRuntime} from '../../dist/src/core/runtime.js';

export function createTool(runtime: ScaffoldRuntime) {
  return defineScaffoldTool<LabelsEnsureInput>(runtime, {
    name: LABELS_ENSURE,
    label: 'Scaffold: 管理ラベルの準備',
    description: 'Check the 211 Scaffold management labels (11 fixed + Wave: 1..200) in a repository and create only the missing ones through pi-gh. '
      + 'Differences in color/description/case block by default (onMismatch "update" edits them, still through pi-gh approval). '
      + 'Never renames or deletes other labels and never changes Issue labels. Long runs return partial; call again with the same operationId to continue.',
    parameters: Type.Object({
      repo: Type.String({pattern: '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$', description: 'OWNER/REPO (must match the origin of the trusted working directory).'}),
      operationId: Type.String({pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', description: 'Random UUID for this operation. Reuse it to resume.'}),
      onMismatch: Type.Optional(Type.Union([Type.Literal('block'), Type.Literal('update')])),
    }, {additionalProperties: false}),
    executionMode: 'sequential', readOnly: false,
    decode: decodeLabelsEnsureInput,
    run: ensureLabels,
  });
}
