# scaffold-orchestrator-wait 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** orchestrator の `sleep 300` を、herdr を5秒ごとに読み、行動の要る変化があればすぐ・なければ5分で終わる LLM なしのコマンドに替える。

**Architecture:** deterministic-scaffold に `bin/scaffold-orchestrator-wait`（`src/orchestrator-wait/`）を足す。状態ファイルを読むだけで、herdr の一覧を `scaffold-watchdog` の `createHerdrFleet` で読み、タブごとの前回の記録（`<状態ファイル>.wait.json`）と比べる。claude-scaffold と scaffold-profiles は新しい版を vendor に入れ、スキルの待ち方をこのコマンドに替える。

**Tech Stack:** TypeScript（NodeNext）、`node:test`、herdr CLI。

**Spec:** `docs/superpowers/specs/2026-11-11-orchestrator-wait-design.md`（c7b8df8）

**リポジトリと作業場所**
- deterministic-scaffold: worktree `~/.config/superpowers/worktrees/pi-scaffold/orchestrator-wait`（`feat/orchestrator-wait`。元 `~/Documents/GitHub/pi-scaffold`）
- claude-scaffold: `~/Documents/GitHub/claude-scaffold` に worktree `feat/orchestrator-wait` を作る
- scaffold-profiles: `~/Code/scaffold-profiles` に worktree `feat/orchestrator-wait` を作る（main checkout でブランチを切らない）

## Global Constraints

- Node `>=26.10.0`。herdr は `execFile` の固定 argv で呼ぶ（シェルを通さない）。
- 読むのは herdr だけ。`gh` も GitHub も呼ばない。pane へ入力しない。
- 状態ファイルには書かない。書くのは `<状態ファイル>.wait.json` だけ（一時ファイル＋rename）。
- 既定値: 読む間隔 `5000` ms、最長の待ち `300000` ms（5分）。
- 対象のタブ: `status` が `launching`・`running`・`waiting`・`cleanup_waiting`。`box` のあるタブは読まない。
- 工程のタブ: `^(spec|design|impl|verify|setup)-e<N>(-r[0-9]+)?(-[0-9a-f]{4})?$`。manager のタブ（`^(impl|verify)-mgr-f…`）の agent は本体にしない。
- 終了コード: 変化あり・時間切れは `0`。引数なし・状態ファイルが最初に読めないときは `2`。
- コミットに AI の帰属行を付けない。

## Review Focus

1. orchestrator が書いている途中の状態ファイル（壊れた JSON）を読んだ → 落ちず、前回の対象のまま続ける（Task 3 で試験）。
2. どのセッションにも `w1:p1` がある → タブは `socket|pane` で区別し、別セッションの同じ pane 番号を混ぜない（Task 2）。
3. `herdr session list` が一時的に失敗した → 全タブを「いなくなった」にしない。誤報で起こさない（Task 2）。
4. Epic の無いタブ（`epics: []`）と Epic が2つのタブ → 工程のタブの判定が壊れない（Task 2）。
5. 記録ファイルが無い・壊れている → 空の記録として扱い、落ちない（Task 3）。

---

### Task 1: 状態ファイルから対象を読む

**Files:**
- Create: `src/orchestrator-wait/targets.ts`
- Test: `test/orchestrator-wait-targets.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type WaitTabStatus = 'launching' | 'running' | 'waiting' | 'cleanup_waiting';
  export interface WaitTarget {
    key: string;            // `${socket}|${pane}`
    label: string;          // "Epic #12" / "Epic #12 #13" / "terminal <terminal>"（epics が空のとき）
    socket: string; pane: string; epics: number[]; status: WaitTabStatus;
    cleanupSockets: string[]; // socket と previous[].socket（重複なし、socket が先頭）
  }
  export interface Targets { targets: WaitTarget[]; boxTabs: number }
  export function readTargets(text: string): Targets; // JSON でない・tabs が配列でないときは throw
  ```

- [ ] **Step 1: 失敗する試験を書く**
  - `readTargets reads active host tabs`: `running`・`waiting`・`launching`・`cleanup_waiting` が入り、`launch_failed`・`closed` は入らない。`key === '/s/a.sock|w1:p1'`、`label === 'Epic #12'`。
  - `readTargets labels tabs`: `epics: [12, 13]` → `'Epic #12 #13'`、`epics: []`・`terminal: 'T1'` → `'terminal T1'`。
  - `readTargets skips box tabs`: `box` のあるタブは `targets` に無く、`boxTabs === 1`。
  - `readTargets collects cleanup sockets`: `previous: [{socket: '/s/old.sock'}, {pane: 'w1:p2'}]` → `cleanupSockets` が `['/s/a.sock', '/s/old.sock']`。
  - `readTargets skips tabs without socket or pane`: どちらかが無いタブは入れない。
  - `readTargets throws on broken JSON`: `assert.throws(() => readTargets('{'))`。
- [ ] **Step 2: 試験を流し、失敗を確かめる** — `npm test`。期待: 上の試験が FAIL（モジュールが無い）。
- [ ] **Step 3: `readTargets` を実装する。**
- [ ] **Step 4: 試験を流し、通ることを確かめる** — `npm test`。期待: PASS。
- [ ] **Step 5: コミット** — `git commit -m "feat(orchestrator-wait): 状態ファイルから見守りの対象を読む"`

### Task 2: herdr を読んで比べる

**Files:**
- Create: `src/orchestrator-wait/observe.ts`、`src/orchestrator-wait/diff.ts`
- Test: `test/orchestrator-wait-observe.test.ts`、`test/orchestrator-wait-diff.test.ts`

**Interfaces:**
- Consumes: `WaitTarget`（Task 1）。`Fleet`・`PaneSnapshot`（`src/watchdog/herdr-fleet.ts`）。
- Produces:
  ```ts
  // observe.ts
  export interface TabObs {
    gone: boolean;                    // socket が sockets() に無い / pane が無い / pane に agent がいない
    bodies: Record<string, string>;   // 本体の paneId → agent_status（記録した pane と工程のタブの pane）
    working: boolean;                 // cleanupSockets のどこかに status 'working' の pane がある
  }
  export interface Observation { tabs: Map<string, TabObs>; errors: string[] }
  export function stageTabPattern(epics: number[]): RegExp | undefined; // epics が空なら undefined
  export async function observe(targets: WaitTarget[], fleet: Pick<Fleet, 'sockets' | 'panes'>): Promise<Observation>;
  // diff.ts
  export function diffTab(t: WaitTarget, prev: TabObs | undefined, cur: TabObs): string[]; // 出力する行
  ```
- 判定（`diffTab`）:
  - `prev` が無い（新しいタブ）: `cur.gone` なら `"<label> pane <pane> gone"`。本体に `blocked` があれば `"<label> <paneId> new->blocked"`。それ以外は行なし。
  - `gone` が false→true: `"<label> pane <pane> gone"`（このときは他の行を出さない）。
  - 本体の pane ごとに、前の状態 `p`（無ければ `new`）から今の状態 `c` へ:
    - `c === 'blocked'` かつ `p !== 'blocked'` → `"<label> <paneId> <p>->blocked"`
    - `c` が `idle`/`done` かつ `p` が `idle`/`done` でない → `"<label> <paneId> <p>-><c>"`
  - 前にあって今は無い本体の pane（工程のタブが消えた）→ `"<label> <paneId> gone"`
  - `status === 'cleanup_waiting'` かつ `prev.working && !cur.working` → `"<label> cleanup: no working agent"`
  - 例: `Epic #12 w1:p1 working->blocked`

- [ ] **Step 1: 失敗する試験を書く**（偽の fleet は `test/watchdog-run.test.ts` の `FakeFleet` に倣う）
  - observe: `observe marks gone when socket missing`、`observe marks gone when pane has no agent`、`observe collects stage tab bodies`（`tabLabel: 'design-e12-r1'` は本体、`impl-mgr-f40` は本体でない）。
  - observe: `observe keeps sessions apart`: 2つの socket に `w1:p1`。一方だけ `blocked` なら、もう一方のタブの `bodies` は `blocked` にならない。
  - observe: `observe does not report gone when session list fails`: `sockets()` が throw すると `tabs.size === 0`、`errors.length === 1`。1つの socket の `panes()` だけ throw したら、そのタブだけ無く、`errors` に1件。
  - observe: `stageTabPattern` は `[12, 13]` で `spec-e13` に合い、`spec-e130` に合わない。`[]` で `undefined`。
  - observe: `observe sets working across cleanup sockets`: `previous` の socket に `working` があれば `true`。
  - diff: 上の判定を1つずつ（`blocked`、`idle`、`done`、`idle->done` は行なし、`blocked` のままは行なし、新しいタブ（`blocked` は行あり・`working` は行なし）、`gone`、工程のタブが消えた、cleanup）。
- [ ] **Step 2: 試験を流し、失敗を確かめる** — `npm test`。期待: FAIL。
- [ ] **Step 3: `observe`・`stageTabPattern`・`diffTab` を実装する。** `sockets()` は1回の確認につき1回だけ呼ぶ。`panes()` は socket ごとに1回。
- [ ] **Step 4: 試験を流し、通ることを確かめる** — `npm test`。期待: PASS。
- [ ] **Step 5: コミット** — `git commit -m "feat(orchestrator-wait): herdr の状態をタブごとに読んで比べる"`

### Task 3: 待つループ・記録・コマンド

**Files:**
- Create: `src/orchestrator-wait/run.ts`、`src/orchestrator-wait/main.ts`、`bin/scaffold-orchestrator-wait`
- Modify: `package.json`（`bin` と `files` に `bin/scaffold-orchestrator-wait`、`version` を `0.11.0`）、`README.md`（「scaffold-watchdog」の節の後に「scaffold-orchestrator-wait」の節）
- Test: `test/orchestrator-wait-run.test.ts`、`test/orchestrator-wait-bin.test.ts`

**Interfaces:**
- Consumes: `readTargets`（Task 1）、`observe`・`diffTab`・`TabObs`（Task 2）、`createHerdrFleet`。
- Produces:
  ```ts
  // run.ts
  export interface WaitDeps {
    statePath: string; recordPath: string;
    fleet: Pick<Fleet, 'sockets' | 'panes'>;
    now(): number; sleep(ms: number): Promise<void>;
    intervalMs: number; maxWaitMs: number;
  }
  export type WaitResult = {kind: 'changes'; lines: string[]} | {kind: 'timeout'; errors: string[]};
  export async function waitForChange(deps: WaitDeps): Promise<WaitResult>;
  // main.ts
  export async function main(argv: string[], env: NodeJS.ProcessEnv, out?: (s: string) => void, err?: (s: string) => void): Promise<number>;
  ```
- 動き（`waitForChange`）:
  1. 状態ファイルを読む。最初に読めなければ throw。2回目以降に読めなければ前回の対象のまま続け、`errors` に足す。
  2. 記録 `{"version": 1, "tabs": {<key>: TabObs}}` を読む。無い・壊れているときは空の記録にする。
  3. 確認のたびに `observe` → 観測できたタブごとに `diffTab(記録, 今)` → 記録を今に更新する。対象から外れたタブの記録は捨てる。観測できなかったタブの記録は残す。
  4. 行が出たら記録を書いて `changes` を返す。`now() - 開始 >= maxWaitMs` なら記録を書いて `timeout` を返す（`errors` は重複を除く）。それ以外は `sleep(intervalMs)`。
- `main`: `scaffold-orchestrator-wait <状態ファイル>`。`recordPath = <状態ファイル>.wait.json`。環境変数 `SCAFFOLD_ORCH_WAIT_HERDR`（既定 `herdr`）、`SCAFFOLD_ORCH_WAIT_INTERVAL_MS`（既定 `5000`）、`SCAFFOLD_ORCH_WAIT_MAX_MS`（既定 `300000`）。`changes` は1行ずつ標準出力へ。`timeout` は `timeout`、`errors` があれば `timeout (errors: <;区切り>)`。どちらも 0。引数なし・最初の読み取りの失敗は標準エラーに理由を書いて 2。
- `bin/scaffold-orchestrator-wait`: `bin/scaffold-watchdog` と同じ形（`../dist/src/orchestrator-wait/main.js` の `main` を呼ぶ）。

- [ ] **Step 1: 失敗する試験を書く**（偽の fleet・時計・sleep。sleep は時計を `intervalMs` 進める）
  - `waitForChange returns on blocked`: 3回目の確認で本体が `working→blocked` → `{kind: 'changes', lines: ['Epic #12 w1:p1 working->blocked']}`。
  - `waitForChange times out after maxWaitMs`: 変化なしで `maxWaitMs: 300000`、`intervalMs: 5000` → `timeout`。確認の回数は 61 前後（`>= 60`）。
  - `waitForChange does not wake twice for the same state`: 1回目は `blocked` で返る。同じ記録のまま2回目を呼ぶと `timeout`。
  - `waitForChange picks up changes between calls`: 記録に `working`、呼んだ時点で `idle` → 最初の確認で返る。
  - `waitForChange survives a half-written state file`（Review Focus 1）: 2回目の確認で状態ファイルを `'{"tabs": ['` に書き換えても落ちない。時間切れで `errors` に1件。
  - `waitForChange treats a broken record as empty`（Review Focus 5）: 記録ファイルが `'nope'` でも落ちない。新しいタブとして扱う。
  - `waitForChange drops records of removed tabs`: 状態ファイルから消えたタブのキーが、書いた記録に無い。
  - `waitForChange never writes the state file`: 終わった後、状態ファイルの中身が呼ぶ前と同じ。
  - bin（`test/orchestrator-wait-bin.test.ts`）: 一時ディレクトリに偽の `herdr`（引数に応じて `session list --json`・`pane list`・`tab list` の JSON を出す sh）を作る。`node bin/scaffold-orchestrator-wait <state>` を `SCAFFOLD_ORCH_WAIT_HERDR=<偽>`・`INTERVAL_MS=20`・`MAX_MS=200` で流す。変化なしなら標準出力が `timeout\n` で終了コード 0。pane が `blocked` なら1行で 0。引数なしなら 2。
- [ ] **Step 2: 試験を流し、失敗を確かめる** — `npm test`。期待: FAIL。
- [ ] **Step 3: `waitForChange`・`main`・bin を実装する。** `package.json` と README を直す。README には、使い方、環境変数3つ、起こす変化（設計書 3.2）、読むのは herdr だけであることを書く。
- [ ] **Step 4: 全試験と型を確かめる** — `npm run typecheck && npm test`。期待: エラーなし、全 PASS。
- [ ] **Step 5: 実物の herdr で1回だけ確かめる** — 一時ファイルの状態ファイルに、今の自分の pane（`herdr pane list` の socket は `herdr session list --json` で引く）を `running` のタブとして書き、`SCAFFOLD_ORCH_WAIT_MAX_MS=15000 node bin/scaffold-orchestrator-wait <tmp>` を流す。期待: 15秒で `timeout`、または自分の状態の変化の行が出て、終了コード 0。一時ファイルは消す。
- [ ] **Step 6: コミット** — `git commit -m "feat: scaffold-orchestrator-wait（herdr の変化で orchestrator を起こす待ち）"`

### Task 4: 版のスナップショットを作る

**Files:**
- 作るもの: `deterministic-scaffold-<commit8>.tgz`（リポジトリの外の一時ディレクトリ）

- [ ] **Step 1: スナップショットを作る** — Task 3 のコミット `<C>` を `git archive <C>` で一時ディレクトリへ取り出し、`npm ci --ignore-scripts` → `npm pack`。成果物を `deterministic-scaffold-<C の先頭8桁>.tgz` にし、`shasum -a 256` を控える。期待: tarball に `bin/scaffold-orchestrator-wait` と `dist/src/orchestrator-wait/main.js` が入っている（`tar tzf … | grep orchestrator-wait`）。
- [ ] **Step 2: pi の導入先に置く（実行前に利用者に確認する。動いている pi の Profile に関わるため）** — `~/.pi/local-packages/deterministic-scaffold/<C>` へ展開する。`pi-profile packages add --profile developer <そのパス> --replace`、`pi-profile packages install --profile developer` を行う（deterministic-scaffold の README「導入」の手順どおり）。期待: `<パス>/bin/scaffold-orchestrator-wait` が実行できる。

### Task 5: claude-scaffold に新しい版を入れ、コマンドの場所を渡す

**Files:**
- Modify: `vendor/`（新しい tgz を足し、古い `deterministic-scaffold-7b0a030e.tgz` を消す）、`vendor/README.md`、`package.json`（`deterministic-scaffold` を新しい tgz に）、`package-lock.json`、`bin/claude-dev`（91行目の後に1行）
- Test: `test/claude-dev-env.test.ts`

**Interfaces:**
- Produces: Claude の orchestrator の環境変数 `CLAUDE_SCAFFOLD_ORCHESTRATOR_WAIT`（`"$ROOT/node_modules/deterministic-scaffold/bin/scaffold-orchestrator-wait"`）。

- [ ] **Step 1: 失敗する試験を書く** — `test/claude-dev-env.test.ts` の、既存の `CLAUDE_SCAFFOLD_PROFILE_INSTRUCTIONS` の確かめ方に倣う。`CLAUDE_SCAFFOLD_ORCHESTRATOR_WAIT` が `<ROOT>/node_modules/deterministic-scaffold/bin/scaffold-orchestrator-wait` であること。
- [ ] **Step 2: 試験を流し、失敗を確かめる** — `npm test`。期待: FAIL。
- [ ] **Step 3: 実装する** — `bin/claude-dev` に `export CLAUDE_SCAFFOLD_ORCHESTRATOR_WAIT="$ROOT/node_modules/deterministic-scaffold/bin/scaffold-orchestrator-wait"` を足す。vendor と `package.json` を差し替えて `npm install`。`vendor/README.md` の表の行を、元の commit・SHA-256・日付（2026-11-11）で書き換える。
- [ ] **Step 4: 試験と型を確かめる** — `npm run typecheck && npm test`、`test -x node_modules/deterministic-scaffold/bin/scaffold-orchestrator-wait`。期待: 全 PASS、存在する。
- [ ] **Step 5: コミット** — `git commit -m "feat: deterministic-scaffold 0.11.0 と scaffold-orchestrator-wait の場所を渡す"`

### Task 6: scaffold-profiles のスキルの待ち方を替える

**Files:**
- Modify: `vendor/`（新しい tgz、古い tgz を消す）、`vendor/README.md`、`package.json`・`package-lock.json`、`config/versions.yml`（`deterministic-scaffold: 0.11.0` と `deterministic-scaffold-source`）、`config/vars.claude.yml`・`config/vars.pi.yml`（`orch.wait`）、`src/profile/skills/scaffold-orchestrator/SKILL.md`（「7. 見守る」の待ち方の2つのブロックと間隔の行）、`dist/`（生成）
- Test: `test/output.test.ts`

**Interfaces:**
- Consumes: `CLAUDE_SCAFFOLD_ORCHESTRATOR_WAIT`（Task 5）、`~/.pi/local-packages/deterministic-scaffold/<C>`（Task 4）。
- Produces: 変数 `orch.wait`。Claude は `"$CLAUDE_SCAFFOLD_ORCHESTRATOR_WAIT"`、pi は `~/.pi/local-packages/deterministic-scaffold/<C>/bin/scaffold-orchestrator-wait`。

- [ ] **Step 1: 失敗する試験を書く**（`test/output.test.ts`）
  - `scaffold-orchestrator は待ちコマンドで待つ`: 両方の道具・全プロファイルの dist の SKILL.md に、`scaffold-orchestrator-wait`（pi）または `$CLAUDE_SCAFFOLD_ORCHESTRATOR_WAIT`（Claude）があり、戻り先の `sleep 300` も残る。
  - `pi の orch.wait は versions.yml の取得元を指す`: `vars.pi.yml` の `orch.wait` が `deterministic-scaffold-source` + `/bin/scaffold-orchestrator-wait`。
- [ ] **Step 2: 試験を流し、失敗を確かめる** — `npm test`。期待: FAIL。
- [ ] **Step 3: SKILL.md を書き換える** — 「7. 見守る」の次の行を書き換える。
  - 間隔の行: 「見守りの待ちは、herdr の変化があればすぐ、なければ5分で終わる（仮置き）。」
  - Claude ブロック: 「待ち方：Bash で `{{orch.wait}} '<状態ファイル>'` を `run_in_background` で実行してターンを終え、終わった知らせで起きる。出力の行の件を先に読み、そのあと今までどおり全件を読む。`timeout` の行のときも全件を読む。コマンドが見つからない・0以外で終わったときは、`sleep 300` を `run_in_background` で実行する待ち方に戻し、そのことを会話に書く。前景で `sleep` や確認の繰り返しを回さない。」
  - pi ブロック: 同じ内容で「bash で `{{orch.wait}} '<状態ファイル>'` を1回実行してから次の確認をする」。bash ツールの timeout は付けない（付けるなら 600 秒以上）。
  - 「2. 仕様策定を先に進める」は「7. 見守る と同じ間隔」のままでよい（変えない）。
- [ ] **Step 4: 版を上げて生成する** — vendor・`package.json`・`versions.yml`・vars を直し、`npm install`、`npm run generate`。
- [ ] **Step 5: 確かめる** — `npm run check && npm run typecheck && npm test`。期待: 全 PASS、`--check` は差分なし。
- [ ] **Step 6: コミット** — `git commit -m "feat(scaffold-orchestrator): 見守りを scaffold-orchestrator-wait で待つ"`（pre-commit が generate --check と test を流す）
- [ ] **Step 7: push の関門を確かめる** — push 時に skill-eval の関門（agent-skill-evals-lab、O01〜O04 は偽の bash）が走る。落ちたら、原因が「偽の bash が新しいコマンドを知らない」か読む。lab 側を直す必要があれば、作業を止めて利用者に確かめる（別リポジトリのため）。

### Task 7: 実機で通す（実行前に利用者に確認する）

- [ ] **Step 1: 入れ直す** — scaffold-profiles の dist を Claude・pi の Profile に反映する（scaffold-profiles README の手順。`bin/install-config.sh --check` で確かめる）。
- [ ] **Step 2: scaffold-e2e-sandbox で通す** — Claude 版・pi 版それぞれ1回、Epic 1件以上で scaffold-orchestrator を回す。期待: 本体が `blocked`・`idle` になってから10秒以内に orchestrator が起きる。変化がない間は約5分ごとに起きる。`<状態ファイル>.wait.json` ができる。状態ファイルが壊れない。
- [ ] **Step 3: マージ** — 3つのリポジトリそれぞれで `git fetch origin main && git merge origin/main`、試験を通してから、main worktree で `git merge --no-ff feat/orchestrator-wait`。Task 4 のスナップショットが main の内容と違えば、作り直して Task 5・6 の vendor を差し替える（vendor/README の「main へ入れたら、内容が違えば作り直す」）。
