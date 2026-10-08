import type {CallScope} from '../../src/core/contracts.js';

export interface TestScope extends CallScope { expire(): void; abort(): void }
export function makeScope(sessionId = 'session-test'): TestScope {
  const controller = new AbortController();
  let current = true;
  return {
    sessionId, leafId: 'leaf-test', generation: 0, signal: controller.signal,
    isCurrent: () => current && !controller.signal.aborted,
    expire() { current = false; },
    abort() { controller.abort(); },
  };
}
