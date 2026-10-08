// Native-test-only extension: registers the foundation probe plus synthetic readiness/hook helpers.
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {createRuntime} from '../../dist/src/core/runtime.js';
import {createTool} from './probe-tool.ts';

export default function (pi: ExtensionAPI) {
  const runtime = createRuntime();
  pi.registerTool(createTool(runtime) as never);
  const invalidate = () => runtime.scope.invalidate();
  pi.on('session_start', (_event, ctx) => { invalidate(); if (ctx.mode === 'tui') ctx.ui.notify('OWNED_SESSION_READY', 'info'); });
  pi.on('session_before_switch', invalidate);
  pi.on('session_before_fork', invalidate);
  pi.on('session_before_tree', invalidate);
  pi.on('session_shutdown', invalidate);
  pi.on('tool_call', event => {
    if (event.toolName === 'gh_issue_edit' && process.env.OWNED_BLOCK_NESTED === '1') return {block: true, reason: 'OWNED_HOOK_BLOCKED'};
    return undefined;
  });
  pi.registerCommand('owned-ready', {description: 'Synthetic readiness probe', handler: async (_args, ctx) => { ctx.ui.notify('OWNED_READY', 'info'); }});
}
