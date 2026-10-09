import {Type} from '@earendil-works/pi-ai';
import {defineScaffoldTool, mutationInputFields} from '../tool-kit.ts';
import {decodeImplementationHandoffInput, handoffImplementation, HANDOFF_IMPLEMENTATION} from '../../dist/src/services/handoff-implementation.js';
import type {MutationInput} from '../../dist/src/core/contracts.js';
import type {ScaffoldRuntime} from '../../dist/src/core/runtime.js';

export function createTool(runtime: ScaffoldRuntime) {
  return defineScaffoldTool<MutationInput>(runtime, {
    name: HANDOFF_IMPLEMENTATION,
    label: 'Scaffold: 詳細設計・実装セッションへの引き継ぎ',
    description: 'Hand a basic-design Epic to a NEW Pi session for detailed design and implementation. Requires: the design document at its recorded '
      + 'commit and hash; every native Feature with criteria inside the Epic that together cover every requirement, allowed model bindings and a valid '
      + 'design reference; a saved Wave plan that passes scaffold_waves_verify; and a parent-TUI start approval of exactly this specification/design/'
      + 'Features/criteria/Waves (headless sessions may only reference an existing one; decision records or the specification approval do not count). '
      + 'Then uses the shared handoff (#5): only the Epic moves to Stage: Implementation, applied only when the new session starts its turn. '
      + 'Starts no implementer and never reports implementation as done.',
    parameters: Type.Object({...mutationInputFields}, {additionalProperties: false}),
    executionMode: 'sequential', readOnly: false,
    decode: decodeImplementationHandoffInput,
    run: handoffImplementation,
  });
}
