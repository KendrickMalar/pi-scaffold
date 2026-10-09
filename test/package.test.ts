// The published package (Epic #1): what npm would ship, checked with a real `npm pack --dry-run`.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {dirname, join, normalize} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

// Runs prepack (a fresh build), so stale files of deleted sources cannot hide in dist/.
test('npm pack ships exactly the runtime: extensions, built core, resources — never tests, state, policy, credentials or Profiles', () => {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {cwd: root, encoding: 'utf8', env: {...process.env, npm_config_loglevel: 'silent'}});
  const files: string[] = JSON.parse(out)[0].files.map((f: {path: string}) => f.path);
  const has = (p: string) => files.includes(p);
  for (const required of ['package.json', 'README.md', 'LICENSE', 'extensions/index.ts', 'extensions/register-tools.ts', 'extensions/tool-kit.ts',
    'resources/labels-v1.json', 'resources/skills/scaffold-stage/SKILL.md', 'resources/templates/scaffold-epic-v1.yml', 'resources/templates/scaffold-feature-v1.yml', 'resources/templates/scaffold-task-v1.yml',
    'dist/src/core/runtime.js', 'dist/src/handoff/driver.js']) assert.ok(has(required), `missing ${required}`);
  // Every tool module and every dist file the extensions import is in the package.
  for (const f of readdirSync(join(root, 'extensions/tools'))) assert.ok(has(`extensions/tools/${f}`), `missing extensions/tools/${f}`);
  for (const f of files.filter(f => f.startsWith('extensions/'))) {
    for (const m of readFileSync(join(root, f), 'utf8').matchAll(/from '(\.[^']+)'/g)) {
      const target = normalize(join(dirname(f), m[1]!));
      assert.ok(has(target), `${f} imports ${target}, which is not packed`);
    }
  }
  const forbidden = [/^test\//, /^dist\/test\//, /^scripts\//, /^\.superpowers\//, /^node_modules\//, /(^|\/)(journal|state|approvals|evidence)\//, /policy\.json$/, /auth\.json$/,
    /pi-gh-permissions\.json$/, /(^|\/)profiles?\//, /\.(pem|key|env)$/, /probe-(tool|extension)\.ts$/, /tsconfig/];
  for (const f of files) for (const re of forbidden) assert.ok(!re.test(f), `${f} must not be published (${re})`);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@papillon6814/pi-scaffold'); assert.equal(pkg.license, 'MIT');
  assert.deepEqual(pkg.pi.extensions, ['extensions/index.ts']);
  assert.equal(pkg.scripts.prepack, 'npm run build', 'a pack always contains a fresh build');
  assert.ok(existsSync(join(root, 'LICENSE')));
});
