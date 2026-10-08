import {Type} from '@earendil-works/pi-ai';
import {defineScaffoldTool, mutationInputFields} from '../tool-kit.ts';
import {decodeSpecificationUpdateInput, updateSpecification, SPECIFICATION_UPDATE, type SpecificationUpdateInput} from '../../dist/src/services/specification-update.js';
import type {ScaffoldRuntime} from '../../dist/src/core/runtime.js';

const text = Type.String({minLength: 1, pattern: '\\S'});
const ref = Type.String({minLength: 1, pattern: '\\S'});
const reqId = Type.String({pattern: '^REQ[0-9]{3,}$'});
export function createTool(runtime: ScaffoldRuntime) {
  return defineScaffoldTool<SpecificationUpdateInput>(runtime, {
    name: SPECIFICATION_UPDATE,
    label: 'Scaffold: 仕様の更新',
    description: 'Reflect only what the user actually said in the hearing into a specification-stage Epic. facts/requirements/criteria/decisions are '
      + 'stable-ID patches: given IDs are added or changed, others are kept; nothing is deleted or renumbered, and nothing is filled in. '
      + 'Unanswered questions stay answer=null. constraints/outOfScope replace the whole list (null = not set, [] = confirmed none). '
      + 'Returns missingFields; it never declares the specification complete. A stale body, a visible/JSON mismatch or a later stage writes nothing '
      + '(later stages return NEEDS_REVISION). Changing the baseline resets research progress (old results kept locally) and old approvals no longer match.',
    parameters: Type.Object({
      ...mutationInputFields,
      originalRequest: Type.Optional(Type.Object({text, sourceRefs: Type.Array(ref)}, {additionalProperties: false})),
      background: Type.Optional(Type.Union([text, Type.Null()])),
      facts: Type.Array(Type.Object({
        questionId: Type.String({pattern: '^Q[0-9]{3,}$'}), kind: Type.Union([Type.Literal('question'), Type.Literal('conflict')]), question: text,
        answer: Type.Union([text, Type.Null()]), required: Type.Boolean(), sourceRef: Type.Union([ref, Type.Null()]),
      }, {additionalProperties: false}), {maxItems: 100}),
      requirements: Type.Array(Type.Object({id: reqId, description: text}, {additionalProperties: false}), {maxItems: 100}),
      criteria: Type.Array(Type.Object({
        id: Type.String({pattern: '^AC[0-9]{3,}$'}), requirementIds: Type.Array(reqId, {minItems: 1}), verification: text, expectedResult: text,
      }, {additionalProperties: false}), {maxItems: 100}),
      constraints: Type.Union([Type.Array(text), Type.Null()]),
      outOfScope: Type.Union([Type.Array(text), Type.Null()]),
      decisions: Type.Array(Type.Object({
        id: Type.String({pattern: '^D[0-9]{3,}$'}), topic: text, decision: text, reason: text, sourceRefs: Type.Array(ref),
      }, {additionalProperties: false}), {maxItems: 100}),
    }, {additionalProperties: false}),
    executionMode: 'sequential', readOnly: false,
    decode: decodeSpecificationUpdateInput,
    run: updateSpecification,
  });
}
