// The only command a handoff ever runs in the new pane: a fixed pi-profile launch with quoted values.
import {isScaffoldProfile} from './profiles.js';
import {isBrowserAccount} from '../core/browser-account.js';
/** Launch values must be plain tokens, so no shell (bash/zsh/fish/sh) can interpret them. */
export const SAFE_LAUNCH_VALUE = /^[A-Za-z0-9._\/:@+-]+$/;
/** `profileId` is the sender's Profile; the new stage session starts in the same one (default developer). */
/** `browserAccount` is the sender's PI_BROWSER_ACCOUNT, so the stage session's `playwright-browser` MCP drives the same Chrome profile. */
export interface LaunchValues {packetPath: string; profileId?: string; agentDir?: string; scaffoldDir?: string; browserAccount?: string; model?: string; thinking?: string}
export function unsafeLaunchValues(o: LaunchValues): string[] {
  return Object.entries(o).filter(([k, v]) => v !== undefined && (!SAFE_LAUNCH_VALUE.test(v) || (k === 'profileId' && !isScaffoldProfile(v)) || (k === 'browserAccount' && !isBrowserAccount(v)))).map(([k]) => k);
}
export const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
export function buildLaunchCommand(o: LaunchValues): string {
  if (unsafeLaunchValues(o).length) throw new Error('Unsafe handoff launch values.');
  // The Profile id comes from the fixed allowlist, so it is written unquoted (the developer command stays as before).
  return [...(o.agentDir !== undefined || o.scaffoldDir !== undefined || o.browserAccount !== undefined ? ['env',
    ...(o.agentDir !== undefined ? [`PI_CODING_AGENT_DIR=${quote(o.agentDir)}`] : []),
    ...(o.scaffoldDir !== undefined ? [`PI_SCAFFOLD_DIR=${quote(o.scaffoldDir)}`] : []),
    ...(o.browserAccount !== undefined ? [`PI_BROWSER_ACCOUNT=${o.browserAccount}`] : [])] : []), `pi-profile launch --profile ${o.profileId ?? 'developer'} -- --scaffold-handoff`, quote(o.packetPath),
    ...(o.model ? ['--model', quote(o.model)] : []), ...(o.model && o.thinking ? ['--thinking', quote(o.thinking)] : [])].join(' ');
}
