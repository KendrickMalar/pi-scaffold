import {Type} from '@earendil-works/pi-ai';
import {defineScaffoldTool, mutationInputFields} from '../tool-kit.ts';
import {decodeBasicDesignHandoffInput, handoffBasicDesign, HANDOFF_BASIC_DESIGN} from '../../dist/src/services/handoff-basic-design.js';
import type {MutationInput} from '../../dist/src/core/contracts.js';
import type {ScaffoldRuntime} from '../../dist/src/core/runtime.js';

export function createTool(runtime: ScaffoldRuntime) {
  return defineScaffoldTool<MutationInput>(runtime, {
    name: HANDOFF_BASIC_DESIGN,
    label: 'Scaffold: 基本設計セッションへの引き継ぎ',
    description: 'Hand a specification-stage Epic to a NEW Pi session for basic design. Requires a complete specification (purpose, original request, '
      + 'requirements each covered by acceptance criteria, constraints/outOfScope confirmed ([] = none), required questions answered, no open conflict, '
      + 'all research resolved) and a parent-TUI approval of exactly this specification (headless sessions may only reference an existing approval; '
      + 'public "approved" text or decision records are not approvals). Then uses the shared handoff (#5): new Herdr tab, Stage: BasicDesign committed '
      + 'only after the new session confirms, applied only when it starts its turn. Does not create the basic design.',
    parameters: Type.Object({...mutationInputFields}, {additionalProperties: false}),
    executionMode: 'sequential', readOnly: false,
    decode: decodeBasicDesignHandoffInput,
    run: handoffBasicDesign,
  });
}
