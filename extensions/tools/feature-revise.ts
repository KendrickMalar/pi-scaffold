import {Type} from '@earendil-works/pi-ai';
import {defineScaffoldTool, mutationInputFields} from '../tool-kit.ts';
import {decodeFeatureReviseInput, reviseFeature, FEATURE_REVISE, type FeatureReviseInput} from '../../dist/src/services/feature-revise.js';
import type {ScaffoldRuntime} from '../../dist/src/core/runtime.js';

const text = Type.String({minLength: 1, pattern: '\\S'});
export function createTool(runtime: ScaffoldRuntime) {
  return defineScaffoldTool<FeatureReviseInput>(runtime, {
    name: FEATURE_REVISE,
    label: 'Scaffold: Featureの基準の更新',
    description: 'Replace the acceptance criteria (and optionally the design reference) of ONE Feature of an Epic in basic-design, implementation or '
      + 'verification, typically after scaffold_specification_revise. expectedRevision/expectedBodySha256 are the Feature\'s own. Criteria must reference '
      + 'the Epic\'s requirements and keep an Epic AC ID\'s exact content; a designRef must exist at gitRef with that sha256. Releases the Blocked label only '
      + 'when a specification revision of the Epic blocked this Feature; any other Blocked stays. Never changes the stage, Wave or bindings.',
    parameters: Type.Object({
      ...mutationInputFields,
      featureIssue: Type.Integer({minimum: 1}),
      criteria: Type.Array(Type.Object({id: Type.String({pattern: '^AC[0-9]{3,}$'}), requirementIds: Type.Array(Type.String({pattern: '^REQ[0-9]{3,}$'}), {minItems: 1}), verification: text, expectedResult: text}, {additionalProperties: false}), {minItems: 1, maxItems: 100}),
      designRef: Type.Optional(Type.Object({path: text, sha256: Type.String({pattern: '^[0-9a-f]{64}$'}), gitRef: Type.String({pattern: '^([0-9a-f]{40}|[0-9a-f]{64})$'})}, {additionalProperties: false})),
    }, {additionalProperties: false}),
    executionMode: 'sequential', readOnly: false,
    decode: decodeFeatureReviseInput,
    run: reviseFeature,
  });
}
