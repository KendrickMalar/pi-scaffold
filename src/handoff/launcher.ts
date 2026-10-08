// The only command a handoff ever runs in the new pane: a fixed pi-profile launch with quoted values.
export const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
export function buildLaunchCommand(o: {packetPath: string; model?: string; thinking?: string}): string {
  return ['pi-profile launch --profile developer -- --scaffold-handoff', quote(o.packetPath),
    ...(o.model ? ['--model', quote(o.model)] : []), ...(o.model && o.thinking ? ['--thinking', quote(o.thinking)] : [])].join(' ');
}
