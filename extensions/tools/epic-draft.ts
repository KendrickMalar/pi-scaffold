import {Type} from '@earendil-works/pi-ai';
import {defineScaffoldTool} from '../tool-kit.ts';
import {createEpicDraft, decodeEpicDraftInput, EPIC_DRAFT_CREATE, type EpicDraftInput} from '../../dist/src/services/epic-draft.js';
import type {ScaffoldRuntime} from '../../dist/src/core/runtime.js';

const text = Type.String({minLength: 1, pattern: '\\S'});
const ref = Type.String({minLength: 1, pattern: '\\S'});
const qId = {pattern: '^Q[0-9]{3,}$'};
export function createTool(runtime: ScaffoldRuntime) {
  return defineScaffoldTool<EpicDraftInput>(runtime, {
    name: EPIC_DRAFT_CREATE,
    label: 'Scaffold: Epicの下書き作成',
    description: 'Create a strict Epic draft from the title, purpose and original request only (no requirements are invented). '
      + 'mode "prepare" writes a local draft only; the default "publish" creates one unfinished Epic through pi-gh with labels Type: Scaffold and Scope: Epic (no Stage). '
      + 'Re-running the same operationId returns the same Issue. The session model is recorded as planner, never called. Requires scaffold_labels_ensure first.',
    parameters: Type.Object({
      repo: Type.String({pattern: '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$'}),
      operationId: Type.String({pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'}),
      title: Type.String({minLength: 1, maxLength: 256, pattern: '^[^\\r\\n]*\\S[^\\r\\n]*$'}),
      purpose: text,
      originalRequest: Type.Object({text, sourceRefs: Type.Array(ref)}, {additionalProperties: false}),
      background: Type.Optional(Type.Union([text, Type.Null()])),
      initialFacts: Type.Optional(Type.Array(Type.Object({
        questionId: Type.String(qId), kind: Type.Union([Type.Literal('question'), Type.Literal('conflict')]), question: text,
        answer: Type.Union([text, Type.Null()]), required: Type.Boolean(), sourceRef: Type.Union([ref, Type.Null()]),
      }, {additionalProperties: false}), {maxItems: 100})),
      research: Type.Optional(Type.Array(Type.Object({
        researchId: Type.String({pattern: '^R[0-9]{3,}$'}), question: text, requiredEvidence: text, doneCondition: text,
      }, {additionalProperties: false}), {maxItems: 50})),
      mode: Type.Optional(Type.Union([Type.Literal('prepare'), Type.Literal('publish')])),
    }, {additionalProperties: false}),
    executionMode: 'sequential', readOnly: false,
    decode: decodeEpicDraftInput,
    run: createEpicDraft,
  });
}
