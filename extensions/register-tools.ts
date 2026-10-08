// Registry of accepted tool modules. Edited only by the integration owner; unimplemented tools are never listed.
import type {ExtensionAPI, ToolDefinition} from '@earendil-works/pi-coding-agent';
import type {ScaffoldRuntime} from '../dist/src/core/runtime.js';
import {createTool as labelsEnsure} from './tools/labels-ensure.ts';

export type CreateTool = (runtime: ScaffoldRuntime) => ToolDefinition;

/** Accepted tools only (#3〜#16 are added after acceptance). */
export const TOOL_FACTORIES: readonly CreateTool[] = [labelsEnsure];

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
