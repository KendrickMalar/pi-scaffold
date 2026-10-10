// Factory: registration only. No process/watch/timer starts here; tools own their work per call, and the
// handoff receiver starts its short retry timer only after session_start and clears it on shutdown.
// Exception (Issue #36): after session_start, the stage watcher runs a 60 s timer only while this session owns
// handed-off panes in the watch registry; it stops on shutdown and when nothing is left to watch.
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {createRuntime} from '../dist/src/core/runtime.js';
import {loadOwnerPolicy} from '../dist/src/core/model-bindings.js';
import {acceptStartupPacket, recordTurnStarted} from '../dist/src/handoff/receiver.js';
import {join} from 'node:path';
import {createHerdrCli} from '../dist/src/handoff/herdr-client.js';
import {WatchRegistry} from '../dist/src/watch/registry.js';
import {StageWatcher} from '../dist/src/watch/watcher.js';
import {tailReader} from '../dist/src/watch/session-tail.js';
import {registerTools} from './register-tools.ts';

export default function (pi: ExtensionAPI) {
  const runtime = createRuntime();
  registerTools(pi, runtime);
  pi.registerFlag('scaffold-handoff', {type: 'string', description: 'Internal: owned handoff packet path written by a pi-scaffold stage handoff.'});

  let accepted: {packetPath: string; sessionId: string} | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const stopRetry = () => { if (retry) clearTimeout(retry); retry = undefined; };
  const invalidate = () => runtime.scope.invalidate();
  let watcher: StageWatcher | undefined;
  runtime.watch = {add: async entry => { await watcher?.add(entry); }};
  const startWatcher = (ctx: {sessionManager: {getSessionId(): string}; ui: {notify(text: string, level?: 'info' | 'warning' | 'error'): void}}) => {
    watcher?.stop();
    watcher = undefined;
    if (process.env.PI_SUBAGENT_CHILD || process.env.HERDR_ENV !== '1') return;
    watcher = new StageWatcher({
      ownerSessionId: ctx.sessionManager.getSessionId(),
      registry: new WatchRegistry(runtime.agentDir),
      herdr: createHerdrCli({...(process.env.HERDR_BIN_PATH ? {bin: process.env.HERDR_BIN_PATH} : {}), ...(process.env.HERDR_SOCKET_PATH ? {socketPath: process.env.HERDR_SOCKET_PATH} : {})}),
      readTail: tailReader(join(runtime.agentDir, 'sessions')),
      notify: (text, level) => ctx.ui.notify(text, level),
      now: Date.now,
    });
    void watcher.resume().catch(() => undefined);
  };

  pi.on('session_start', (_event, ctx) => {
    invalidate();
    stopRetry();
    startWatcher(ctx);
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
  pi.on('session_shutdown', () => { stopRetry(); watcher?.stop(); invalidate(); });
}
