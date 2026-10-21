// The pi-profile Profiles a stage session may start from. A handoff relaunches the sender's own Profile, so a stage
// never changes Profile; ids outside this list are refused (PROFILE_NOT_DEVELOPMENT, kept for compatibility).
export const SCAFFOLD_PROFILE_IDS: readonly string[] = ['developer', 'roblox-game'];
export const isScaffoldProfile = (id: string | null | undefined): id is string => typeof id === 'string' && SCAFFOLD_PROFILE_IDS.includes(id);
