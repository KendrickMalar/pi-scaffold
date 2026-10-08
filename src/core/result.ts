import {isErrorStatus, type ScaffoldResult} from './contracts.js';

export interface ToolResultShape { content: {type: 'text'; text: string}[]; structuredContent: unknown; details: unknown; isError: boolean }
const TEXT_LIMIT = 32 * 1024;

/** Converts a service result into a Pi tool result. blocked/partial/unknown/cancelled are always errors. */
export function toToolResult<T>(result: ScaffoldResult<T>): ToolResultShape {
  const full = JSON.stringify(result);
  const text = full.length <= TEXT_LIMIT ? full : full.slice(0, TEXT_LIMIT) + '\n[truncated; complete data in structuredContent]';
  return {content: [{type: 'text', text}], structuredContent: result, details: result, isError: isErrorStatus(result.status)};
}
