import test from 'node:test';
import assert from 'node:assert/strict';
import {buildLaunchCommand, unsafeLaunchValues} from '../src/handoff/launcher.js';
import {SCAFFOLD_PROFILE_IDS, isScaffoldProfile} from '../src/handoff/profiles.js';

test('launch: the stage starts in the sender Profile; without one it stays developer', () => {
  assert.equal(buildLaunchCommand({packetPath: '/p/packet.json'}), `pi-profile launch --profile developer -- --scaffold-handoff '/p/packet.json'`);
  assert.equal(buildLaunchCommand({packetPath: '/p/packet.json', profileId: 'roblox-game'}), `pi-profile launch --profile roblox-game -- --scaffold-handoff '/p/packet.json'`);
});

test('launch: a Profile outside the scaffold allowlist is refused even when it is a plain token', () => {
  assert.deepEqual(unsafeLaunchValues({packetPath: '/p', profileId: 'reviewer'}), ['profileId']);
  assert.deepEqual(unsafeLaunchValues({packetPath: '/p', profileId: "x' ; rm"}), ['profileId']);
  assert.throws(() => buildLaunchCommand({packetPath: '/p', profileId: 'reviewer'}));
});

test('profiles: the allowlist is developer and roblox-game only', () => {
  assert.deepEqual([...SCAFFOLD_PROFILE_IDS], ['developer', 'roblox-game']);
  assert.equal(isScaffoldProfile(null), false);
  assert.equal(isScaffoldProfile('research'), false);
});

test('launch: the stage session carries the sender browser account; anything else is refused', () => {
  assert.equal(buildLaunchCommand({packetPath: '/p/packet.json', profileId: 'roblox-game', browserAccount: 'rbx'}), `env PI_BROWSER_ACCOUNT=rbx pi-profile launch --profile roblox-game -- --scaffold-handoff '/p/packet.json'`);
  assert.equal(buildLaunchCommand({packetPath: '/p', agentDir: '/h/.pi/agent-rbx', browserAccount: 'rbx'}), `env PI_CODING_AGENT_DIR='/h/.pi/agent-rbx' PI_BROWSER_ACCOUNT=rbx pi-profile launch --profile developer -- --scaffold-handoff '/p'`);
  assert.deepEqual(unsafeLaunchValues({packetPath: '/p', browserAccount: 'other'}), ['browserAccount']);
  assert.throws(() => buildLaunchCommand({packetPath: '/p', browserAccount: 'other'}));
});
