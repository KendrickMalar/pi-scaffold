import {Type} from '@earendil-works/pi-ai';
import {defineScaffoldTool, mutationInputFields} from '../tool-kit.ts';
import {beginResearch, decodeResearchBeginInput, RESEARCH_BEGIN, type ResearchBeginInput} from '../../dist/src/services/research-begin.js';
import type {ScaffoldRuntime} from '../../dist/src/core/runtime.js';

export function createTool(runtime: ScaffoldRuntime) {
  return defineScaffoldTool<ResearchBeginInput>(runtime, {
    name: RESEARCH_BEGIN,
    label: 'Scaffold: 調査への着手',
    description: 'Mark the named pending research items of a specification-stage Epic as in progress under one claim (this operationId, '
      + 'this session, the current specification baseline) and return a brief per item: question, purpose/background, required evidence, '
      + 'done condition and fixed stop conditions. Does NOT run the research, call a model or start an agent. Resolved items are skipped; '
      + 'items claimed under another operation are never taken over. Briefs are returned only after the claim is read back from the Issue; '
      + 're-running the same operationId returns the same briefs.',
    parameters: Type.Object({...mutationInputFields, researchIds: Type.Array(Type.String({pattern: '^R[0-9]{3,}$'}), {minItems: 1, maxItems: 50})}, {additionalProperties: false}),
    executionMode: 'sequential', readOnly: false,
    decode: decodeResearchBeginInput,
    run: beginResearch,
  });
}
