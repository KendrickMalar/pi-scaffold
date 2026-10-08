// Factory: registration only. No process/watch/timer starts here; tools own their work per call, and the
// handoff receiver starts its short retry timer only after session_start and clears it on shutdown.
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {createRuntime} from '../dist/src/core/runtime.js';
import {loadOwnerPolicy} from '../dist/src/core/model-bindings.js';
import {acceptStartupPacket, recordTurnStarted} from '../dist/src/handoff/receiver.js';
import {registerTools} from './register-tools.ts';

export default function (pi: ExtensionAPI) {
  const runtime = createRuntime();
  registerTools(pi, runtime);
  pi.registerFlag('scaffold-handoff', {type: 'string', description: 'Internal: owned handoff packet path written by a pi-scaffold stage handoff.'});

  let accepted: {packetPath: string; sessionId: string} | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const stopRetry = () => { if (retry) clearTimeout(retry); retry = undefined; };
  const invalidate = () => runtime.scope.invalidate();

  pi.on('session_start', (_event, ctx) => {
    invalidate();
    stopRetry();
    const packetPath = pi.getFlag('scaffold-handoff');
    if (typeof packetPath !== 'string' || !packetPath || accepted) return;
    const sessionId = ctx.sessionManager.getSessionId();
    let attempts = 0;
    const attempt = async () => {
      retry = undefined;
      const policy = await loadOwnerPolicy(runtime.agentDir);
      const r = await acceptStartupPacket({
        packetPath, agentDir: runtime.agentDir, cwd: ctx.cwd, sessionId, sessionEntries: ctx.sessionManager.getEntries(),
        toolNames: pi.getAllTools().map(t => t.name), policy: policy.ok ? policy.value : undefined,
      });
      if (r.ok) { accepted = {packetPath, sessionId}; ctx.ui.notify('pi-scaffold: 工程の引き継ぎを受け付けました。', 'info'); return; }
      // pi-profile may record its Profile snapshot after this handler; retry briefly for that case only.
      if (++attempts < 10 && r.problems.every(p => p.code === 'RECEIVER_PROFILE_MISMATCH')) { retry = setTimeout(() => void attempt(), 200); return; }
      ctx.ui.notify('pi-scaffold: 引き継ぎを受け付けませんでした: ' + r.problems.map(p => p.code).join(', '), 'error');
    };
    void attempt();
  });
  pi.on('before_agent_start', async (event, ctx) => {
    if (accepted && ctx.sessionManager.getSessionId() === accepted.sessionId) {
      await recordTurnStarted({packetPath: accepted.packetPath, agentDir: runtime.agentDir, sessionId: accepted.sessionId, prompt: event.prompt});
    }
    return undefined;
  });
  pi.on('session_before_switch', invalidate);
  pi.on('session_before_fork', invalidate);
  pi.on('session_before_tree', invalidate);
  pi.on('session_shutdown', () => { stopRetry(); invalidate(); });
}
