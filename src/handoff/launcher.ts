// The only command a handoff ever runs in the new pane: a fixed pi-profile launch with quoted values.
/** Launch values must be plain tokens, so no shell (bash/zsh/fish/sh) can interpret them. */
export const SAFE_LAUNCH_VALUE = /^[A-Za-z0-9._\/:@+-]+$/;
export function unsafeLaunchValues(o: {packetPath: string; model?: string; thinking?: string}): string[] {
  return Object.entries(o).filter(([, v]) => v !== undefined && !SAFE_LAUNCH_VALUE.test(v)).map(([k]) => k);
}
export const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
export function buildLaunchCommand(o: {packetPath: string; model?: string; thinking?: string}): string {
  return ['pi-profile launch --profile developer -- --scaffold-handoff', quote(o.packetPath),
    ...(o.model ? ['--model', quote(o.model)] : []), ...(o.model && o.thinking ? ['--thinking', quote(o.thinking)] : [])].join(' ');
}
