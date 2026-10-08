// #5 scaffold_handoff_specification: setup → specification only. Checks the draft (not completeness) and uses
// the shared handoff transport. Completeness of the specification is #9's gate.
import {decodeMutationInput, problem, type Decoded, type GateResult, type IssueSnapshot, type Problem, type ScaffoldResult} from '../core/contracts.js';
import {handoffStage, type HandoffData, type HandoffInput} from '../handoff/driver.js';
import type {ToolCall} from '../core/runtime.js';

export const HANDOFF_SPECIFICATION = 'scaffold_handoff_specification';

export function decodeHandoffSpecificationInput(value: unknown): Decoded<HandoffInput> {
  const d = decodeMutationInput<{expectedStage: string; nextStage: string}>(value, {
    expectedStage: {decode: (r, v, p) => r.literal(v, p, ['setup'] as const)},
    nextStage: {decode: (r, v, p) => r.literal(v, p, ['specification'] as const)},
  });
  return d as Decoded<HandoffInput>;
}

/** Draft-level readiness: real GitHub title present; the managed doc already passed strict decoding on read. */
export async function checkSetupReady(snapshot: IssueSnapshot): Promise<GateResult> {
  const problems: Problem[] = [];
  if (!snapshot.title.trim()) problems.push(problem('BLANK', 'title', 'The Epic needs a GitHub title before the specification session starts.'));
  if (snapshot.doc.kind !== 'epic') problems.push(problem('NOT_AN_EPIC', 'doc.kind', 'Expected an Epic.'));
  return {status: problems.length ? 'blocked' : 'validated', problems, artifactDigests: {epicBody: snapshot.bodySha256}};
}

export function handoffSpecification(input: HandoffInput, call: ToolCall): Promise<ScaffoldResult<HandoffData>> {
  return handoffStage(input, checkSetupReady, call, HANDOFF_SPECIFICATION);
}
