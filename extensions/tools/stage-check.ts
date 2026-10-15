import {Type} from '@earendil-works/pi-ai';
import {defineScaffoldTool} from '../tool-kit.ts';
import {decodeStageCheckInput, stageCheck, STAGE_CHECK, type StageCheckInput} from '../../dist/src/services/stage-check.js';
import type {ScaffoldRuntime} from '../../dist/src/core/runtime.js';

export function createTool(runtime: ScaffoldRuntime) {
  return defineScaffoldTool<StageCheckInput>(runtime, {
    name: STAGE_CHECK,
    label: 'Scaffold: 工程を続けられるかの確認',
    description: 'Read-only. Call after reload, a plan-mode switch or resuming an interrupted stage session, before continuing work. Passes when the '
      + 'read tools (gh_capabilities, gh_issue_get, scaffold_waves_verify, scaffold_stage_check) are active and every doc the Epic pins as '
      + '<docs/...>@sha256:<hex> in its sourceRefs has the same bytes in this cwd. Also lists the stage write tools that are inactive (expected in '
      + 'plan mode; not a failure). Never fixes anything.',
    parameters: Type.Object({
      repo: Type.String({pattern: '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$'}),
      epicIssue: Type.Integer({minimum: 1}),
    }, {additionalProperties: false}),
    executionMode: 'parallel', readOnly: true,
    decode: decodeStageCheckInput,
    run: stageCheck,
  });
}
