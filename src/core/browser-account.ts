// Which Chrome profile the `playwright-browser` MCP (~/.local/bin/pi-browser-mcp) drives. pi-account exports
// PI_BROWSER_ACCOUNT; sessions scaffold starts itself must carry the same value or the MCP refuses to start.
import {basename, dirname} from 'node:path';

export type BrowserAccount = 'kuno' | 'muu' | 'rbx';
export const isBrowserAccount = (v: unknown): v is BrowserAccount => v === 'kuno' || v === 'muu' || v === 'rbx';

/** The account of a Pi agent directory, as pi-account lays them out: ~/.pi/agent (kuno), ~/.pi/agent-muu, ~/.pi/agent-rbx. */
export function accountOfAgentDir(agentDir: string | undefined): BrowserAccount | undefined {
  if (!agentDir || basename(dirname(agentDir)) !== '.pi') return undefined;
  const name = basename(agentDir);
  if (name === 'agent') return 'kuno';
  const account = name.startsWith('agent-') ? name.slice('agent-'.length) : undefined;
  return isBrowserAccount(account) ? account : undefined;
}

/** The session's own PI_BROWSER_ACCOUNT, else the account of its agent directory, else kuno (the plain `pi` account). */
export function resolveBrowserAccount(env: Record<string, string | undefined>, agentDir?: string): BrowserAccount {
  const value = env.PI_BROWSER_ACCOUNT;
  return isBrowserAccount(value) ? value : accountOfAgentDir(agentDir) ?? 'kuno';
}
