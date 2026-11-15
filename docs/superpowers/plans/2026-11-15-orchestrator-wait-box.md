# orchestrator-wait 箱のタブ対応 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Context

箱（kec-orb）で回す Epic は、待ちコマンド `scaffold-orchestrator-wait` が読まない（`targets.ts` が `box` のタブを飛ばす）。そのため orchestrator は5分の timeout でしか気づけない。待ちコマンドが `kec-orb ssh <箱> …` で箱の中の herdr を読み、ホストと同じ規則・5秒で起こすようにする。Claude 版（claude-scaffold）・pi 版（scaffold-profiles）の両方へ届ける（利用者の依頼）。

**Goal:** 箱のタブの本体の blocked・idle/done・いなくなった・片付けの進みで、5秒の間隔で orchestrator を起こす。

**Architecture:** `src/orchestrator-wait/` に箱の読み口 `box.ts` を足し、`targets` が箱のタブも対象にし、`observe` が箱ごとに ssh 1回で読んだ一覧に今の判定を当てる。`diff`・`run` の比べ方は変えない。新しい版を claude-scaffold と scaffold-profiles の vendor に入れ、スキルの文言を直す。

**Tech Stack:** TypeScript（NodeNext）、`node:test`、herdr CLI、kec-orb（bash）。

**Spec:** `docs/superpowers/specs/2026-11-15-orchestrator-wait-box-design.md`（pi-scaffold `867e7e0`）。前の設計 `2026-11-11-orchestrator-wait-design.md`、前の計画 `docs/superpowers/plans/2026-11-11-orchestrator-wait.md`（Task 4〜7 の届け方を今回も使う）。

**作業場所**
- deterministic-scaffold: worktree `~/.config/superpowers/worktrees/pi-scaffold/orchestrator-wait-box`（`feat/orchestrator-wait-box`、作成済み・試験 1091 PASS）
- claude-scaffold: `~/Documents/Github/claude-scaffold` に worktree `feat/orchestrator-wait-box` を作る
- scaffold-profiles: `~/Code/scaffold-profiles` に worktree `feat/orchestrator-wait-box` を作る
- この計画は Task 1 の前に `docs/superpowers/plans/2026-11-15-orchestrator-wait-box.md` として pi-scaffold の worktree にも置いてコミットする

## Global Constraints

- 間隔 `5000` ms・最長 `300000` ms は変えない。終了コードの意味も変えない。
- kec-orb は `execFile` の固定 argv `['ssh', <箱名>, BOX_READ]` で呼ぶ（シェルを通さない）。`BOX_READ` は固定の文字列。状態ファイルの値を箱の中のコマンドに入れない。
- 箱名は kec-orb の `check_name` と同じ規則だけ通す: `^[a-z0-9]([a-z0-9-]{0,39}[a-z0-9])?$` または `^sched-[a-z0-9-]{1,40}$`。
- kec-orb の場所: `SCAFFOLD_ORCH_WAIT_KEC_ORB`（既定 `kec-orb`）。時間切れ `15000` ms。渡す環境は今の `execHerdr` と同じ（PATH・HOME・LANG。kec-orb は `$HOME/.local/state/kec-orb` と PATH の ssh だけを使う）。
- 箱の中の herdr は既定の socket（`HERDR_SOCKET_PATH` を付けない）。
- ssh 255・herdr の失敗・解析できない出力 → その回の errors、そのタブは記録を更新せず飛ばす（gone にしない、起こさない）。
- 箱のタブの記録キー `box:<箱名>|<pane>`、ラベル `Epic #12 box <箱名>`（Epic なしは `terminal <id> box <箱名>`）。
- 読むのは herdr（ホスト）と `kec-orb ssh`（箱）だけ。箱の起動・停止・pane への入力・状態ファイルへの書き込みはしない。箱の中（image・箱の中の claude-scaffold・pi）は変えない。
- コミットに AI の帰属行を付けない。

## Review Focus

1. 箱が止まっている（毎回 255）→ 5秒ごとに起きず、5分の `timeout (errors: kec-orb ssh <箱>: …)` が1件だけ出る（Task 3）。
2. ホストの仕様策定のタブから箱へ移った（同じタブで `box` と箱の `pane` が入る）→ 古いホストのキーは捨てられ、箱の本体が `idle` なら起きない、`blocked` ならすぐ起きる（Task 3）。
3. `box` はあるが `pane` が空（kec-orb start の途中）→ 読まず、errors も出さない（Task 1）。
4. ホストと箱で pane ID が同じ `w1:p1` → 混ざらない（Task 3）。
5. ssh が固まる → 15秒で打ち切り、その回は errors。ループは5分で終わる（Task 2）。

---

### Task 1: 箱のタブを対象にする（`targets.ts`）

**Files:** Modify `src/orchestrator-wait/targets.ts`、Test `test/orchestrator-wait-targets.test.ts`

**Interfaces:**
- Produces: `WaitTarget` に `box?: string` を足す。`Targets` を `{targets: WaitTarget[]; errors: string[]}` に替える（`boxTabs` は消す。使っているのは試験だけ）。`export const BOX_NAME: RegExp[]`（上の2つ）。
- 箱のタブ: `key = box:<箱名>|<pane>`、`socket` はタブの `socket`（無ければ `''`）、`cleanupSockets` は `[socket, ...previous の socket]` の空でないもの。

- [ ] Step 1: 試験を書く。`readTargets skips box tabs` を次に置き換える。
  - `readTargets reads box tabs`: `{status:'running', box:'web-e12-rust', pane:'w1:p1', socket:'/s/h.sock', epics:[12], previous:[{socket:'/s/p.sock'}]}` → `{key:'box:web-e12-rust|w1:p1', label:'Epic #12 box web-e12-rust', box:'web-e12-rust', cleanupSockets:['/s/h.sock','/s/p.sock'], …}`、errors `[]`。
  - `readTargets skips box tabs without pane`: `pane:''` → targets `[]`、errors `[]`。
  - `readTargets rejects bad box names`: `box:'a;rm -rf ~'`・`'-x'`・`'A'`・42文字 → targets `[]`、errors に `box name rejected: <名前>` が1件ずつ。`'sched-daily-1'` は通る。
- [ ] Step 2: `npm test` → FAIL。
- [ ] Step 3: 実装する。
- [ ] Step 4: `npm test` → PASS（既存の targets 試験は `.targets` を読むよう直す）。
- [ ] Step 5: commit `feat(orchestrator-wait): 箱のタブを対象にする`

### Task 2: 箱の読み口（`box.ts`）

**Files:** Create `src/orchestrator-wait/box.ts`、Test `test/orchestrator-wait-box.test.ts`

**Interfaces:**
- Consumes: `parsePaneList`（`src/watchdog/herdr-fleet.ts`）、`parseTabListStrict`（`src/orchestrator-wait/herdr.ts`）。
- Produces:
  - `export const BOX_SEP = '--- scaffold-orchestrator-wait tab list ---'`
  - `export const BOX_READ = \`herdr pane list && printf '\\n%s\\n' '${BOX_SEP}' && herdr tab list\``
  - `export type KecOrbRun = (args: string[]) => Promise<string>`
  - `export function execKecOrb(bin: string, timeoutMs: number): KecOrbRun`（`execHerdr` と同じ作り。失敗は `kec-orb ssh <箱> failed (exit <code>): <stderr 200字>`）
  - `export function createBoxReader(o: {run: KecOrbRun}): {boxPanes(box: string): Promise<PaneSnapshot[]>}`。`run(['ssh', box, BOX_READ])` の出力を `BOX_SEP` の行で2つに分け、`parsePaneList('box:'+box, …)` とラベル付け（`createStrictReader` と同じ）。区切りが無い・どちらかが読めない → throw。

- [ ] Step 1: 試験を書く。
  - `createBoxReader labels box panes`: 偽の run が pane 2つ＋区切り＋tab 一覧を返す → `tabLabel` が付き、`socket` が `box:web-e12-rust`。
  - `createBoxReader passes fixed argv`: run が受けた args が `['ssh','web-e12-rust',BOX_READ]`。
  - `createBoxReader throws without separator` / `on unreadable tab list`。
  - `execKecOrb reports exit 255`: 偽の kec-orb（`exit 255`）→ reject、メッセージに `255`。
  - `execKecOrb times out`: 偽の kec-orb（`sleep 5`）、`timeoutMs: 200` → reject。
- [ ] Step 2: `npm test` → FAIL。
- [ ] Step 3: 実装する。
- [ ] Step 4: `npm test` → PASS。
- [ ] Step 5: commit `feat(orchestrator-wait): kec-orb ssh で箱の herdr を読む`

### Task 3: 観測とつなぎ込み（`observe.ts`・`run.ts`・`main.ts`）、README、版 0.12.0

**Files:** Modify `src/orchestrator-wait/observe.ts`・`run.ts`・`main.ts`、`README.md`（「scaffold-orchestrator-wait」の節）、`package.json`（`version: 0.12.0`）、`test/orchestrator-wait-fakes.ts`。Test `test/orchestrator-wait-observe.test.ts`・`-run.test.ts`・`-bin.test.ts`

**Interfaces:**
- Consumes: Task 1 の `WaitTarget.box`・`Targets.errors`、Task 2 の `createBoxReader`・`execKecOrb`。
- Produces: `export type WaitFleet = Pick<Fleet,'sockets'|'panes'> & {boxPanes(box: string): Promise<PaneSnapshot[]>}`（`observe.ts`）。`observe(targets, fleet: WaitFleet)`。`WaitDeps.fleet: WaitFleet`。
- 判定（`observe`）: 箱は箱名ごとに1回、`Promise.all` で並べて読む。失敗 → errors `kec-orb ssh <箱>: <msg>`、その箱のタブは `tabs` に入れない。成功 → `gone = 記録の pane が無い || agent が無い`、`bodies` は今と同じ規則（記録の pane と工程のタブ）、`working = 箱の一覧に working がある || cleanupSockets（ホスト）に working がある`。ホストの `session list` が失敗したときは今と同じく全部返さない。
- `run`: `readTargets(...).errors` を errors に足す。`main`: `boxPanes` を `createBoxReader({run: execKecOrb(env.SCAFFOLD_ORCH_WAIT_KEC_ORB ?? 'kec-orb', 15_000)})` から足す。`FakeReader` に `boxPanesByName: Map`・`failBoxes: Set` を足す。

- [ ] Step 1: 試験を書く。
  - observe `box tab bodies and gone`: 箱の一覧に記録の pane（`blocked`）・`design-e12-r1`（`idle`）・`impl-mgr-f40`（`blocked`）→ bodies は前2つだけ。記録の pane が無い → `gone: true`。
  - observe `box read failure skips the tab`: `failBoxes` → `tabs` に無く、errors に `kec-orb ssh web-e12-rust:`。
  - observe `box tab working spans box and host`: 箱は working なし・ホストの `previous` socket に working → `working: true`。両方なし → `false`。
  - observe `host and box panes with the same id stay apart`（Review Focus 4）。
  - observe `reads each box once`: 同じ箱のタブ2つ → `boxPanes` 1回。
  - run `box blocked wakes`: → `['Epic #12 box web-e12-rust w1:p1 working->blocked']`。
  - run `box unreachable never wakes`（Review Focus 1）: 毎回失敗 → `{kind:'timeout', errors:['kec-orb ssh web-e12-rust: …']}`（1件）。
  - run `host tab moving to a box`（Review Focus 2）: 1回目ホストのタブで timeout → 状態ファイルを箱のタブに書き換え、箱の本体 `idle` → timeout。`blocked` → すぐ changes。
  - run `box cleanup wakes when no working anywhere`: `cleanup_waiting`、箱とホストの working が両方消えた回だけ `… cleanup: no working agent`。
  - bin `box tab via fake kec-orb`: 偽の `kec-orb`（`ssh` を受けて pane 一覧＋区切り＋tab 一覧を出す）を `SCAFFOLD_ORCH_WAIT_KEC_ORB` で渡す → `blocked` の1行で終了コード0。
- [ ] Step 2: `npm test` → FAIL。
- [ ] Step 3: 実装する。README の節に「箱のタブ（`box` のあるタブ）は `kec-orb ssh <箱> …` で箱の中の herdr を読む。つながらない間は起こさず timeout 行に添える。`SCAFFOLD_ORCH_WAIT_KEC_ORB`」を足し、targets のコメント（"Box tabs are … not watched"）を直す。
- [ ] Step 4: `npm run typecheck && npm test` → 全 PASS。
- [ ] Step 5: commit `feat(orchestrator-wait): 箱のタブも5秒ごとに見る（0.12.0）`

### Task 4: 版のスナップショット

- [ ] Step 1: 前の計画 Task 4 Step 1 と同じ（`git archive <C>` → `npm ci --ignore-scripts` → `npm pack`）。`deterministic-scaffold-<C8>.tgz` と SHA-256 を控える。`tar tzf … | grep orchestrator-wait/box.js` で入っていることを確かめる。
- [ ] Step 2（実行前に利用者に確認。動いている pi の Profile に関わる）: `~/.pi/local-packages/deterministic-scaffold/<C>` へ展開、`pi-profile packages add --profile developer <パス> --replace`、`pi-profile packages install --profile developer`。

### Task 5: claude-scaffold へ入れる（Claude 版）

**Files:** `vendor/`（新しい tgz を足し `deterministic-scaffold-bb9ab0dc.tgz` を消す）、`vendor/README.md`、`package.json`、`package-lock.json`。`bin/claude-dev` は変えない。

- [ ] Step 1: 差し替えて `npm install`。
- [ ] Step 2: `npm run typecheck && npm test`、`grep -q BOX_READ node_modules/deterministic-scaffold/dist/src/orchestrator-wait/box.js` → PASS・ある。
- [ ] Step 3: commit `chore: deterministic-scaffold 0.12.0（箱のタブも待つ）`

### Task 6: scaffold-profiles（pi 版の固定とスキルの文言）

**Files:** `vendor/`（`d7d5134c` を消し新しい tgz）、`vendor/README.md`、`package.json`・lock、`config/versions.yml`（`0.12.0`・source `<C>`）、`config/vars.pi.yml`（`orch.wait` のパス）、`src/profile/skills/scaffold-orchestrator/SKILL.md`、`dist/`（生成）。Test `test/output.test.ts`

- [ ] Step 1: 試験を書く: `scaffold-orchestrator の待ちは箱のタブも見る` — 両方の道具・全プロファイルの dist の SKILL.md の「7. 見守る」に「箱のタブ」と `kec-orb ssh` を含む待ちの説明があり、`sleep 300` の戻りと「255 …いなくなった」の規則が残る。
- [ ] Step 2: `npm test` → FAIL。
- [ ] Step 3: SKILL.md を直す。
  - 「7. 見守る」1つ目の箇条: 「待ちのコマンド `scaffold-orchestrator-wait` は herdr を読むだけで」→「…はホストの herdr と、箱のタブは `kec-orb ssh` で箱の中の herdr を読むだけで（箱へつながらない間は起こさず、`timeout` の行に添える）」。
  - 「箱で回すとき」の「見守る」に1行: 「待ちのコマンドも箱のタブを5秒ごとに読む。起きたあとの読み方・知らせ方はこの節のまま（255 で「いなくなった」と知らせるのは起きた orchestrator）。」
- [ ] Step 4: vendor・versions・vars を直し `npm install`、`npm run generate`。
- [ ] Step 5: `npm run check && npm run typecheck && npm test` → 全 PASS・差分なし。
- [ ] Step 6: commit `feat(scaffold-orchestrator): 待ちコマンドが箱のタブも見る（deterministic-scaffold 0.12.0）`
- [ ] Step 7: push の関門（skill-eval O01〜O04）を前の計画 Task 6 Step 7 と同じに扱う。lab 側の変更が要れば止めて利用者に確かめる。

### Task 7: 実機で通す・マージ（実行前に利用者に確認）

- [ ] Step 1: dist を Claude・pi の Profile に反映（`bin/install-config.sh --check`）。
- [ ] Step 2: scaffold-e2e-sandbox に箱の言語の表にある言語の小さい Epic を立て、`runIn: "box"` で計画承認まで進め、Claude 版1回（必須）・pi 版1回、箱で起動。
  - 合格: 箱の本体の `blocked` か `idle`/`done` から、待ちコマンドが行を出すまで10秒以内（仮置き）。秒数を記録する。変化がない間は約5分ごとに `timeout`。箱を `kec-orb stop` しても5秒ごとに起きない。
- [ ] Step 3: 3リポジトリとも `git fetch origin main && git merge origin/main`、試験を通し、main worktree で `git merge --no-ff feat/orchestrator-wait-box`。スナップショットが main と違えば作り直し、Task 5・6 の vendor を差し替える。

## 検証のまとめ

- 単体: pi-scaffold `npm run typecheck && npm test`（今の 1091 件＋新しい試験）、claude-scaffold `npm test`、scaffold-profiles `npm run check && npm test`。
- 実機: Task 7 Step 2（Claude 版必須）。

## 進め方

- 利用者の決定: このセッションで自分で実装（superpowers:executing-plans）し、最後に新しいレビュアー1人がブランチ全体を見る。
- Task 4 Step 2・Task 7 は実行前に利用者に確認する。

## 残る問い

- なし（実機の Epic の題材は sandbox で作り手が決める）。
