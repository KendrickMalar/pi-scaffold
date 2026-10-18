import {Type} from '@earendil-works/pi-ai';
import {defineScaffoldTool, mutationInputFields} from '../tool-kit.ts';
import {decodeSpecificationReviseInput, reviseSpecification, SPECIFICATION_REVISE, type SpecificationReviseInput} from '../../dist/src/services/specification-revise.js';
import type {ScaffoldRuntime} from '../../dist/src/core/runtime.js';

const text = Type.String({minLength: 1, pattern: '\\S'});
const ref = Type.String({minLength: 1, pattern: '\\S'});
const reqId = Type.String({pattern: '^REQ[0-9]{3,}$'});
export function createTool(runtime: ScaffoldRuntime) {
  return defineScaffoldTool<SpecificationReviseInput>(runtime, {
    name: SPECIFICATION_REVISE,
    label: 'Scaffold: 承認済み仕様の改訂',
    description: 'Revise the approved specification of an Epic in basic-design, implementation or verification, when the intent itself must change '
      + '(decisions inside the approved intent are just recorded, not revised). Same stable-ID patch as scaffold_specification_update (add/change only), '
      + 'plus a reason. The revised specification must still be complete; research results are kept. The revision is approved by the parent agent when '
      + 'the owner policy lists specification-revision in agentApprovals, otherwise in the parent TUI; a subagent child cannot revise. The Epic stage does '
      + 'not move; the revision is appended to the Epic\'s specRevisions, and only the Features whose criteria use a changed REQ/AC ID get Blocked. '
      + 'Bring each of them in line with scaffold_feature_revise, which releases Blocked.',
    parameters: Type.Object({
      ...mutationInputFields,
      reason: text,
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
      constraints: Type.Optional(Type.Union([Type.Array(text), Type.Null()])),
      outOfScope: Type.Optional(Type.Union([Type.Array(text), Type.Null()])),
      decisions: Type.Array(Type.Object({
        id: Type.String({pattern: '^D[0-9]{3,}$'}), topic: text, decision: text, reason: text, sourceRefs: Type.Array(ref),
      }, {additionalProperties: false}), {maxItems: 100}),
    }, {additionalProperties: false}),
    executionMode: 'sequential', readOnly: false,
    decode: decodeSpecificationReviseInput,
    run: reviseSpecification,
  });
}
