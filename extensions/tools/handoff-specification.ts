import {Type} from '@earendil-works/pi-ai';
import {defineScaffoldTool, mutationInputFields} from '../tool-kit.ts';
import {decodeHandoffSpecificationInput, handoffSpecification, HANDOFF_SPECIFICATION} from '../../dist/src/services/handoff-specification.js';
import type {HandoffInput} from '../../dist/src/handoff/driver.js';
import type {ScaffoldRuntime} from '../../dist/src/core/runtime.js';

export function createTool(runtime: ScaffoldRuntime) {
  return defineScaffoldTool<HandoffInput>(runtime, {
    name: HANDOFF_SPECIFICATION,
    label: 'Scaffold: 仕様策定セッションへの引き継ぎ',
    description: 'Hand a setup Epic to a NEW Pi session (new Herdr tab, Development Profile) for specification. Checks the draft '
      + '(title/purpose/original request and well-formed records; unanswered questions and pending research are fine), commits Stage: '
      + 'Specification only after the new session confirms the packet, then sends the fixed stage prompt. Completes only when the new '
      + 'session starts its turn; otherwise returns partial and resumes with the same operationId. Never closes tabs or reuses this conversation.',
    parameters: Type.Object({...mutationInputFields, expectedStage: Type.Literal('setup'), nextStage: Type.Literal('specification')}, {additionalProperties: false}),
    executionMode: 'sequential', readOnly: false,
    decode: decodeHandoffSpecificationInput,
    run: handoffSpecification,
  });
}
