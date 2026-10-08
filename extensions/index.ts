// Factory: registration only. No process/watch/timer starts here; tools own their work per call.
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {createRuntime} from '../dist/src/core/runtime.js';
import {registerTools} from './register-tools.ts';

export default function (pi: ExtensionAPI) {
  const runtime = createRuntime();
  registerTools(pi, runtime);
  const invalidate = () => runtime.scope.invalidate();
  pi.on('session_start', invalidate);
  pi.on('session_before_switch', invalidate);
  pi.on('session_before_fork', invalidate);
  pi.on('session_before_tree', invalidate);
  pi.on('session_shutdown', invalidate);
}
