import {Type} from '@earendil-works/pi-ai';
import {defineScaffoldTool, mutationInputFields} from '../tool-kit.ts';
import {createFeature, decodeFeatureCreateInput, FEATURE_CREATE, type FeatureCreateInput} from '../../dist/src/services/feature-create.js';
import type {ScaffoldRuntime} from '../../dist/src/core/runtime.js';

const text = Type.String({minLength: 1, pattern: '\\S'});
const binding = Type.Object({model: Type.String({pattern: '^[^/\\s]+/\\S+$'}), thinking: Type.Union(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(t => Type.Literal(t))), reason: text}, {additionalProperties: false});
export function createTool(runtime: ScaffoldRuntime) {
  return defineScaffoldTool<FeatureCreateInput>(runtime, {
    name: FEATURE_CREATE,
    label: 'Scaffold: Featureの作成',
    description: 'Create ONE Feature Issue of a basic-design Epic from an explicit decomposition (the tool decides nothing). Requires a valid parent '
      + 'approval of the current specification, acceptance criteria that reference the Epic\'s requirements (an Epic AC ID must keep its exact content), '
      + 'basic-tier coding-manager/coder/tester bindings allowed by the owner policy, and a design document that exists at gitRef with the given sha256. '
      + 'Creates the Issue with the pi-gh task template under the real Epic (labels Type: Scaffold, Scope: Feature, Stage: BasicDesign), attaches it as '
      + 'a native sub-issue and reads it back. Never edits the Epic, starts agents or changes models. Re-running the same operationId never posts twice. '
      + 'editScope lists repo-relative directory or file paths (e.g. "src", "src/a.ts"). Empty, root ("."), glob ("src/**", "*"), absolute ("/") '
      + 'and ".." entries cannot be judged by scaffold_waves_verify, so each is refused as UNKNOWN_SCOPE before anything is written; use "src", not "src/**".',
    parameters: Type.Object({
      ...mutationInputFields,
      featureKey: Type.String({pattern: '^F[0-9]{3,}$'}),
      title: Type.String({minLength: 1, maxLength: 256, pattern: '^[^\\r\\n]*\\S[^\\r\\n]*$'}),
      purpose: text, editScope: Type.Array(text, {minItems: 1}), outOfScope: Type.Array(text),
      designRef: Type.Object({path: text, sha256: Type.String({pattern: '^[0-9a-f]{64}$'}), gitRef: Type.String({pattern: '^([0-9a-f]{40}|[0-9a-f]{64})$'})}, {additionalProperties: false}),
      criteria: Type.Array(Type.Object({id: Type.String({pattern: '^AC[0-9]{3,}$'}), requirementIds: Type.Array(Type.String({pattern: '^REQ[0-9]{3,}$'}), {minItems: 1}), verification: text, expectedResult: text}, {additionalProperties: false}), {minItems: 1, maxItems: 100}),
      bindings: Type.Object({'coding-manager': binding, coder: binding, tester: binding}, {additionalProperties: false}),
    }, {additionalProperties: false}),
    executionMode: 'sequential', readOnly: false,
    decode: decodeFeatureCreateInput,
    run: createFeature,
  });
}
