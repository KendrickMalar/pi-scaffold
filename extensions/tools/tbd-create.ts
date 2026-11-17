import {Type} from '@earendil-works/pi-ai';
import {defineScaffoldTool} from '../tool-kit.ts';
import {createTbd, decodeTbdCreateInput, TBD_CREATE, type TbdCreateInput} from '../../dist/src/services/tbd-create.js';
import type {ScaffoldRuntime} from '../../dist/src/core/runtime.js';

const text = Type.String({minLength: 1, pattern: '\\S'});
const ref = Type.String({minLength: 1, pattern: '\\S'});
export function createTool(runtime: ScaffoldRuntime) {
  return defineScaffoldTool<TbdCreateInput>(runtime, {
    name: TBD_CREATE,
    label: 'Scaffold: TBDの作成',
    description: 'Record a request as a TBD Issue (labels Type: Scaffold and Scope: TBD) before the setup stage, through deterministic-gh. '
      + 'The original request is kept verbatim; answered questions need a sourceRef. Nothing is invented and no Epic is created. '
      + 'Re-running the same operationId returns the same Issue. The session model is recorded as planner, never called. Requires scaffold_labels_ensure first. '
      + 'Later, scaffold_epic_draft_create with tbdIssue creates the Epic from it and closes the TBD.',
    parameters: Type.Object({
      repo: Type.String({pattern: '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$'}),
      operationId: Type.String({pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'}),
      title: Type.String({minLength: 1, maxLength: 256, pattern: '^[^\\r\\n]*\\S[^\\r\\n]*$'}),
      originalRequest: Type.Object({text, sourceRefs: Type.Array(ref)}, {additionalProperties: false}),
      background: Type.Optional(Type.Union([text, Type.Null()])),
      initialFacts: Type.Optional(Type.Array(Type.Object({
        questionId: Type.String({pattern: '^Q[0-9]{3,}$'}), kind: Type.Union([Type.Literal('question'), Type.Literal('conflict')]), question: text,
        answer: Type.Union([text, Type.Null()]), required: Type.Boolean(), sourceRef: Type.Union([ref, Type.Null()]),
      }, {additionalProperties: false}), {maxItems: 100})),
      research: Type.Optional(Type.Array(Type.Object({
        researchId: Type.String({pattern: '^R[0-9]{3,}$'}), question: text, requiredEvidence: text, doneCondition: text,
      }, {additionalProperties: false}), {maxItems: 50})),
    }, {additionalProperties: false}),
    executionMode: 'sequential', readOnly: false,
    decode: decodeTbdCreateInput,
    run: createTbd,
  });
}
