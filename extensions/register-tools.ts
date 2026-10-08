// Registry of accepted tool modules. Edited only by the integration owner; unimplemented tools are never listed.
import type {ExtensionAPI, ToolDefinition} from '@earendil-works/pi-coding-agent';
import type {ScaffoldRuntime} from '../dist/src/core/runtime.js';

export type CreateTool = (runtime: ScaffoldRuntime) => ToolDefinition;

/** #3〜#16 add their createTool here after acceptance. #2 provides the foundation only. */
export const TOOL_FACTORIES: readonly CreateTool[] = [];

export function registerTools(pi: ExtensionAPI, runtime: ScaffoldRuntime): string[] {
  const names: string[] = [];
  for (const create of TOOL_FACTORIES) {
    const tool = create(runtime);
    if (names.includes(tool.name)) throw new Error(`Duplicate pi-scaffold tool ${tool.name}.`);
    pi.registerTool(tool);
    names.push(tool.name);
  }
  return names;
}
