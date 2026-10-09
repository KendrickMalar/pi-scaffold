import {Type} from '@earendil-works/pi-ai';
import {defineScaffoldTool, mutationInputFields} from '../tool-kit.ts';
import {applyWaves, decodeWavesApplyInput, WAVES_APPLY, type WavesApplyInput} from '../../dist/src/services/waves-apply.js';
import type {ScaffoldRuntime} from '../../dist/src/core/runtime.js';

export function createTool(runtime: ScaffoldRuntime) {
  return defineScaffoldTool<WavesApplyInput>(runtime, {
    name: WAVES_APPLY,
    label: 'Scaffold: Waveの反映',
    description: 'Apply a basic-design Wave plan to the Features of an Epic. Everything is first checked like scaffold_waves_verify (every Feature '
      + 'exactly one Wave 1–200, dependency order, no edit conflicts in a Wave, current Feature-set and dependency digests); then missing "Wave: N" '
      + 'label definitions are created, each Feature\'s old Wave label is replaced by a conditional change that touches no other label, labels are '
      + 'read back, the plan is saved to the Epic and the whole state is checked again. Duplicate or non-canonical Wave labels stop the call (never '
      + 'cleaned up automatically). Applied Wave labels do not by themselves authorize implementation.',
    parameters: Type.Object({...mutationInputFields, plan: Type.Object({
      version: Type.Literal(1),
      assignments: Type.Array(Type.Object({issue: Type.Integer({minimum: 1}), wave: Type.Unknown({description: 'Integer 1–200'})}, {additionalProperties: false}), {maxItems: 50}),
      dependencyDigest: Type.String({pattern: '^[0-9a-f]{64}$'}), featureSetDigest: Type.String({pattern: '^[0-9a-f]{64}$'}),
    }, {additionalProperties: false})}, {additionalProperties: false}),
    executionMode: 'sequential', readOnly: false,
    decode: decodeWavesApplyInput,
    run: applyWaves,
  });
}
