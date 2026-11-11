# scaffold-orchestrator の待ち（orchestrator-wait）設計

- 作成日: 2026-11-11
- 目的: scaffold-orchestrator の見守りを、5分ごとより細かく（数秒）するのに、orchestrator（LLM）の文脈を見守りで使い果たさないようにする。細かい確認は LLM を使わないコマンドが受け持ち、orchestrator が行動すべき変化があったときだけ orchestrator を起こす。

## 1. 背景

今の scaffold-orchestrator（scaffold-profiles `src/profile/skills/scaffold-orchestrator/SKILL.md` の「7. 見守る」）は、`sleep 300` で待ってから、毎回 LLM が herdr と GitHub を読んで判断する。間隔を30秒や5秒に縮めると、確認のたびに LLM のターンが動き、orchestrator の文脈が見守りだけで埋まる（30秒なら1時間に120回）。

一方、手順書で orchestrator が行動するのは、決まった少数の変化のときだけである。manager・coder・tester の状態の変化やエラーは、scaffold の親が捌くもので orchestrator は何もしない。この「行動すべき変化か」は、herdr の状態から機械的に見分けられる。

前例として、同じパッケージの `scaffold-watchdog`（`src/watchdog/`）が、LLM なしで全 herdr セッションを読んでいる。

## 2. ねらい・ねらわないこと

**ねらい**
- herdr に出る変化（本体の入力待ち・idle/done・いなくなった）に、orchestrator が数秒で反応する。
- 見守りの時間が延びても、orchestrator の文脈が増えるのは「起きた回数」の分だけにする。
- どんな場合も、今の5分見守りより遅くならない。
- Claude 版・pi 版の両方で、今の「待つコマンドが終わったら起きる」作りのまま使える。

**ねらわないこと**
- 人への通知の改善（herdr-focus-notify の重複や、Epic 名が出ないことなど）。
- GitHub の読み取り。Epic の open/closed、印、blocked by は、今までどおり orchestrator が起きたときに deterministic-gh で読む（利用者の決定）。
- 箱（kec-orb）で回しているタブの細かい見守り。最初の版はホストのタブだけ（3.6）。
- orchestrator の判断（画面を読む、通知する、起動する、片付ける、状態ファイルを書く、60分の「長く動きがない」の判定）の置き換え。

**失敗とみなすこと（動いても駄目なもの）**
- 今の5分見守りより反応が遅くなる。
- 同じ状態のままで何度もすぐ起こし、orchestrator が実質ずっと回り続ける。
- pane に入力する、GitHub を読む・書く、状態ファイルを書き換えるなど、herdr を読む以外のこと（自分の記録ファイルを書くことは除く）。

## 3. 決めたこと

| 論点 | 決定 | 理由 |
|---|---|---|
| 置き場所 | **deterministic-scaffold（このリポジトリ）に新しい bin を足す**（利用者の決定） | `scaffold-watchdog` の herdr の読み方と試験を使い回せる |
| 呼び方 | orchestrator が `sleep 300` の代わりにこのコマンドを呼び、終わったら起きる | Claude（Bash の `run_in_background`）・pi（bash を1回）の待ち方を変えずに済む |
| 名前 | 仮に `scaffold-orchestrator-wait`（私の判断。変えてよい） | |
| 読むもの | **herdr だけ**（利用者の決定） | scaffold の Profile ではエージェントの `gh` 直叩きが禁じられている。Epic が閉じるときは、検証工程の親が herdr 上で done/idle になり工程のタブを片付けるので、herdr の変化で起こせば足りる |
| 読む間隔 | **5秒**（私の判断。利用者は「特に決めていない」） | herdr はローカルで軽い |
| 最長の待ち | **常に5分で終える**（変化がなくても）（私の判断） | 一覧に無い出来事（人が GitHub で Epic を閉じた、blocked by を手で外した、片付けの30分の期限、仕様策定中の Epic の起票など）を、今と同じ5分以内に orchestrator が拾うため |
| 書き込み | **状態ファイルには書かない。自分の記録は別ファイル** | 状態ファイルの書き手は orchestrator だけにし、競合を避ける |
| 箱のタブ | **最初の版は読まない**（利用者の決定） | `kec-orb ssh` 越しの読み取りで作りが1段増える。次の段階で足す |

### 3.1 入力

- 引数で状態ファイルのパスを受け取る（`~/.local/state/scaffold-orchestrator/<名前>-<ハッシュ>.json`。形はスキルの「状態ファイル」の節）。
- 読むのは `tabs[]` の `status`・`socket`・`pane`・`agent`・`epics`・`previous`・`box`。
- 対象のタブは、`status` が `launching`・`running`・`waiting`・`cleanup_waiting` のもの。`launch_failed`・`closed` は読まない。`box` のあるタブは 3.6。

### 3.2 起こす変化

起こすのは次の変化だけである。どれも、そのタブの「前回の記録」（3.3）と比べて変わったときに起こす。

1. **本体の入力待ち**: タブの scaffold 本体の agent が `blocked` になった。本体は、タブの `pane` の agent と、同じセッションの工程の引き継ぎのタブ（`herdr tab list` の `label` が `^(spec|design|impl|verify|setup)-e<N>(-r[0-9]+)?(-[0-9a-f]{4})?$`、`<N>` はタブの `epics` のどれか）の agent。
2. **本体が `idle`/`done` になった**: 仕様策定済み・計画待ちか、Epic が閉じたかは、起きた orchestrator が画面と deterministic-gh で確かめる。
3. **いなくなった**: 記録した `socket` のセッションが無い、`pane` が無い、`pane` に agent がいない、本体のいた工程のタブが消えた。
4. **片付けが進んだ**: `cleanup_waiting` のタブで、記録した全セッション（今の `socket` と `previous` の `socket`）から `working` の agent がいなくなった。

manager のタブ（`^(impl|verify)-mgr-f[0-9]+(-[0-9a-f]{4})?$`）の agent と、上のどれにも当たらない agent の状態の変化では、起こさない。

### 3.3 比べる相手（同じ状態で何度も起こさないため）

- 変化は、このコマンドが自分で持つ「前回の記録」と比べて決める。記録は状態ファイルの隣の別ファイル（例：`<状態ファイル>.wait.json`）に置き、タブ（`socket` と `pane` の組）ごとに、3.2 の判定に使う状態を持つ。
- コマンドは始めに今の状態を読み、記録と比べる。前回の呼び出しが終わってから今回が始まるまで（orchestrator が起きている間）に起きた変化も、ここで拾う。
- 状態ファイルが書き換わっても、記録を丸ごと作り直さない。対象から外れたタブの記録は捨てる。新しく加わったタブ（記録の無いタブ）は、最初の状態が `blocked` かいない状態なら、すぐ起こす。それ以外なら、その状態を記録にして待つ。
- 起こすとき・5分で終えるときは、そのときの状態を記録に書いてから終える。
- これで、`idle` のまま・`blocked` のままの状態が続いても、2回目以降はすぐには起こさない（5分ごとには起きる）。

### 3.4 出力と終わり方

- 起こすとき: 標準出力に、変化1件を1行で書く。例: `Epic #12 orch-12 working->blocked`、`Epic #12 pane w1:p1 gone`、`Epic #12 cleanup: no working agent`。同時に起きた変化は全部書く。Epic の無いタブは、Epic の代わりに端末 ID か要望を書く。最後に機械向けの JSON を1行付けてよい（作り手に任せる）。
- 5分で終えるとき: `timeout` の1行。
- 終了コード: 変化あり・時間切れはどちらも0。状態ファイルが読めないなど、続けられないときは0以外にし、理由を標準エラーに書く。
- herdr の一時的な読み取りの失敗では終えない（スキルの「下位の一時的なエラーでは見守りを終えない」に合わせる）。次の間隔で読み直す。失敗が続いても、5分の時間切れで orchestrator が起き、自分で読み直す（私の判断）。失敗したことは `timeout` の行に添える。

### 3.5 読み方

- `scaffold-watchdog` と同じく、固定の argv で herdr の CLI を呼ぶ（シェルを通さない）。セッションごとに `HERDR_SOCKET_PATH=<socket>` で agent・pane・tab の一覧を読む。`src/watchdog/herdr-fleet.ts` の解析を使い回せるなら使う。
- herdr の場所と時計は差し替えられるようにする（`scaffold-watchdog` の `SCAFFOLD_WATCHDOG_HERDR` と同じ考え方）。試験で偽物を入れるため。

### 3.6 箱のタブ

- `box` のあるタブは、最初の版では読まない。最長の待ちは5分なので、箱のタブは今までどおり orchestrator が5分ごとに読む。

### 3.7 スキル側（scaffold-profiles）の変更

- 「7. 見守る」の待ち方を、`sleep 300` からこのコマンドに替える（Claude 版・pi 版の両方）。起きたら、今までどおり全件を読む。ただし、出力に出た件を先に扱う。
- 「2. 仕様策定を先に進める」の見守りも同じ待ち方にする。
- 判断の規則（知らせる状態、`lastState`・`lastSnapshot`・`lastChange`、60分）は変えない。
- コマンドが無い・0以外で終わったときは、`sleep 300` に戻して見守りを続け、そのことを会話に書く。
- コマンドの入手先：pi 版は scaffold-profiles の `config/versions.yml` の `deterministic-scaffold-source`（`~/.pi/local-packages/deterministic-scaffold/<commit>`）。Claude 版は claude-scaffold（`~/Documents/GitHub/claude-scaffold`）が npm の依存として持つ deterministic-scaffold。両方の版の固定を上げる作業と、スキル変更の関門（policy・評価 O01〜O04）への影響は、計画で扱う。

## 4. 作り手に任せること

- ファイルの分け方、型、`scaffold-watchdog` とどこまで部品を共有するか。
- 前回の記録の形。
- 出力の細かい書式（3.4 の例の意味が保たれていればよい）。
- スキルからコマンドを呼ぶときのパスの決め方（scaffold-profiles・claude-scaffold の既存の仕組みに合わせる）。

## 5. 試験

- 合成した状態ファイルと、偽の herdr・時計で次を確かめる。
  - 3.2 の各変化で起きる。
  - manager の状態の変化では起きない。
  - 同じ状態が続いても、2回目はすぐには起きない。
  - 5分で `timeout` になる。
  - 一時的な失敗では途中で終わらない。
  - 新しく加わったタブが `blocked` なら、すぐ起きる。
  - 箱のタブは読まない。
- 実際の GitHub には触れない（そもそも読まない）。
- 実機の確認は scaffold-e2e-sandbox で、Claude 版・pi 版それぞれ1回、Epic 1件以上を通す（計画で詳しく決める）。

## 6. 決定ログ

- 2026-11-11 builder check を受けて改訂: 最長の待ちを15分から5分に。コマンド側の「60分動きがない」を削除（orchestrator の `lastChange` 判定に一本化）。比べる相手をタブごとにし、状態ファイルの書き換えで作り直さない。GitHub を読まない（利用者の決定）。
