# orchestrator-wait を scaffold-manager に対応させる 設計

- 作成日: 2026-11-18
- 目的: Epic ごとに箱の中へ scaffold-manager を1人置く運用で、orchestrator は manager だけを見て、manager は工程のタブと watchdog のログを見て自分を起こせるようにする。
- 前の設計: `2026-11-11-orchestrator-wait-design.md`、`2026-11-15-orchestrator-wait-box-design.md`

## 1. 背景（2026-11-18 決定）

- manager は scaffold と同じ herdr セッションの長く動くタブ `mgr-e<Epic番号>`（同名があれば `-<4桁16進>`）で動き、工程のタブ（`(setup|spec|design|impl|verify)-e<N>(-r[0-9]+)?(-[0-9a-f]{4})?`）を見守り、人・orchestrator へ知らせ、要約ファイルを書く。
- 止まった工程への「続けて」と起こし直しは、今までどおり scaffold-watchdog が行う。この変更で watchdog（`src/watchdog/`）と handoff は変えない。
- manager のスキル本文・起動手順は別の作業（scaffold-profiles）。この変更は待ちのコマンドだけ。

## 2. 決めたこと

| 論点 | 決定 | 理由・補足 |
|---|---|---|
| orchestrator の見る相手 | label の全体が `^mgr-e<N>(-[0-9a-f]{4})?$`（`<N>` はそのタブの `epics`）で agent のいるタブがあれば、そのタブの本体は manager の agent だけ | 工程の変化は manager が捌く。manager が無い Epic は今までどおり |
| manager がいなくなった | manager のタブ・agent が消えたら、`Epic #N <pane> gone` の1行で起こす | 「いなくなった」と同じ扱い。そのとき工程のタブの変化は、同じ読みでは報告しない（次の読みから、元の見方で比べる） |
| manager が現れた | それまで記録した工程の pane を「消えた」と報告しない | 本体の集合が入れ替わるだけのため |
| 片付け待ち | `working` の判定は今までどおり全 pane | manager の有無で片付けの判断を変えない |
| manager のモード | `--manager <要約ファイル>`。要約は `epic`（整数）と `repo`（`owner/name`）を持つ JSON（読むだけ）。記録は `<要約ファイル>.wait.json` | 状態ファイルと同じ考え方 |
| 見る相手（manager のモード） | 自分のセッション（`HERDR_SOCKET_PATH`、無ければ既定）の工程のタブ（`<N>` は要約の `epic`）の agent。自分の pane（`HERDR_PANE_ID`）は見ない | 自分の working/idle で起きて空回りしない |
| 起こす変化 | 通常のモードと同じ。固定の本体が無いので、「記録の無い新しいタブがいない」の判定は無い（工程のタブが1つも無いだけでは起こさない） | |
| watchdog のログ | `SCAFFOLD_ORCH_WAIT_WATCHDOG_LOG`、無ければ箱の `/home/dev/work/.kec-orb/logs/scaffold-watchdog.log`（あれば）、無ければ `~/.local/state/scaffold-watchdog.log`。`repo`・`epic` が一致し `event` が `prompted`・`awaiting-human`・`stage-exhausted`・`missing`・`blocked`・`retired` の新しい行で、`watchdog <event> <stage>` を出して起こす | |
| 読み位置 | バイトの位置ではなく、処理済みの最新の `at` と、その `at` で処理済みの行（同じ行の重複は数で数える）を記録に持つ | 回転で位置が戻っても、同じ行で二度起こさない。最初の読みの既存の行は「前回」に入れて起こさない |
| ログが読めない | 起こさず、`timeout (errors: watchdog log: …)` に添える | |
| 読む量 | ログの末尾 1 MiB | 回転は長大なログを作らない前提 |
| 出力・終了コード・時間・間隔 | 今までと同じ（`SCAFFOLD_ORCH_WAIT_MAX_MS`・`SCAFFOLD_ORCH_WAIT_INTERVAL_MS`）。引数が合わない・要約が読めない・形が違うときは終了コード2 | |

## 3. 実装

- `observe.ts`: `managerTabPattern`、`observeStages`（manager のモード）。`TabObs.manager` を足す（古い記録は欄が無いだけで読める）。
- `diff.ts`: manager の出入りの扱いを先頭に足す。
- `watchdog-log.ts`: ログの解析と読み位置（`scanWatchdogLog`）。
- `run.ts`: `waitForManagerChange`。記録の形は version 1 のまま、`watchdog` 欄を足す。
- `main.ts`: `--manager` の引数、ログの場所の決め方。

## 4. 検証

- `test/orchestrator-wait-manager.test.ts`（manager のタブあり・なし、manager のモード、ログの一致・不一致・回転、読めないログ）と `orchestrator-wait-bin.test.ts`。manager のタブなしは、今までのテストがそのまま通る。
- 前提と限界: ログの `at` は watchdog の時計、読む側は比べるだけで時計を使わない。同じミリ秒の別の行は、中身が違えば別の行として扱う。
