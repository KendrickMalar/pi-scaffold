// Registry of accepted tool modules. Edited only by the integration owner; unimplemented tools are never listed.
import type {ExtensionAPI, ToolDefinition} from '@earendil-works/pi-coding-agent';
import type {ScaffoldRuntime} from '../dist/src/core/runtime.js';
import {createTool as labelsEnsure} from './tools/labels-ensure.ts';
import {createTool as epicDraft} from './tools/epic-draft.ts';
import {createTool as handoffSpecification} from './tools/handoff-specification.ts';
import {createTool as specificationUpdate} from './tools/specification-update.ts';
import {createTool as researchBegin} from './tools/research-begin.ts';
import {createTool as researchResolve} from './tools/research-resolve.ts';

export type CreateTool = (runtime: ScaffoldRuntime) => ToolDefinition;

/** Accepted tools only (#3〜#16 are added after acceptance). */
export const TOOL_FACTORIES: readonly CreateTool[] = [labelsEnsure, epicDraft, handoffSpecification, specificationUpdate, researchBegin, researchResolve];

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
