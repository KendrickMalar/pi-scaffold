// Local, read-only git access with fixed argv (no shell). fetch/merge/push are never run.
import {execFile} from 'node:child_process';
import {LIMITS} from '../core/contracts.js';

const ALLOWED = new Set(['rev-parse', 'cat-file', 'merge-base', 'ls-remote', 'ls-tree']);
export interface RepoIdentity { repoRoot: string; gitCommonDir: string; origin: string }
export interface GitReader {
  run(args: readonly string[], cwd: string): Promise<{code: number; stdout: string}>;
  repoIdentity(cwd: string): Promise<RepoIdentity>;
  /** Repo-relative paths of the files under `path` at `ref` (read-only `git ls-tree -r --name-only`); undefined if unreadable. */
  listTree(ref: string, path: string, cwd: string): Promise<string[] | undefined>;
  /** Exact bytes of `<commit>:<path>`, or undefined when it does not exist (read-only `git cat-file blob`). Rejects with TOO_LARGE above the artifact limit. */
  readBlob(commit: string, path: string, cwd: string): Promise<Buffer | undefined>;
}

export function createGitReader(options: {timeoutMs?: number; gitBin?: string} = {}): GitReader {
  const run: GitReader['run'] = (args, cwd) => {
    const allowed = ALLOWED.has(args[0] ?? '') || (args[0] === 'remote' && args[1] === 'get-url' && args.length === 3);
    if (!allowed) return Promise.reject(new Error(`git ${args[0] ?? ''} is not allowed.`));
    const env = {PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', LANG: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0'};
    return new Promise(resolve => {
      execFile(options.gitBin ?? 'git', [...args], {cwd, env, timeout: options.timeoutMs ?? LIMITS.callTimeoutMs, maxBuffer: 1024 * 1024, shell: false}, (error, stdout) => {
        const code = error ? (typeof (error as {code?: unknown}).code === 'number' ? (error as {code: number}).code : 1) : 0;
        resolve({code, stdout: String(stdout)});
      });
    });
  };
  const readBlob: GitReader['readBlob'] = (commit, path, cwd) => {
    const env = {PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', LANG: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0'};
    return new Promise((resolve, reject) => {
      execFile(options.gitBin ?? 'git', ['cat-file', 'blob', `${commit}:${path}`], {cwd, env, encoding: 'buffer', timeout: options.timeoutMs ?? LIMITS.callTimeoutMs, maxBuffer: LIMITS.artifactBytes, shell: false},
        (error, stdout) => {
          if ((error as {code?: unknown} | null)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(new Error(`TOO_LARGE: ${path} exceeds ${LIMITS.artifactBytes} bytes.`));
          resolve(error ? undefined : Buffer.from(stdout));
        });
    });
  };
  const listTree: GitReader['listTree'] = async (ref, path, cwd) => {
    const r = await run(['ls-tree', '-r', '--name-only', '-z', ref, '--', path], cwd);
    return r.code ? undefined : r.stdout.split('\0').filter(Boolean);
  };
  return {
    run, readBlob, listTree,
    async repoIdentity(cwd) {
      const top = await run(['rev-parse', '--show-toplevel'], cwd);
      const common = await run(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
      if (top.code || common.code) throw new Error('Not inside a git worktree.');
      const origin = await run(['remote', 'get-url', 'origin'], cwd);
      return {repoRoot: top.stdout.trim(), gitCommonDir: common.stdout.trim(), origin: origin.code ? '' : origin.stdout.trim()};
    },
  };
}

/** OWNER/REPO for github.com remotes in https, scp-like or ssh form; undefined for anything else. */
export function parseGithubRemote(url: string): string | undefined {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m?.[1];
}
