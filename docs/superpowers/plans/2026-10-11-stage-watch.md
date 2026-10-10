# 下位工程セッションの監視（stage watch）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 親 Pi セッションが、自分の引き継いだ下位工程セッションの Herdr pane を 60 秒ごとに見て、止まっていれば親 TUI に通知し、一時的な API エラーのときだけ自動で「続けて」を送る。

**Architecture:** 副作用のない判定関数 `decide()` に、ロジックのほぼすべてを集める。その周りに次の部品を置く。

- ログ末尾の読み取り（`session-tail.ts`）
- 監視台帳（`registry.ts`）
- タイマーと実行（`watcher.ts`）
- Herdr の `paneGet`

`handoffStage` は `applied` の直後に `runtime.watch.add()` を呼ぶ。拡張は `session_start` で監視を作り直し、再開する。

**Tech Stack:** TypeScript（NodeNext, strict）、`node:test`、`node:assert/strict`、Herdr 0.9.1 CLI、Pi 拡張 API（`@earendil-works/pi-coding-agent`）

**Spec:** `docs/superpowers/specs/2026-10-11-stage-watch-design.md`（Issue #36）

## Global Constraints

- 対応する Herdr は 0.9.1 / protocol 22 のみ（`SUPPORTED_HERDR`）。違えば監視しない。
- 下位の Pi セッション側は改修しない。
- 周期は 60 秒（`CHECK_INTERVAL_MS = 60_000`）。
- 自動「続けて」は最大 3 回。待ち時間は 1 分 → 5 分 → 15 分（`RETRY_DELAYS_MS = [60_000, 300_000, 900_000]`）。
- 「続けて」の固定文面: `pi-scaffold: 一時的なエラーで止まったため再開します。直前の作業を続けてください。`
- 通知先は `ctx.ui.notify(text, 'info' | 'warning' | 'error')` のみ。親の会話には差し込まない。
- 読むセッションログは version 3 のみ。末尾の最大 256 KiB だけを読む。
- エラー文の表示は先頭 120 文字まで。
- 監視台帳: `<agentDir>/pi-scaffold/state/watches.json`（`writeOwnedFile` で 0600）。
- 監視は `ownerSessionId` が自分のセッションのものだけ。`PI_SUBAGENT_CHILD` のセッションと Herdr 外（`HERDR_ENV !== '1'`）のセッションは監視しない。
- 既存テスト（現在 673 件）がすべて通ること。テストは `npm test`、型検査は `npm run typecheck`。
- コミットに AI 帰属トレーラー（`Co-Authored-By` など）を付けない。

## Review Focus

1. **人が下位を手で動かしている最中に「続けて」が割り込む** → 送る直前に「`idle` かつ同じエラー記録（`timestamp` が同じ）」を再確認する。違えば送らず、progress も戻す。Task 5 のテスト「precheck mismatch」で固定する。
2. **エラーを何度も繰り返す下位を無限に再開する** → `working` では回数を戻さない。0 に戻すのは正常終了（`stopped`）のときだけ。Task 3 のテスト「repeated errors exhaust」で固定する。
3. **台帳は親・下位で共有されるため、下位が親の監視を実行して二重送信する** → `ownerSessionId` で絞る。Task 5 のテスト「other owner」で固定する。
4. **ログが 256 KiB を超え、最後の assistant が末尾窓の中にしかない／先頭行が切れる** → 先頭行はファイル頭から別に読み、窓の最初の行は捨てる。Task 1 のテスト「large log」で固定する。
5. **Herdr の一時的な失敗で監視が止まる、または通知が連発する** → `version()` が失敗した回は飛ばすだけでタイマーは止めない。`paneGet` の失敗は 3 回続いたときに 1 回だけ通知する。Task 3 と Task 5 のテストで固定する。

---

## ファイル構成

| ファイル | 種別 | 役割 |
|---|---|---|
| `src/watch/session-tail.ts` | 新規 | ログの特定・末尾読み取り・エラー分類 |
| `src/watch/decide.ts` | 新規 | 型・定数・副作用のない判定 |
| `src/watch/registry.ts` | 新規 | 監視台帳の読み書き |
| `src/watch/watcher.ts` | 新規 | タイマー・観測・実行 |
| `src/handoff/herdr-client.ts` | 変更 | `paneGet` 追加、`run` にエラー JSON を受け取るオプション |
| `src/core/runtime.ts` | 変更 | `ScaffoldRuntime.watch?` 追加 |
| `src/handoff/driver.ts` | 変更 | `applied` の直後に `runtime.watch.add` |
| `extensions/index.ts` | 変更 | `session_start` で監視を作り直して再開、`session_shutdown` で停止 |
| `test/helpers/fake-herdr.ts` | 変更 | `paneGet` 追加 |
| `test/session-tail.test.ts`・`test/decide.test.ts`・`test/watch-registry.test.ts`・`test/watcher.test.ts` | 新規 | 単体テスト |
| `test/herdr-client.test.ts`・`test/handoff-specification.test.ts` | 変更 | `paneGet`・登録のテスト |
| `README.md`・`package.json` | 変更 | 説明追記、0.4.0 |

すべての作業は worktree `~/Documents/Github/pi-scaffold.worktrees/stage-watch`（ブランチ `feat/stage-watch`）で行う。

---

### Task 1: セッションログ末尾の読み取り（`session-tail.ts`）

**Files:**
- Create: `src/watch/session-tail.ts`
- Test: `test/session-tail.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `type TailResult = {kind: 'error'; transient: boolean; message: string; at: number} | {kind: 'stopped'; reason: string; at: number} | {kind: 'unknown'; reason: string}`
  - `isTransientError(message: string): boolean`
  - `sessionDirName(cwd: string): string`
  - `findSessionLog(sessionsRoot: string, cwd: string, sessionId: string): Promise<string | undefined>`
  - `readSessionTail(path: string): Promise<TailResult>`
  - `tailReader(sessionsRoot: string): (entry: {cwd: string; targetSessionId: string}) => Promise<TailResult>`
  - 定数 `SESSION_LOG_VERSION = 3`、`TAIL_BYTES = 262144`

- [ ] **Step 1: 失敗するテストを書く**

`test/session-tail.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {findSessionLog, isTransientError, readSessionTail, sessionDirName, tailReader, TAIL_BYTES} from '../src/watch/session-tail.js';

const SID = '01a114af-7ef9-71a5-aee6-c19bd9b05a65';
const header = (version = 3) => JSON.stringify({type: 'session', version, id: SID, timestamp: '2026-10-07T04:46:48.057Z', cwd: '/synthetic/repo'});
const assistant = (stopReason: string, at: number, errorMessage?: string) => JSON.stringify({
  type: 'message', id: `m${at}`, parentId: null, timestamp: '2026-10-07T04:47:38.840Z',
  message: {role: 'assistant', content: [], api: 'anthropic-messages', provider: 'anthropic', model: 'example-1', stopReason, timestamp: at, ...(errorMessage !== undefined ? {errorMessage} : {})},
});
const user = (text: string) => JSON.stringify({type: 'message', id: 'u', parentId: null, timestamp: 't', message: {role: 'user', content: [{type: 'text', text}]}});

async function tmp(t: {after(fn: () => Promise<void>): void}) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-scaffold-tail-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}
async function log(dir: string, lines: string[]) { const p = join(dir, `2026-10-07T04-46-48-057Z_${SID}.jsonl`); await writeFile(p, lines.join('\n') + '\n'); return p; }

test('a transient error stop is reported with its message and timestamp', async t => {
  const p = await log(await tmp(t), [header(), user('hi'), assistant('toolUse', 1), assistant('error', 1791348458154, 'fetch failed')]);
  assert.deepEqual(await readSessionTail(p), {kind: 'error', transient: true, message: 'fetch failed', at: 1791348458154});
});

test('a 400 invalid_request error is not transient', async t => {
  const msg = '400 {"type":"error","error":{"type":"invalid_request_error","message":"bad"}}';
  const p = await log(await tmp(t), [header(), assistant('error', 7, msg)]);
  assert.deepEqual(await readSessionTail(p), {kind: 'error', transient: false, message: msg, at: 7});
});

test('a normal end and an aborted turn are stopped, with their reason', async t => {
  const dir = await tmp(t);
  assert.deepEqual(await readSessionTail(await log(dir, [header(), assistant('error', 1, 'fetch failed'), assistant('stop', 2)])), {kind: 'stopped', reason: 'stop', at: 2});
  assert.deepEqual(await readSessionTail(await log(dir, [header(), assistant('aborted', 3)])), {kind: 'stopped', reason: 'aborted', at: 3});
});

test('broken and non-assistant trailing lines are skipped', async t => {
  const p = await log(await tmp(t), [header(), assistant('error', 5, 'Connection error.'), user('later'), '{"type":"message","mess']);
  assert.deepEqual(await readSessionTail(p), {kind: 'error', transient: true, message: 'Connection error.', at: 5});
});

test('another log version, a broken header, no assistant, or a missing file is unknown', async t => {
  const dir = await tmp(t);
  assert.deepEqual(await readSessionTail(await log(dir, [header(2), assistant('stop', 1)])), {kind: 'unknown', reason: 'log-version'});
  assert.deepEqual(await readSessionTail(await log(dir, ['not json', assistant('stop', 1)])), {kind: 'unknown', reason: 'log-header'});
  assert.deepEqual(await readSessionTail(await log(dir, [header(), user('only')])), {kind: 'unknown', reason: 'no-assistant-message'});
  assert.deepEqual(await readSessionTail(join(dir, 'missing.jsonl')), {kind: 'unknown', reason: 'log-missing'});
});

test('large log: only the tail is read, the header is still checked, and a cut first line is ignored', async t => {
  const filler = user('x'.repeat(1000));
  const lines = [header(), ...Array.from({length: Math.ceil((TAIL_BYTES * 2) / filler.length)}, () => filler), assistant('error', 9, '529 overloaded')];
  const p = await log(await tmp(t), lines);
  assert.deepEqual(await readSessionTail(p), {kind: 'error', transient: true, message: '529 overloaded', at: 9});
});

test('transient classification follows the real error texts', () => {
  for (const m of ['fetch failed', 'Connection error.', '429 rate limited', '503 Service Unavailable', '{"type":"error","error":{"type":"overloaded_error"}}',
    'Codex SSE response headers timed out after 300000ms', 'upstream connect error or disconnect/reset before headers', 'exceeded request buffer limit while retrying upstream', 'socket hang up'])
    assert.equal(isTransientError(m), true, m);
  for (const m of ['400 {"type":"error"}', '403 {}', '404 {}', 'Codex error: The usage limit has been reached', '429 You have hit your usage limit',
    'Your authentication token has been invalidated. Please try signing in again.', "400 This endpoint's maximum context length is 64000 tokens.", ''])
    assert.equal(isTransientError(m), false, m);
});

test('the session log is found in the cwd directory first, then anywhere under sessions/', async t => {
  const root = await tmp(t);
  assert.equal(sessionDirName('/Users/me/Documents/Github/demo'), '--Users-me-Documents-Github-demo--');
  const preferred = join(root, sessionDirName('/synthetic/repo'));
  await mkdir(preferred);
  const p1 = await log(preferred, [header(), assistant('stop', 1)]);
  assert.equal(await findSessionLog(root, '/synthetic/repo', SID), p1);
  const other = join(root, '--elsewhere--');
  await mkdir(other);
  const p2 = join(other, `x_${'01b00000-0000-7000-8000-000000000000'}.jsonl`);
  await writeFile(p2, header() + '\n');
  assert.equal(await findSessionLog(root, '/synthetic/repo', '01b00000-0000-7000-8000-000000000000'), p2);
  assert.equal(await findSessionLog(root, '/synthetic/repo', 'nope'), undefined);
  assert.deepEqual(await tailReader(root)({cwd: '/synthetic/repo', targetSessionId: 'nope'}), {kind: 'unknown', reason: 'log-missing'});
  assert.deepEqual(await tailReader(root)({cwd: '/synthetic/repo', targetSessionId: SID}), {kind: 'stopped', reason: 'stop', at: 1});
});
```

- [ ] **Step 2: テストを実行し、失敗することを確かめる**

Run: `npm test 2>&1 | grep -E "session-tail|error TS" | head`
Expected: `Cannot find module '../src/watch/session-tail.js'` の型エラーでビルドが失敗する。

- [ ] **Step 3: 実装する**

`src/watch/session-tail.ts`:

```ts
// Reads only the tail of a Pi session log to tell why an idle stage session stopped. Pi writes these files
// (they are not owner-only), so plain fs is used; anything unexpected is `unknown`, never a guess.
import {open, readdir} from 'node:fs/promises';
import {join} from 'node:path';

export type TailResult =
  | {kind: 'error'; transient: boolean; message: string; at: number}
  | {kind: 'stopped'; reason: string; at: number}
  | {kind: 'unknown'; reason: string};

export const SESSION_LOG_VERSION = 3;
export const TAIL_BYTES = 256 * 1024;
const HEAD_BYTES = 4096;

/** Errors that minutes of waiting will not fix, even when they look like rate limits. */
const NOT_TRANSIENT = /usage limit|authentication|invalidated|maximum context length/i;
const TRANSIENT = [
  /^(429|5\d\d)\b/,
  /\b(rate_limit_error|overloaded_error|api_error)\b/,
  /fetch failed|connection error|ECONNRESET|ETIMEDOUT|socket hang up|timed out|upstream connect error|exceeded request buffer limit/i,
];
export function isTransientError(message: string): boolean {
  const m = message.trim();
  if (!m || NOT_TRANSIENT.test(m)) return false;
  return TRANSIENT.some(r => r.test(m));
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Pi's per-cwd session directory name: "/a/b" → "--a-b--". */
export function sessionDirName(cwd: string): string { return `--${cwd.replace(/^\/+/, '').replace(/\//g, '-')}--`; }

export async function findSessionLog(sessionsRoot: string, cwd: string, sessionId: string): Promise<string | undefined> {
  const suffix = `_${sessionId}.jsonl`;
  const look = async (dir: string) => { try { return (await readdir(dir)).find(n => n.endsWith(suffix)); } catch { return undefined; } };
  const preferred = join(sessionsRoot, sessionDirName(cwd));
  const hit = await look(preferred);
  if (hit) return join(preferred, hit);
  let dirs: string[];
  try { dirs = (await readdir(sessionsRoot, {withFileTypes: true})).filter(d => d.isDirectory()).map(d => d.name); } catch { return undefined; }
  for (const d of dirs) { const h = await look(join(sessionsRoot, d)); if (h) return join(sessionsRoot, d, h); }
  return undefined;
}

export async function readSessionTail(path: string): Promise<TailResult> {
  let handle;
  try { handle = await open(path, 'r'); } catch { return {kind: 'unknown', reason: 'log-missing'}; }
  try {
    const {size} = await handle.stat();
    const head = Buffer.alloc(Math.min(HEAD_BYTES, size));
    await handle.read(head, 0, head.length, 0);
    let header: unknown;
    try { header = JSON.parse(head.toString('utf8').split('\n', 1)[0] ?? ''); } catch { return {kind: 'unknown', reason: 'log-header'}; }
    if (!isRec(header) || header.type !== 'session') return {kind: 'unknown', reason: 'log-header'};
    if (header.version !== SESSION_LOG_VERSION) return {kind: 'unknown', reason: 'log-version'};
    const start = Math.max(0, size - TAIL_BYTES);
    const tail = Buffer.alloc(size - start);
    await handle.read(tail, 0, tail.length, start);
    const lines = tail.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // the window may start inside a line
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry: unknown;
      try { entry = JSON.parse(lines[i]!); } catch { continue; }
      if (!isRec(entry) || entry.type !== 'message' || !isRec(entry.message) || entry.message.role !== 'assistant') continue;
      const m = entry.message;
      const at = typeof m.timestamp === 'number' ? m.timestamp : 0;
      if (m.stopReason === 'error') {
        const message = typeof m.errorMessage === 'string' ? m.errorMessage : '';
        return {kind: 'error', transient: isTransientError(message), message, at};
      }
      return {kind: 'stopped', reason: typeof m.stopReason === 'string' ? m.stopReason : 'unknown', at};
    }
    return {kind: 'unknown', reason: 'no-assistant-message'};
  } catch { return {kind: 'unknown', reason: 'log-read'}; }
  finally { await handle.close(); }
}

export function tailReader(sessionsRoot: string) {
  return async (entry: {cwd: string; targetSessionId: string}): Promise<TailResult> => {
    const path = await findSessionLog(sessionsRoot, entry.cwd, entry.targetSessionId);
    return path ? readSessionTail(path) : {kind: 'unknown', reason: 'log-missing'};
  };
}
```

- [ ] **Step 4: テストを実行し、通ることを確かめる**

Run: `npm test 2>&1 | tail -8`
Expected: `ℹ fail 0`。新しい 8 件を含めて全件合格する。

- [ ] **Step 5: コミット**

```bash
git add src/watch/session-tail.ts test/session-tail.test.ts
git commit -m "feat(watch): 下位セッションログの末尾を読んで停止理由を判定する"
```

---

### Task 2: Herdr の `paneGet`

**Files:**
- Modify: `src/handoff/herdr-client.ts`（`HerdrPort` と `createHerdrCli` の `run`）
- Modify: `test/helpers/fake-herdr.ts`
- Test: `test/herdr-client.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `type PaneState = {exists: false} | {exists: true; agent?: string; status?: string}`
  - `HerdrPort.paneGet(paneId: string): Promise<PaneState>`
  - `FakeHerdr.panes: Map<string, PaneState>`（未登録の pane は `{exists: false}`）

- [ ] **Step 1: 失敗するテストを書く**

`test/herdr-client.test.ts` の末尾に追加する:

```ts
test('pane get: a missing pane, a Pi pane and a plain shell pane are told apart', async t => {
  const {bin} = await fakeBin(t, `const id = process.argv[4];
if (id === 'w1:gone') { console.log(JSON.stringify({error: {code: 'pane_not_found', message: 'pane w1:gone not found'}, id: 'cli:pane:get'})); process.exit(1); }
if (id === 'w1:pi') { console.log(JSON.stringify({id: 'cli:pane:get', result: {pane: {agent: 'pi', agent_status: 'idle', pane_id: id}}})); process.exit(0); }
if (id === 'w1:sh') { console.log(JSON.stringify({id: 'cli:pane:get', result: {pane: {agent_status: 'unknown', pane_id: id}}})); process.exit(0); }
console.log(JSON.stringify({error: {code: 'internal', message: 'boom'}})); process.exit(1);`);
  const cli = createHerdrCli({bin});
  assert.deepEqual(await cli.paneGet('w1:gone'), {exists: false});
  assert.deepEqual(await cli.paneGet('w1:pi'), {exists: true, agent: 'pi', status: 'idle'});
  assert.deepEqual(await cli.paneGet('w1:sh'), {exists: true, status: 'unknown'});
  await assert.rejects(cli.paneGet('w1:other'), (e: unknown) => e instanceof HerdrError && e.kind === 'failed');
});
```

（fake の `herdr` は `node <script> pane get <id>` として起動されるため、`process.argv[4]` が pane id になる。）

- [ ] **Step 2: テストを実行し、失敗することを確かめる**

Run: `npm test 2>&1 | grep -E "error TS|paneGet" | head`
Expected: `Property 'paneGet' does not exist` の型エラー。

- [ ] **Step 3: 実装する**

`src/handoff/herdr-client.ts`:

1. `HerdrPort` の上に型を追加し、インタフェースにメソッドを足す:

```ts
/** `pane get`: a missing pane is not an error; `agent` is absent when Herdr detects no agent in it. */
export type PaneState = {exists: false} | {exists: true; agent?: string; status?: string};
```

`HerdrPort` に追加:

```ts
  paneGet(paneId: string): Promise<PaneState>;
```

2. `run` に、エラー時の JSON を受け取るオプションを足す。シグネチャと、`ENOENT` 判定の直後を次のように変える:

```ts
  const run = (args: string[], mutation: boolean, opts: {errorJson?: boolean} = {}): Promise<string> => new Promise((resolve, reject) => {
```

```ts
      if (e.code === 'ENOENT') return reject(new HerdrError('not-started', 'herdr is not installed.'));
      // Read-only calls that report "not found" as a JSON error on stdout let the caller decide.
      if (opts.errorJson && !mutation && String(stdout).trim().startsWith('{')) return resolve(String(stdout));
```

3. 返すオブジェクトに `paneGet` を追加する（`agentPrompt` の前）:

```ts
    async paneGet(paneId) {
      const r = json(await run(['pane', 'get', paneId], false, {errorJson: true}));
      if (isRec(r.error)) {
        if (r.error.code === 'pane_not_found') return {exists: false};
        throw new HerdrError('failed', `herdr pane get failed: ${String(r.error.code ?? 'error')}`);
      }
      const pane = isRec(r.result) && isRec(r.result.pane) ? r.result.pane : undefined;
      if (!pane) throw new HerdrError('failed', 'herdr pane get returned no pane.');
      return {exists: true, ...(typeof pane.agent === 'string' ? {agent: pane.agent} : {}), ...(typeof pane.agent_status === 'string' ? {status: pane.agent_status} : {})};
    },
```

`test/helpers/fake-herdr.ts`: import に `type PaneState` を足し、クラスに追加する:

```ts
  readonly panes = new Map<string, PaneState>();
  paneGetFails = false;
  async paneGet(paneId: string): Promise<PaneState> {
    this.calls.push({command: 'paneGet', args: {paneId}});
    if (this.paneGetFails) throw new HerdrError('failed', 'pane get failed');
    return this.panes.get(paneId) ?? {exists: false};
  }
```

（import 行は `import {HerdrError, type HerdrPort, type PaneState} from '../../src/handoff/herdr-client.js';` の形にする。既存の import の書き方に合わせる。）

- [ ] **Step 4: テストを実行し、通ることを確かめる**

Run: `npm test 2>&1 | tail -8 && npm run typecheck`
Expected: `ℹ fail 0`、型検査エラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/handoff/herdr-client.ts test/helpers/fake-herdr.ts test/herdr-client.test.ts
git commit -m "feat(herdr): pane get で pane の有無と agent 状態を読む"
```

---

### Task 3: 判定関数（`decide.ts`）

**Files:**
- Create: `src/watch/decide.ts`
- Test: `test/decide.test.ts`

**Interfaces:**
- Consumes: `TailResult`（Task 1）
- Produces:
  - 定数 `CHECK_INTERVAL_MS`、`RETRY_DELAYS_MS`、`MAX_AUTO_CONTINUE`、`HERDR_FAILURE_LIMIT`、`CONTINUE_PROMPT`
  - `interface WatchEntry {ownerSessionId: string; paneId: string; tabId: string; workspaceId: string; targetSessionId: string; cwd: string; repo: string; epicIssue: number; targetStage: string; addedAt: string}`
  - `interface WatchProgress {retryCount: number; pendingRetryAt?: number; exhaustedErrorAt?: number; lastNoticeKey?: string; herdrFailures: number}`
  - `INITIAL_PROGRESS: WatchProgress`
  - `type Observation = {kind: 'gone'} | {kind: 'exited'} | {kind: 'working'} | {kind: 'blocked'} | {kind: 'idle'; tail: TailResult} | {kind: 'unclear'; reason: string}`
  - `type NoticeLevel = 'info' | 'warning' | 'error'`
  - `type WatchAction = {type: 'notify'; level: NoticeLevel; text: string} | {type: 'prompt'; text: string; errorAt: number} | {type: 'stop'}`
  - `noticeHead(entry: WatchEntry): string`
  - `decide(entry: WatchEntry, progress: WatchProgress, obs: Observation, now: number): {actions: WatchAction[]; next: WatchProgress}`

- [ ] **Step 1: 失敗するテストを書く**

`test/decide.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {CONTINUE_PROMPT, decide, INITIAL_PROGRESS, MAX_AUTO_CONTINUE, RETRY_DELAYS_MS, type Observation, type WatchEntry, type WatchProgress} from '../src/watch/decide.js';

const entry: WatchEntry = {ownerSessionId: 'parent', paneId: 'w9:p2', tabId: 'w9:t2', workspaceId: 'w9', targetSessionId: 'target-session', cwd: '/synthetic/repo', repo: 'example/demo', epicIssue: 10, targetStage: 'specification', addedAt: '2026-10-11T00:00:00.000Z'};
const transient = (at = 100): Observation => ({kind: 'idle', tail: {kind: 'error', transient: true, message: 'fetch failed', at}});
const run = (obs: Observation, progress: WatchProgress = INITIAL_PROGRESS, now = 0) => decide(entry, progress, obs, now);
const types = (r: ReturnType<typeof decide>) => r.actions.map(a => a.type);

test('gone and exited notify once and stop watching', () => {
  for (const kind of ['gone', 'exited'] as const) {
    const r = run({kind});
    assert.deepEqual(types(r), ['notify', 'stop'], kind);
    assert.match((r.actions[0] as {text: string}).text, /^pi-scaffold: Epic #10（example\/demo・specification）: /);
  }
});

test('blocked notifies once; the same state again is silent; working clears the notice', () => {
  const first = run({kind: 'blocked'});
  assert.deepEqual(types(first), ['notify']);
  assert.equal((first.actions[0] as {level: string}).level, 'warning');
  assert.deepEqual(types(run({kind: 'blocked'}, first.next)), []);
  const working = run({kind: 'working'}, first.next);
  assert.deepEqual(types(working), []);
  assert.deepEqual(types(run({kind: 'blocked'}, working.next)), ['notify']);
});

test('a transient error is scheduled, then continued after the delay, and the count grows', () => {
  const scheduled = run(transient(), INITIAL_PROGRESS, 1_000);
  assert.deepEqual(types(scheduled), ['notify']);
  assert.equal(scheduled.next.pendingRetryAt, 1_000 + RETRY_DELAYS_MS[0]);
  assert.deepEqual(types(run(transient(), scheduled.next, 1_000 + RETRY_DELAYS_MS[0] - 1)), []);
  const sent = run(transient(), scheduled.next, 1_000 + RETRY_DELAYS_MS[0]);
  assert.deepEqual(sent.actions, [{type: 'prompt', text: CONTINUE_PROMPT, errorAt: 100}]);
  assert.equal(sent.next.retryCount, 1);
  assert.equal(sent.next.pendingRetryAt, undefined);
});

test('repeated errors exhaust: working does not reset the count, only a normal end does', () => {
  let p: WatchProgress = INITIAL_PROGRESS, now = 0;
  for (let i = 0; i < MAX_AUTO_CONTINUE; i++) {
    p = run(transient(100 + i), p, now).next;          // schedule
    now += RETRY_DELAYS_MS[i]!;
    const sent = run(transient(100 + i), p, now);      // send
    assert.equal(sent.actions[0]?.type, 'prompt', `attempt ${i + 1}`);
    p = run({kind: 'working'}, sent.next, now).next;   // the child ran, then failed again
  }
  assert.equal(p.retryCount, MAX_AUTO_CONTINUE);
  const exhausted = run(transient(999), p, now);
  assert.deepEqual(types(exhausted), ['notify']);
  assert.equal((exhausted.actions[0] as {level: string}).level, 'error');
  assert.deepEqual(types(run(transient(999), exhausted.next, now + 10 ** 7)), [], 'no more sends or notices for that error');
  const ended = run({kind: 'idle', tail: {kind: 'stopped', reason: 'stop', at: 1000}}, exhausted.next, now);
  assert.equal(ended.next.retryCount, 0);
});

test('a prompt that did not take effect (same error still there) waits the next, longer delay', () => {
  const p = run(transient(), INITIAL_PROGRESS, 0).next;
  const sent = run(transient(), p, RETRY_DELAYS_MS[0]);
  const again = run(transient(), sent.next, RETRY_DELAYS_MS[0] + 60_000);
  assert.equal(again.next.pendingRetryAt, RETRY_DELAYS_MS[0] + 60_000 + RETRY_DELAYS_MS[1]);
  assert.deepEqual(types(again), ['notify']);
});

test('a non-transient error, an abort, a normal end and an unknown tail only notify, once each', () => {
  const cases: [Observation, string][] = [
    [{kind: 'idle', tail: {kind: 'error', transient: false, message: '400 ' + 'x'.repeat(300), at: 5}}, 'error'],
    [{kind: 'idle', tail: {kind: 'stopped', reason: 'aborted', at: 6}}, 'info'],
    [{kind: 'idle', tail: {kind: 'stopped', reason: 'stop', at: 7}}, 'info'],
    [{kind: 'idle', tail: {kind: 'unknown', reason: 'log-version'}}, 'warning'],
  ];
  for (const [obs, level] of cases) {
    const r = run(obs);
    assert.deepEqual(r.actions.map(a => [a.type, (a as {level?: string}).level]), [['notify', level]]);
    assert.ok((r.actions[0] as {text: string}).text.length < 220, 'error text is cut to 120 characters');
    assert.deepEqual(types(run(obs, r.next)), []);
  }
});

test('herdr failures notify once at the third in a row and reset on any good observation', () => {
  let p = INITIAL_PROGRESS;
  const seen: number[] = [];
  for (let i = 0; i < 5; i++) { const r = run({kind: 'unclear', reason: 'boom'}, p); seen.push(r.actions.length); p = r.next; }
  assert.deepEqual(seen, [0, 0, 1, 0, 0]);
  assert.equal(run({kind: 'working'}, p).next.herdrFailures, 0);
});
```

- [ ] **Step 2: テストを実行し、失敗することを確かめる**

Run: `npm test 2>&1 | grep -E "error TS" | head -3`
Expected: `Cannot find module '../src/watch/decide.js'`。

- [ ] **Step 3: 実装する**

`src/watch/decide.ts`:

```ts
// Pure decision for one watched stage pane: (progress, observation, now) → actions + next progress.
// No I/O here; watcher.ts observes and acts. Spec: docs/superpowers/specs/2026-10-11-stage-watch-design.md
import type {TailResult} from './session-tail.js';

export const CHECK_INTERVAL_MS = 60_000;
export const RETRY_DELAYS_MS = [60_000, 300_000, 900_000] as const;
export const MAX_AUTO_CONTINUE = RETRY_DELAYS_MS.length;
export const HERDR_FAILURE_LIMIT = 3;
export const CONTINUE_PROMPT = 'pi-scaffold: 一時的なエラーで止まったため再開します。直前の作業を続けてください。';
const MESSAGE_CHARS = 120;

export interface WatchEntry {
  ownerSessionId: string; paneId: string; tabId: string; workspaceId: string; targetSessionId: string;
  cwd: string; repo: string; epicIssue: number; targetStage: string; addedAt: string;
}
export interface WatchProgress {
  retryCount: number; pendingRetryAt?: number; exhaustedErrorAt?: number; lastNoticeKey?: string; herdrFailures: number;
}
export const INITIAL_PROGRESS: WatchProgress = Object.freeze({retryCount: 0, herdrFailures: 0});

export type Observation =
  | {kind: 'gone'} | {kind: 'exited'} | {kind: 'working'} | {kind: 'blocked'}
  | {kind: 'idle'; tail: TailResult}
  | {kind: 'unclear'; reason: string};
export type NoticeLevel = 'info' | 'warning' | 'error';
export type WatchAction =
  | {type: 'notify'; level: NoticeLevel; text: string}
  | {type: 'prompt'; text: string; errorAt: number}
  | {type: 'stop'};

export const noticeHead = (e: WatchEntry) => `pi-scaffold: Epic #${e.epicIssue}（${e.repo}・${e.targetStage}）`;
const minutes = (ms: number) => `${Math.round(ms / 60_000)}分`;
const cut = (s: string) => s.length > MESSAGE_CHARS ? `${s.slice(0, MESSAGE_CHARS)}…` : s;

export function decide(entry: WatchEntry, progress: WatchProgress, obs: Observation, now: number): {actions: WatchAction[]; next: WatchProgress} {
  const p: WatchProgress = {...progress};
  const actions: WatchAction[] = [];
  const notify = (level: NoticeLevel, text: string) => actions.push({type: 'notify', level, text: `${noticeHead(entry)}: ${text}`});
  const notifyOnce = (key: string, level: NoticeLevel, text: string) => { if (p.lastNoticeKey === key) return; p.lastNoticeKey = key; notify(level, text); };

  if (obs.kind === 'unclear') {
    p.herdrFailures += 1;
    if (p.herdrFailures === HERDR_FAILURE_LIMIT) notify('warning', `下位 pane の状態を ${HERDR_FAILURE_LIMIT} 回続けて読めませんでした（${cut(obs.reason)}）。`);
    return {actions, next: p};
  }
  p.herdrFailures = 0;

  switch (obs.kind) {
    case 'gone': notify('error', '下位の pane が消えました。監視を終えます。'); actions.push({type: 'stop'}); break;
    case 'exited': notify('warning', '下位の pi が終了しました。監視を終えます。'); actions.push({type: 'stop'}); break;
    case 'working': delete p.pendingRetryAt; delete p.lastNoticeKey; break; // the count stays: only a normal end resets it
    case 'blocked': notifyOnce('blocked', 'warning', '下位が確認・入力を待っています。'); break;
    case 'idle': {
      const tail = obs.tail;
      if (tail.kind === 'unknown') { notifyOnce(`unknown:${tail.reason}`, 'warning', `下位は止まっていますが、理由を判定できません（${tail.reason}）。自動再開はしません。`); break; }
      if (tail.kind === 'stopped') {
        p.retryCount = 0; delete p.pendingRetryAt;
        if (tail.reason === 'aborted') notifyOnce(`aborted:${tail.at}`, 'info', '下位のターンは中断されています。');
        else notifyOnce(`stopped:${tail.at}`, 'info', '下位が返事待ちか、工程の作業を終えています。');
        break;
      }
      if (!tail.transient) { notifyOnce(`error:${tail.at}`, 'error', `下位がエラーで止まっています: ${cut(tail.message)}`); break; }
      if (p.exhaustedErrorAt === tail.at) break;
      if (p.retryCount >= MAX_AUTO_CONTINUE) {
        p.exhaustedErrorAt = tail.at; delete p.pendingRetryAt;
        notifyOnce(`exhausted:${tail.at}`, 'error', `自動再開を ${MAX_AUTO_CONTINUE} 回試しましたが止まっています: ${cut(tail.message)}`);
        break;
      }
      if (p.pendingRetryAt === undefined) {
        const delay = RETRY_DELAYS_MS[p.retryCount]!;
        p.pendingRetryAt = now + delay;
        notifyOnce(`transient:${tail.at}:${p.retryCount}`, 'warning', `下位が一時的なエラーで止まっています。${minutes(delay)}後に自動で再開します: ${cut(tail.message)}`);
        break;
      }
      if (now < p.pendingRetryAt) break;
      p.retryCount += 1; delete p.pendingRetryAt;
      actions.push({type: 'prompt', text: CONTINUE_PROMPT, errorAt: tail.at});
      break;
    }
  }
  return {actions, next: p};
}
```

- [ ] **Step 4: テストを実行し、通ることを確かめる**

Run: `npm test 2>&1 | tail -8`
Expected: `ℹ fail 0`

- [ ] **Step 5: コミット**

```bash
git add src/watch/decide.ts test/decide.test.ts
git commit -m "feat(watch): 下位 pane の観測から通知・自動再開を決める判定関数を追加"
```

---

### Task 4: 監視台帳（`registry.ts`）

**Files:**
- Create: `src/watch/registry.ts`
- Test: `test/watch-registry.test.ts`

**Interfaces:**
- Consumes: `WatchEntry`・`WatchProgress`・`INITIAL_PROGRESS`（Task 3）、`readOwnedJson`・`writeOwnedFile`・`OwnedFileError`（`src/core/files.ts`）
- Produces:
  - `interface WatchRecord {entry: WatchEntry; progress: WatchProgress}`
  - `sameWatch(a: WatchEntry, b: WatchEntry): boolean`
  - `class WatchRegistry { constructor(agentDir: string); readonly path: string; load(): Promise<{records: WatchRecord[]; corrupt: boolean}>; upsert(entry: WatchEntry): Promise<void>; update(record: WatchRecord): Promise<void>; remove(entry: WatchEntry): Promise<void> }`

- [ ] **Step 1: 失敗するテストを書く**

`test/watch-registry.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, stat, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {WatchRegistry} from '../src/watch/registry.js';
import {INITIAL_PROGRESS, type WatchEntry} from '../src/watch/decide.js';

const entry = (paneId = 'w9:p2', owner = 'parent'): WatchEntry => ({ownerSessionId: owner, paneId, tabId: 'w9:t2', workspaceId: 'w9', targetSessionId: `s-${paneId}`, cwd: '/synthetic/repo', repo: 'example/demo', epicIssue: 10, targetStage: 'specification', addedAt: '2026-10-11T00:00:00.000Z'});
async function registry(t: {after(fn: () => Promise<void>): void}) {
  const agentDir = await mkdtemp(join(tmpdir(), 'pi-scaffold-watch-'));
  t.after(() => rm(agentDir, {recursive: true, force: true}));
  return new WatchRegistry(agentDir);
}

test('a missing registry is empty and not corrupt', async t => {
  assert.deepEqual(await (await registry(t)).load(), {records: [], corrupt: false});
});

test('upsert adds once per pane+session, resets progress, and writes an owner-only file', async t => {
  const r = await registry(t);
  await r.upsert(entry());
  await r.update({entry: entry(), progress: {...INITIAL_PROGRESS, retryCount: 2}});
  await r.upsert(entry('w9:p3'));
  assert.equal((await r.load()).records.find(x => x.entry.paneId === 'w9:p2')?.progress.retryCount, 2);
  await r.upsert(entry());
  const {records} = await r.load();
  assert.deepEqual(records.map(x => x.entry.paneId).sort(), ['w9:p2', 'w9:p3']);
  assert.equal(records.find(x => x.entry.paneId === 'w9:p2')?.progress.retryCount, 0);
  assert.equal((await stat(r.path)).mode & 0o777, 0o600);
});

test('remove drops only that watch', async t => {
  const r = await registry(t);
  await r.upsert(entry()); await r.upsert(entry('w9:p3'));
  await r.remove(entry());
  assert.deepEqual((await r.load()).records.map(x => x.entry.paneId), ['w9:p3']);
});

test('an unreadable file or a malformed record is reported as corrupt and skipped', async t => {
  const r = await registry(t);
  await mkdir(dirname(r.path), {recursive: true, mode: 0o700});
  await writeFile(r.path, '{not json', {mode: 0o600});
  assert.deepEqual(await r.load(), {records: [], corrupt: true});
  await writeFile(r.path, JSON.stringify({version: 1, watches: [{entry: entry(), progress: INITIAL_PROGRESS}, {entry: {paneId: 3}}]}), {mode: 0o600});
  const loaded = await r.load();
  assert.equal(loaded.corrupt, true);
  assert.deepEqual(loaded.records.map(x => x.entry.paneId), ['w9:p2']);
});
```

- [ ] **Step 2: テストを実行し、失敗することを確かめる**

Run: `npm test 2>&1 | grep -E "error TS" | head -3`
Expected: `Cannot find module '../src/watch/registry.js'`。

- [ ] **Step 3: 実装する**

`src/watch/registry.ts`:

```ts
// The watch registry: which stage panes each Pi session handed off and how far their watch has got.
// Shared by every session of this agent dir; each session only acts on records it owns (ownerSessionId).
import {join} from 'node:path';
import {OwnedFileError, readOwnedJson, writeOwnedFile} from '../core/files.js';
import {INITIAL_PROGRESS, type WatchEntry, type WatchProgress} from './decide.js';

export interface WatchRecord { entry: WatchEntry; progress: WatchProgress }
export const sameWatch = (a: WatchEntry, b: WatchEntry) => a.paneId === b.paneId && a.targetSessionId === b.targetSessionId;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const STRING_FIELDS = ['ownerSessionId', 'paneId', 'tabId', 'workspaceId', 'targetSessionId', 'cwd', 'repo', 'targetStage', 'addedAt'] as const;
function isRecord(v: unknown): v is WatchRecord {
  if (!isRec(v) || !isRec(v.entry) || !isRec(v.progress)) return false;
  const e = v.entry, p = v.progress;
  return STRING_FIELDS.every(k => typeof e[k] === 'string') && Number.isInteger(e.epicIssue)
    && typeof p.retryCount === 'number' && typeof p.herdrFailures === 'number';
}

export class WatchRegistry {
  private readonly root: string;
  readonly path: string;
  constructor(agentDir: string) { this.root = join(agentDir, 'pi-scaffold'); this.path = join(this.root, 'state', 'watches.json'); }

  /** A missing file is empty. An unreadable file or malformed records are skipped and reported as corrupt. */
  async load(): Promise<{records: WatchRecord[]; corrupt: boolean}> {
    let raw: unknown;
    try { raw = await readOwnedJson(this.path, {root: this.root}); }
    catch (e) { return {records: [], corrupt: !(e instanceof OwnedFileError && e.code === 'NOT_FOUND')}; }
    if (!isRec(raw) || raw.version !== 1 || !Array.isArray(raw.watches)) return {records: [], corrupt: true};
    const records = raw.watches.filter(isRecord);
    return {records, corrupt: records.length !== raw.watches.length};
  }
  private async save(records: WatchRecord[]): Promise<void> {
    await writeOwnedFile(this.path, `${JSON.stringify({version: 1, watches: records}, null, 2)}\n`, {root: this.root});
  }
  /** (Re)registers a handed-off pane with fresh progress. */
  async upsert(entry: WatchEntry): Promise<void> {
    const {records} = await this.load();
    await this.save([...records.filter(r => !sameWatch(r.entry, entry)), {entry, progress: {...INITIAL_PROGRESS}}]);
  }
  /** Re-reads before writing so records other sessions added meanwhile are kept. */
  async update(record: WatchRecord): Promise<void> {
    const {records} = await this.load();
    if (!records.some(r => sameWatch(r.entry, record.entry))) return;
    await this.save(records.map(r => sameWatch(r.entry, record.entry) ? record : r));
  }
  async remove(entry: WatchEntry): Promise<void> {
    const {records} = await this.load();
    await this.save(records.filter(r => !sameWatch(r.entry, entry)));
  }
}
```

- [ ] **Step 4: テストを実行し、通ることを確かめる**

Run: `npm test 2>&1 | tail -8`
Expected: `ℹ fail 0`

- [ ] **Step 5: コミット**

```bash
git add src/watch/registry.ts test/watch-registry.test.ts
git commit -m "feat(watch): 引き継いだ下位 pane の監視台帳を追加"
```

---

### Task 5: 監視の実行（`watcher.ts`）

**Files:**
- Create: `src/watch/watcher.ts`
- Test: `test/watcher.test.ts`

**Interfaces:**
- Consumes: `HerdrPort`・`SUPPORTED_HERDR`・`PaneState`（Task 2）、`decide`・`noticeHead`・`CHECK_INTERVAL_MS`・`MAX_AUTO_CONTINUE`・`WatchEntry`・`Observation`・`NoticeLevel`（Task 3）、`WatchRegistry`・`WatchRecord`（Task 4）、`TailResult`（Task 1）
- Produces:
  - `type WatchHerdr = Pick<HerdrPort, 'version' | 'paneGet' | 'processInfo' | 'agentPrompt'>`
  - `interface WatcherDeps {ownerSessionId: string; registry: WatchRegistry; herdr: WatchHerdr; readTail(entry: WatchEntry): Promise<TailResult>; notify(text: string, level: NoticeLevel): void; now(): number; intervalMs?: number; setInterval?(fn: () => void, ms: number): unknown; clearInterval?(handle: unknown): void}`
  - `class StageWatcher { constructor(deps: WatcherDeps); add(entry: WatchEntry): Promise<void>; resume(): Promise<void>; tick(): Promise<void>; stop(): void; readonly active: boolean }`

- [ ] **Step 1: 失敗するテストを書く**

`test/watcher.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StageWatcher} from '../src/watch/watcher.js';
import {WatchRegistry} from '../src/watch/registry.js';
import {CONTINUE_PROMPT, RETRY_DELAYS_MS, type WatchEntry} from '../src/watch/decide.js';
import type {TailResult} from '../src/watch/session-tail.js';
import {FakeHerdr} from './helpers/fake-herdr.js';

const entry = (paneId = 'w9:p2', owner = 'parent'): WatchEntry => ({ownerSessionId: owner, paneId, tabId: 'w9:t2', workspaceId: 'w9', targetSessionId: `s-${paneId}`, cwd: '/synthetic/repo', repo: 'example/demo', epicIssue: 10, targetStage: 'specification', addedAt: '2026-10-11T00:00:00.000Z'});
const fetchFailed: TailResult = {kind: 'error', transient: true, message: 'fetch failed', at: 100};

async function setup(t: {after(fn: () => Promise<void>): void}, opts: {owner?: string} = {}) {
  const agentDir = await mkdtemp(join(tmpdir(), 'pi-scaffold-watcher-'));
  t.after(() => rm(agentDir, {recursive: true, force: true}));
  const herdr = new FakeHerdr();
  const registry = new WatchRegistry(agentDir);
  const notices: {text: string; level: string}[] = [];
  const timers: {fn: () => void; ms: number}[] = [];
  let cleared = 0;
  const state = {now: 0, tails: [] as TailResult[], lastTail: fetchFailed as TailResult};
  const watcher = new StageWatcher({
    ownerSessionId: opts.owner ?? 'parent', registry, herdr, now: () => state.now,
    readTail: async () => { state.lastTail = state.tails.shift() ?? state.lastTail; return state.lastTail; },
    notify: (text, level) => notices.push({text, level}),
    setInterval: (fn, ms) => { timers.push({fn, ms}); return timers.length; },
    clearInterval: () => { cleared += 1; },
  });
  return {herdr, registry, notices, timers, state, watcher, cleared: () => cleared};
}

test('add registers the pane and starts one 60-second timer', async t => {
  const s = await setup(t);
  await s.watcher.add(entry()); await s.watcher.add(entry());
  assert.equal(s.timers.length, 1);
  assert.equal(s.timers[0]!.ms, 60_000);
  assert.equal(s.watcher.active, true);
  assert.equal((await s.registry.load()).records.length, 1);
});

test('a transient error: notice first, then exactly one continue after the delay', async t => {
  const s = await setup(t);
  s.herdr.panes.set('w9:p2', {exists: true, agent: 'pi', status: 'idle'});
  await s.watcher.add(entry());
  await s.watcher.tick();
  assert.equal(s.herdr.count('agentPrompt'), 0);
  assert.equal(s.notices.length, 1);
  s.state.now = RETRY_DELAYS_MS[0];
  await s.watcher.tick();
  assert.deepEqual(s.herdr.calls.filter(c => c.command === 'agentPrompt').map(c => c.args), [{paneId: 'w9:p2', text: CONTINUE_PROMPT}]);
  assert.match(s.notices.at(-1)!.text, /自動で再開を送りました（1\/3回目）/);
  assert.equal((await s.registry.load()).records[0]!.progress.retryCount, 1, 'progress survives a restart');
});

test('precheck mismatch: if the child moved on before sending, nothing is sent and progress is kept', async t => {
  const s = await setup(t);
  s.herdr.panes.set('w9:p2', {exists: true, agent: 'pi', status: 'idle'});
  await s.watcher.add(entry());
  await s.watcher.tick();
  s.state.now = RETRY_DELAYS_MS[0];
  s.state.tails = [fetchFailed, {kind: 'stopped', reason: 'stop', at: 200}];
  await s.watcher.tick();
  assert.equal(s.herdr.count('agentPrompt'), 0);
  assert.equal((await s.registry.load()).records[0]!.progress.retryCount, 0);
});

test('a gone pane is notified and removed; the next check with nothing owned stops the timer', async t => {
  const s = await setup(t);
  await s.watcher.add(entry());
  await s.watcher.tick();
  assert.equal(s.notices[0]!.level, 'error');
  assert.deepEqual((await s.registry.load()).records, []);
  await s.watcher.tick();
  assert.equal(s.watcher.active, false);
});

test('a pane whose agent is gone and whose shell is in front is an exited pi', async t => {
  const s = await setup(t);
  s.herdr.panes.set('w9:p2', {exists: true, status: 'unknown'});
  s.herdr.shellReady = true;
  await s.watcher.add(entry());
  await s.watcher.tick();
  assert.match(s.notices[0]!.text, /pi が終了しました/);
});

test('other owner: watches of another session are neither checked nor resumed', async t => {
  const s = await setup(t);
  await s.registry.upsert(entry('w9:p7', 'someone-else'));
  await s.watcher.resume();
  assert.equal(s.timers.length, 0);
  await s.watcher.add(entry());
  s.herdr.panes.set('w9:p2', {exists: true, agent: 'pi', status: 'working'});
  await s.watcher.tick();
  assert.deepEqual(s.herdr.calls.filter(c => c.command === 'paneGet').map(c => c.args), [{paneId: 'w9:p2'}]);
});

test('resume restarts the timer when this session still owns watches', async t => {
  const s = await setup(t);
  await s.registry.upsert(entry());
  await s.watcher.resume();
  assert.equal(s.timers.length, 1);
});

test('an unsupported Herdr notifies once and stops; a failing version call only skips the check', async t => {
  const s = await setup(t);
  await s.watcher.add(entry());
  const original = s.herdr.version.bind(s.herdr);
  s.herdr.version = async () => { throw new Error('socket down'); };
  await s.watcher.tick();
  assert.equal(s.watcher.active, true);
  assert.equal(s.notices.length, 0);
  s.herdr.version = original;
  s.herdr.version_ = {version: '0.9.2', protocol: 23};
  await s.watcher.tick(); await s.watcher.tick();
  assert.equal(s.notices.length, 1);
  assert.equal(s.watcher.active, false);
});

test('a check still running makes the next one a no-op', async t => {
  const s = await setup(t);
  s.herdr.panes.set('w9:p2', {exists: true, agent: 'pi', status: 'working'});
  await s.watcher.add(entry());
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const original = s.herdr.paneGet.bind(s.herdr);
  s.herdr.paneGet = async id => { await gate; return original(id); };
  const first = s.watcher.tick();
  await s.watcher.tick();
  release(); await first;
  assert.equal(s.herdr.count('paneGet'), 1);
});
```

- [ ] **Step 2: テストを実行し、失敗することを確かめる**

Run: `npm test 2>&1 | grep -E "error TS" | head -3`
Expected: `Cannot find module '../src/watch/watcher.js'`。

- [ ] **Step 3: 実装する**

`src/watch/watcher.ts`:

```ts
// Background watch of the stage panes this Pi session handed off. One timer per session, running only while the
// registry holds watches this session owns; each check is observe → decide → act. Spec: Issue #36.
import {SUPPORTED_HERDR, type HerdrPort} from '../handoff/herdr-client.js';
import {CHECK_INTERVAL_MS, MAX_AUTO_CONTINUE, decide, noticeHead, type NoticeLevel, type Observation, type WatchEntry} from './decide.js';
import type {WatchRecord, WatchRegistry} from './registry.js';
import type {TailResult} from './session-tail.js';

export type WatchHerdr = Pick<HerdrPort, 'version' | 'paneGet' | 'processInfo' | 'agentPrompt'>;
export interface WatcherDeps {
  ownerSessionId: string;
  registry: WatchRegistry;
  herdr: WatchHerdr;
  readTail(entry: WatchEntry): Promise<TailResult>;
  notify(text: string, level: NoticeLevel): void;
  now(): number;
  intervalMs?: number;
  setInterval?(fn: () => void, ms: number): unknown;
  clearInterval?(handle: unknown): void;
}

export class StageWatcher {
  private timer: unknown;
  private running = false;
  private herdr: 'ok' | 'unsupported' | undefined;
  private corruptNotified = false;
  constructor(private readonly deps: WatcherDeps) {}

  get active(): boolean { return this.timer !== undefined; }
  /** Registers a handed-off pane (idempotent) and makes sure the timer runs. */
  async add(entry: WatchEntry): Promise<void> { await this.deps.registry.upsert(entry); this.ensureTimer(); }
  /** session_start: restart the timer when this session still owns watches. */
  async resume(): Promise<void> { if ((await this.owned()).length) this.ensureTimer(); }
  stop(): void {
    if (this.timer === undefined) return;
    if (this.deps.clearInterval) this.deps.clearInterval(this.timer); else clearInterval(this.timer as ReturnType<typeof setInterval>);
    this.timer = undefined;
  }

  private ensureTimer(): void {
    if (this.timer !== undefined || this.herdr === 'unsupported') return;
    const fn = () => { void this.tick(); };
    const ms = this.deps.intervalMs ?? CHECK_INTERVAL_MS;
    const handle = this.deps.setInterval ? this.deps.setInterval(fn, ms) : setInterval(fn, ms);
    (handle as {unref?: () => void}).unref?.();
    this.timer = handle;
  }

  private async owned(): Promise<WatchRecord[]> {
    const {records, corrupt} = await this.deps.registry.load();
    if (corrupt && !this.corruptNotified) { this.corruptNotified = true; this.deps.notify('pi-scaffold: 監視台帳に読めない項目があったため、読み飛ばしました。', 'warning'); }
    return records.filter(r => r.entry.ownerSessionId === this.deps.ownerSessionId);
  }

  /** 'skip' when Herdr could not be asked this time; the next check asks again. */
  private async herdrState(): Promise<'ok' | 'unsupported' | 'skip'> {
    if (this.herdr) return this.herdr;
    let v: {version: string; protocol: number};
    try { v = await this.deps.herdr.version(); } catch { return 'skip'; }
    this.herdr = v.version === SUPPORTED_HERDR.version && v.protocol === SUPPORTED_HERDR.protocol ? 'ok' : 'unsupported';
    if (this.herdr === 'unsupported') this.deps.notify(`pi-scaffold: Herdr ${v.version}/protocol ${v.protocol} は未検証のため、下位の監視を止めました（必要: ${SUPPORTED_HERDR.version}/${SUPPORTED_HERDR.protocol}）。`, 'warning');
    return this.herdr;
  }

  /** One check of every owned watch. A check still running makes this one a no-op. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const records = await this.owned();
      if (!records.length) { this.stop(); return; }
      const herdr = await this.herdrState();
      if (herdr === 'unsupported') { this.stop(); return; }
      if (herdr === 'skip') return;
      for (const record of records) {
        // One broken watch must not stop the others; the next check retries it.
        try { await this.check(record); } catch { /* retried next check */ }
      }
    } finally { this.running = false; }
  }

  private async observe(entry: WatchEntry): Promise<Observation> {
    let pane;
    try { pane = await this.deps.herdr.paneGet(entry.paneId); } catch (e) { return {kind: 'unclear', reason: (e as Error).message}; }
    if (!pane.exists) return {kind: 'gone'};
    if (pane.agent !== 'pi') {
      try { return (await this.deps.herdr.processInfo(entry.paneId)).shellReady ? {kind: 'exited'} : {kind: 'unclear', reason: 'agent-not-detected'}; }
      catch (e) { return {kind: 'unclear', reason: (e as Error).message}; }
    }
    switch (pane.status) {
      case 'working': return {kind: 'working'};
      case 'blocked': return {kind: 'blocked'};
      case 'idle': case 'done': return {kind: 'idle', tail: await this.deps.readTail(entry)};
      default: return {kind: 'unclear', reason: `status-${pane.status ?? 'none'}`};
    }
  }

  private async check(record: WatchRecord): Promise<void> {
    const {entry} = record;
    const {actions, next} = decide(entry, record.progress, await this.observe(entry), this.deps.now());
    let progress = next, remove = false;
    for (const action of actions) {
      if (action.type === 'notify') this.deps.notify(action.text, action.level);
      else if (action.type === 'stop') remove = true;
      else {
        // Re-check right before typing into the child: someone may have moved it on since the observation.
        const again = await this.observe(entry);
        if (again.kind !== 'idle' || again.tail.kind !== 'error' || again.tail.at !== action.errorAt) { progress = record.progress; continue; }
        try {
          await this.deps.herdr.agentPrompt(entry.paneId, action.text);
          this.deps.notify(`${noticeHead(entry)}: 自動で再開を送りました（${next.retryCount}/${MAX_AUTO_CONTINUE}回目）。`, 'info');
        } catch (e) {
          // Possibly typed already: count it and do not resend now (a double "continue" is worse than a missed one).
          this.deps.notify(`${noticeHead(entry)}: 再開の送信を確認できませんでした（${(e as Error).message}）。この回は再送しません。`, 'warning');
        }
      }
    }
    if (remove) await this.deps.registry.remove(entry);
    else await this.deps.registry.update({entry, progress});
  }
}
```

- [ ] **Step 4: テストを実行し、通ることを確かめる**

Run: `npm test 2>&1 | tail -8 && npm run typecheck`
Expected: `ℹ fail 0`、型検査エラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/watch/watcher.ts test/watcher.test.ts
git commit -m "feat(watch): 下位 pane を 60 秒ごとに確認して通知・自動再開する監視を追加"
```

---

### Task 6: 引き継ぎと拡張への組み込み

**Files:**
- Modify: `src/core/runtime.ts`（`ScaffoldRuntime` と `createRuntime`）
- Modify: `src/handoff/driver.ts`（`handoffStage` の末尾、`return result as ScaffoldResult<HandoffData>;` の直前）
- Modify: `extensions/index.ts`
- Test: `test/handoff-specification.test.ts`

**Interfaces:**
- Consumes: `WatchEntry`（Task 3）、`StageWatcher`（Task 5）、`WatchRegistry`（Task 4）、`tailReader`（Task 1）、`createHerdrCli`
- Produces: `ScaffoldRuntime.watch?: {add(entry: WatchEntry): Promise<void>}`

- [ ] **Step 1: 失敗するテストを書く**

`test/handoff-specification.test.ts` の末尾に追加する（既存の `world`・`receiver`・`harness` をそのまま使う）:

```ts
test('an applied handoff registers the new pane for watching; a failing watch does not change the result', async t => {
  const gh = world(), herdr = new FakeHerdr();
  let agentDir = '';
  receiver(herdr, () => agentDir);
  const h = await harness(t, gh, herdr); agentDir = h.agentDir;
  const added: unknown[] = [];
  h.runtime.watch = {add: async entry => { added.push(entry); }};
  const out = await h.invoke();
  assert.equal(out.r.status, 'applied', JSON.stringify(out.r.problems));
  assert.equal(added.length, 1);
  const e = added[0] as Record<string, unknown>;
  assert.deepEqual({paneId: e.paneId, tabId: e.tabId, workspaceId: e.workspaceId, targetSessionId: e.targetSessionId, cwd: e.cwd, repo: e.repo, epicIssue: e.epicIssue, targetStage: e.targetStage},
    {paneId: 'w9:p2', tabId: 'w9:t2', workspaceId: 'w9', targetSessionId: 'target-session', cwd: '/synthetic/repo', repo: 'example/demo', epicIssue: 10, targetStage: 'specification'});
  assert.equal(typeof e.ownerSessionId, 'string');
  assert.ok((e.ownerSessionId as string).length > 0);
});

test('a watch registration that throws still reports the handoff as applied', async t => {
  const gh = world(), herdr = new FakeHerdr();
  let agentDir = '';
  receiver(herdr, () => agentDir);
  const h = await harness(t, gh, herdr); agentDir = h.agentDir;
  h.runtime.watch = {add: async () => { throw new Error('disk full'); }};
  assert.equal((await h.invoke()).r.status, 'applied');
});
```

- [ ] **Step 2: テストを実行し、失敗することを確かめる**

Run: `npm test 2>&1 | grep -E "error TS|registers the new pane" | head -3`
Expected: `Property 'watch' does not exist on type 'ScaffoldRuntime'` の型エラー。

- [ ] **Step 3: 実装する**

`src/core/runtime.ts`:

- import に追加: `import type {WatchEntry} from '../watch/decide.js';`
- `ScaffoldRuntime` に追加（`now?` の下）:

```ts
  /** Set by the extension: registers an applied handoff's pane for background watching (Issue #36). */
  watch?: {add(entry: WatchEntry): Promise<void>};
```

- `createRuntime` の返り値に追加: `...(options.watch ? {watch: options.watch} : {}),`

`src/handoff/driver.ts`: `return result as ScaffoldResult<HandoffData>;` を次に置き換える:

```ts
  if (result.status === 'applied' && call.runtime.watch) {
    const d = result.data as HandoffData;
    try {
      await call.runtime.watch.add({
        ownerSessionId: call.env.identity().sessionId, paneId: d.paneId, tabId: d.tabId, workspaceId: binding.workspaceId,
        targetSessionId: d.targetSessionId, cwd: ctx.repoRoot, repo: input.repo, epicIssue: input.epicIssue, targetStage: input.nextStage,
        addedAt: new Date(call.now()).toISOString(),
      });
    } catch { /* Watching is best effort; the handoff itself is already applied. */ }
  }
  return result as ScaffoldResult<HandoffData>;
```

`extensions/index.ts`:

1. 冒頭コメントの 1〜2 行目を次に置き換える:

```ts
// Factory: registration only. No process/watch/timer starts here; tools own their work per call, and the
// handoff receiver starts its short retry timer only after session_start and clears it on shutdown.
// Exception (Issue #36): after session_start, the stage watcher runs a 60 s timer only while this session owns
// handed-off panes in the watch registry; it stops on shutdown and when nothing is left to watch.
```

2. import を追加:

```ts
import {join} from 'node:path';
import {createHerdrCli} from '../dist/src/handoff/herdr-client.js';
import {WatchRegistry} from '../dist/src/watch/registry.js';
import {StageWatcher} from '../dist/src/watch/watcher.js';
import {tailReader} from '../dist/src/watch/session-tail.js';
```

3. `const invalidate = ...` の下に追加:

```ts
  let watcher: StageWatcher | undefined;
  runtime.watch = {add: async entry => { await watcher?.add(entry); }};
  const startWatcher = (ctx: {sessionManager: {getSessionId(): string}; ui: {notify(text: string, level?: 'info' | 'warning' | 'error'): void}}) => {
    watcher?.stop();
    watcher = undefined;
    if (process.env.PI_SUBAGENT_CHILD || process.env.HERDR_ENV !== '1') return;
    watcher = new StageWatcher({
      ownerSessionId: ctx.sessionManager.getSessionId(),
      registry: new WatchRegistry(runtime.agentDir),
      herdr: createHerdrCli({...(process.env.HERDR_BIN_PATH ? {bin: process.env.HERDR_BIN_PATH} : {}), ...(process.env.HERDR_SOCKET_PATH ? {socketPath: process.env.HERDR_SOCKET_PATH} : {})}),
      readTail: tailReader(join(runtime.agentDir, 'sessions')),
      notify: (text, level) => ctx.ui.notify(text, level),
      now: Date.now,
    });
    void watcher.resume().catch(() => undefined);
  };
```

4. `pi.on('session_start', (_event, ctx) => {` の中で、`stopRetry();` の直後に `startWatcher(ctx);` を入れる（packet の有無で return する行より前）。

5. `session_shutdown` を次に置き換える:

```ts
  pi.on('session_shutdown', () => { stopRetry(); watcher?.stop(); invalidate(); });
```

- [ ] **Step 4: テストと型検査を実行し、通ることを確かめる**

Run: `npm test 2>&1 | tail -8 && npm run typecheck`
Expected: `ℹ fail 0`、型検査エラーなし（`tsconfig.extension.json` で `extensions/index.ts` も検査される）。

- [ ] **Step 5: コミット**

```bash
git add src/core/runtime.ts src/handoff/driver.ts extensions/index.ts test/handoff-specification.test.ts
git commit -m "feat(watch): 引き継ぎ完了で下位 pane を監視台帳に登録し、セッション開始で監視を再開する"
```

---

### Task 7: README・版数・実機確認

**Files:**
- Modify: `README.md`
- Modify: `package.json`（`"version": "0.3.1"` → `"0.4.0"`）、`package-lock.json`（`npm install --package-lock-only` で同期）

**Interfaces:**
- Consumes: Task 1〜6 の全体
- Produces: なし

- [ ] **Step 1: README に節を追加する**

`README.md` の工程表の後（「承認は親TUIでのみ記録します。」の箇条の後）に次を足す:

```markdown
### 下位工程セッションの監視

引き継ぎが完了すると、親セッションはその下位 pane を60秒ごとに確認します（Herdr 0.9.1／protocol 22 のときだけ）。

- pane が消えた、pi が終了した、確認・入力待ち、エラー停止、返事待ち・完了のときは、親TUIに通知します。同じ状態で通知を繰り返すことはありません。
- 一時的な API エラー（429・5xx・overloaded・接続エラーなど）で止まったときだけ、1分→5分→15分あけて最大3回「続けて」を送ります。送る直前に、同じエラーで止まったままかを確かめます。
- usage limit・認証・400系のエラーは通知だけです。下位のセッションログの形式（version 3）が違う場合も、自動では送りません。
- 監視台帳は `<agentDir>/pi-scaffold/state/watches.json` です。監視するのは、引き継いだ本人のセッションだけです。同じセッションを開き直すと、監視を再開します。
```

- [ ] **Step 2: 版数を上げる**

Run: `npm version 0.4.0 --no-git-tag-version && npm test 2>&1 | tail -6`
Expected: `v0.4.0`、`ℹ fail 0`（`test/package.test.ts` が版数を見ていれば、ここで落ちないことを確かめる）。

- [ ] **Step 3: 実機で確認する（手動。結果を Issue #36 にコメントで残す）**

Herdr 内の Pi（developer Profile）で、テスト用リポジトリの Epic を引き継ぎ、次を確かめる:

1. 引き継ぎ直後に `cat <agentDir>/pi-scaffold/state/watches.json` を実行し、下位 pane が登録されていること。
2. 下位の pi で Esc を押してターンを中断し、2分以内に親に「中断されています」が出ること。
3. 下位の pi を `/quit` で終了し、2分以内に親に「pi が終了しました」が出て、台帳から消えること。
4. 一時的エラーの自動再開は実機で起こしにくいため、Task 5 の単体テストで代える。

（実機テストを `scripts/test-native-handoff.py` に自動化するかは、仕様書の「残る論点」のとおり別に判断する。）

- [ ] **Step 4: コミット**

```bash
git add README.md package.json package-lock.json
git commit -m "docs: 下位工程セッションの監視を README に追記し 0.4.0 として準備"
```
