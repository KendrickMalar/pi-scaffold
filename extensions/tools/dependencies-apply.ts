import {Type} from '@earendil-works/pi-ai';
import {defineScaffoldTool, mutationInputFields} from '../tool-kit.ts';
import {applyDependencies, decodeDependenciesApplyInput, DEPENDENCIES_APPLY, type DependenciesApplyInput} from '../../dist/src/services/dependencies-apply.js';
import type {ScaffoldRuntime} from '../../dist/src/core/runtime.js';

const text = Type.String({minLength: 1, pattern: '\\S'});
const issue = Type.Integer({minimum: 1});
export function createTool(runtime: ScaffoldRuntime) {
  return defineScaffoldTool<DependenciesApplyInput>(runtime, {
    name: DEPENDENCIES_APPLY,
    label: 'Scaffold: Feature依存の登録',
    description: 'Check and register dependencies between the Features of a basic-design Epic. plan.nodes must list every Feature (closed included) '
      + 'with its featureKey and exact editScope; edges go from the earlier Feature (from) to the later one (to), registered as "to is blocked by from". '
      + 'Rejects self edges, duplicates, unknown nodes and cycles (existing edges included). Existing dependencies must be in the plan; nothing is ever '
      + 'removed, and dependencies outside the Feature set stop the call. Adds only missing edges, optionally adds the Features to an EXISTING Project '
      + '(projectId), then saves the plan and a fixed-ID Mermaid diagram in the Epic.',
    parameters: Type.Object({
      ...mutationInputFields,
      plan: Type.Object({
        version: Type.Literal(1),
        nodes: Type.Array(Type.Object({featureKey: Type.String({pattern: '^F[0-9]{3,}$'}), issue, contracts: Type.Array(text), startConditions: Type.Array(text), editScope: Type.Array(text)}, {additionalProperties: false}), {maxItems: 50}),
        edges: Type.Array(Type.Object({from: issue, to: issue, reason: text}, {additionalProperties: false}), {maxItems: 1225}),
      }, {additionalProperties: false}),
      projectId: Type.Optional(Type.String({pattern: '^PVT_[A-Za-z0-9_-]{1,200}$'})),
    }, {additionalProperties: false}),
    executionMode: 'sequential', readOnly: false,
    decode: decodeDependenciesApplyInput,
    run: applyDependencies,
  });
}
