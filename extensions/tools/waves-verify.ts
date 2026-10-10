import {Type} from '@earendil-works/pi-ai';
import {defineScaffoldTool} from '../tool-kit.ts';
import {decodeWavesVerifyInput, verifyWaves, WAVES_VERIFY, type WavesVerifyInput} from '../../dist/src/services/waves-verify.js';
import type {ScaffoldRuntime} from '../../dist/src/core/runtime.js';

export function createTool(runtime: ScaffoldRuntime) {
  return defineScaffoldTool<WavesVerifyInput>(runtime, {
    name: WAVES_VERIFY,
    label: 'Scaffold: Wave割り当ての検証',
    description: 'Read-only check of an Epic\'s execution Waves: every native Feature (closed included) has exactly one Wave 1–200; each dependency '
      + 'from→to has wave(from) < wave(to); Features sharing a Wave do not edit overlapping paths or shared manifests/lockfiles/state '
      + '(migrations, workflows, schema), and undecidable edit scopes never pass; labels show exactly one canonical "Wave: N" matching the plan; '
      + 'GitHub dependencies equal the saved dependency plan. Checks the given plan or the Epic\'s saved one. Changes during reading never pass. '
      + 'Never fixes, labels or touches Projects. Call this first to get the digests a plan must carry: data.dependencyDigest (from the Epic\'s saved '
      + 'dependency plan; null with DEPENDENCY_PLAN_UNSET while none is saved) and data.featureSetDigest are returned whenever the Epic and its '
      + 'Features were read consistently, also when the plan does not pass or no plan is given.',
    parameters: Type.Object({
      repo: Type.String({pattern: '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$'}),
      epicIssue: Type.Integer({minimum: 1}),
      plan: Type.Optional(Type.Object({
        version: Type.Literal(1),
        // wave is checked by the tool (1–200 integer) so a bad value is reported as "not passed" instead of a schema error.
        assignments: Type.Array(Type.Object({issue: Type.Integer({minimum: 1}), wave: Type.Unknown({description: 'Integer 1–200'})}, {additionalProperties: false}), {maxItems: 50}),
        dependencyDigest: Type.String({pattern: '^[0-9a-f]{64}$'}), featureSetDigest: Type.String({pattern: '^[0-9a-f]{64}$'}),
      }, {additionalProperties: false})),
    }, {additionalProperties: false}),
    executionMode: 'parallel', readOnly: true,
    decode: decodeWavesVerifyInput,
    run: verifyWaves,
  });
}
