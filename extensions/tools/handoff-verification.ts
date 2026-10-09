import {Type} from '@earendil-works/pi-ai';
import {defineScaffoldTool, mutationInputFields} from '../tool-kit.ts';
import {decodeVerificationHandoffInput, handoffVerification, HANDOFF_VERIFICATION, type VerificationHandoffInput} from '../../dist/src/services/handoff-verification.js';
import type {ScaffoldRuntime} from '../../dist/src/core/runtime.js';

export function createTool(runtime: ScaffoldRuntime) {
  return defineScaffoldTool<VerificationHandoffInput>(runtime, {
    name: HANDOFF_VERIFICATION,
    label: 'Scaffold: 検証セッションへの引き継ぎ',
    description: 'Hand an implementation-stage Epic to a NEW Pi session for verification, keeping the Epic open. integrationRef is a 40/64-hex commit '
      + 'that exists locally (never HEAD or a branch). evidenceRefs name one JSON report per native Feature (closed included) inside the workflow\'s '
      + 'owned evidence/ directory; every criterion of the Feature must be reported exactly once as pass with exit code 0, with its log present and '
      + 'matching its sha256, and productRef/suiteRef must be the integration commit or its ancestors. fail/unverified/missing evidence goes back to '
      + 'implementation. Only refs and hashes are checked — results are never treated as authenticated, tests are not re-run, nothing is closed and '
      + 'final acceptance stays with #16. The integration ref and evidence hashes are pinned into the handoff packet.',
    parameters: Type.Object({
      ...mutationInputFields,
      integrationRef: Type.String({pattern: '^([0-9a-f]{40}|[0-9a-f]{64})$'}),
      evidenceRefs: Type.Array(Type.Object({relativePath: Type.String({minLength: 1}), sha256: Type.String({pattern: '^[0-9a-f]{64}$'})}, {additionalProperties: false}), {minItems: 1, maxItems: 50}),
    }, {additionalProperties: false}),
    executionMode: 'sequential', readOnly: false,
    decode: decodeVerificationHandoffInput,
    run: handoffVerification,
  });
}
