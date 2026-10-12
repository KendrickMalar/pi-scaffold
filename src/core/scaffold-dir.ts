// Storage selection is independent of Pi authentication and session history.
import {isAbsolute, join} from 'node:path';

/** Explicit paths are literal absolute paths, never expanded or realpathed. */
export function resolveScaffoldDir(env: Record<string, string | undefined>, agentDir: string): string {
  const value = env.PI_SCAFFOLD_DIR;
  if (value === undefined) return join(agentDir, 'pi-scaffold');
  if (!isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error('PI_SCAFFOLD_DIR must be a nonempty absolute path without control characters.');
  return value;
}
