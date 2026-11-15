# scaffold-orchestrator の待ち（orchestrator-wait）で箱のタブも見る 設計

- 作成日: 2026-11-15
- 目的: 箱（kec-orb）で回している Epic の変化にも、ホストのタブと同じく数秒で orchestrator を起こす。今は箱のタブを待ちコマンドが読まないため、最長5分の見回りでしか気づけない。
- 前の設計: `2026-11-11-orchestrator-wait-design.md`（3.6 で「箱のタブは最初の版では読まない。次の段階で足す」とした、その次の段階）

## 1. 背景

- `scaffold-orchestrator-wait` は5秒ごとに herdr を読み、本体の `blocked`・`idle`/`done`・いなくなった・片付けで `working` がいなくなった、のどれかで1行出して終わる。何もなければ5分で `timeout`。
- `src/orchestrator-wait/targets.ts` は `box` のあるタブを数えるだけで飛ばす。箱のタブは、orchestrator が起きたとき（多くは5分の timeout）に `kec-orb ssh <箱名> herdr agent list` などで読んでいる。
- 箱のタブの状態ファイルの形（scaffold-profiles のスキル「箱で回すとき」）: `box` = 箱名、`pane` = 箱の中で scaffold 本体が動く pane（kec-orb start の出力の「pane <ID>」）、`agent` は空。`socket`・`session`・`terminal` はホストの仕様策定のタブのもの、`previous` にホストの仕様策定の pane と（あれば）その socket。
- 実測（2026-11-15、箱 `web-ui-gateway-nats-rust`）: `kec-orb ssh <箱> 'herdr pane list >/dev/null; herdr tab list >/dev/null'` が 0.10〜0.11 秒（5回）。

## 2. ねらい・ねらわないこと

**ねらい**
- 箱のタブでも、2026-11-11 設計の 3.2 の4つの変化（本体の入力待ち、本体が `idle`/`done`、いなくなった、片付けが進んだ）で、ホストと同じく5秒の間隔で起こす（利用者の決定:「ホストと全部同じ」）。
- Claude Code 版の scaffold（claude-scaffold の deterministic-scaffold）と pi 版の両方に効かせる（利用者の決定）。

**ねらわないこと**
- 箱へ ssh がつながらない（`kec-orb ssh` の終了コード255）ことで、すぐ起こすこと（利用者は選ばなかった）。つながらない間は読み取りの失敗として扱い、5分の timeout で orchestrator が自分で読んで「いなくなった」と知らせる（今のスキルの規則のまま）。
- ssh の接続の使い回し（ControlMaster）、箱の中に見張りを置くこと（利用者が A を選んだ）。
- orchestrator の判断・知らせ方・状態ファイルの形の変更。

**失敗とみなすこと**
- 箱のタブで、今の5分より反応が遅くなる、またはホストのタブの反応が遅くなる。
- 箱が止まっている・つながらない状態が続くとき、5秒ごとに起こし続ける。
- 箱の中・ホストで、herdr と ssh の読み取り以外のことをする（pane への入力、箱の起動・停止、ファイルの書き込み。自分の記録ファイルは除く）。
- 状態ファイルの値を、箱の中のシェルのコマンドの文字列に埋め込む。

## 3. 決めたこと

| 論点 | 決定 | 理由・補足 |
|---|---|---|
| 作り方 | **待ちコマンドが `kec-orb ssh` で箱の herdr を直接読む**（利用者の決定。案 A） | 変更が pi-scaffold の読み取り口に収まる。known_hosts・BatchMode・ConnectTimeout は kec-orb に任せる |
| 読む間隔 | **ホストと同じ5秒・最長5分** | 実測 0.1 秒で負担が小さい |
| 1回に読む量 | **箱1つにつき ssh 1回**で `herdr pane list` と `herdr tab list` を読む（私の判断） | 接続を半分にする。分け方（区切り行など）は作り手に任せる |
| 箱の中の herdr | 既定の socket（`HERDR_SOCKET_PATH` を付けない）を読む | orchestrator の今の読み方（`kec-orb ssh <箱> herdr agent list`）と同じ |
| 読めないとき | ssh 255・herdr の失敗・解析できない出力は、その回の errors に入れ、そのタブは記録を更新せずに飛ばす（いなくなったとしない） | ホストの「読めなかったセッションは gone としない」と同じ。errors は `timeout` 行に添える |
| 箱名の扱い | 状態ファイルの `box` は kec-orb の名前の規則（英小文字・数字・`-`、先頭と末尾は英小文字か数字、41文字まで）に合うものだけ使い、argv の1要素として渡す。箱の中で流すコマンドは固定の文字列 | `kec-orb ssh` は引数をつなげて箱のシェルの1行にするため（kec-orb のコメント「信用できない入力は渡さない」） |
| kec-orb の場所 | 環境変数 `SCAFFOLD_ORCH_WAIT_KEC_ORB`（既定 `kec-orb`）（私の判断） | `SCAFFOLD_ORCH_WAIT_HERDR` と同じ考え方。試験で偽物を入れる |

### 3.1 対象

- `status` が `launching`・`running`・`waiting`・`cleanup_waiting` で、`box` と `pane` があるタブ。`pane` が空のタブ（kec-orb start の前・失敗）は読まない。
- 記録のキーはホストのタブと重ならない形にする（例 `box:<箱名>|<pane>`）。pane の ID は herdr ごとに振られるので、ホストの `socket|pane` と同じ形だと衝突しうる。

### 3.2 判定（ホストと同じ規則を箱の中の一覧に当てる）

- 本体: 箱の中の一覧で、`pane_id` がタブの `pane` の pane と、`label` が工程のタブ（`^(spec|design|impl|verify|setup)-e<N>(-r[0-9]+)?(-[0-9a-f]{4})?$`）の pane の agent。manager のタブ（`^(impl|verify)-mgr-f…`）は本体にしない。
- いなくなった: 箱の中の一覧が読めて、タブの `pane` が無い、またはその pane に agent がいない。
- 片付けが進んだ（`cleanup_waiting` のときだけ）: 「`working` がいる」を、箱の中の一覧と、ホストの記録したセッション（今の `socket` と `previous` の `socket`）の両方で見る。両方から `working` が消えたら起こす（スキルの「箱で回すとき」の「閉じた Epic」と同じ範囲）。
- 出力の行は今の形に合わせ、箱のタブだと分かるようにする（例 `Epic #12 box web-e12-rust 2 working->blocked`。書式は作り手に任せる）。

### 3.3 スキル側（scaffold-profiles）

- 「7. 見守る」の待ち方の説明に、待ちコマンドが箱のタブも見ることを足す（Claude 版・pi 版の両方）。起きたあとの読み方（`kec-orb ssh` で箱の中を読む）、知らせ方、255 を「いなくなった」と知らせる規則は変えない。
- 「箱で回すとき」の「見守る」も同じ書き方にそろえる。
- 待ちコマンドが無い・0以外のときの `sleep 300` への戻りは変えない。

### 3.4 届け方（Claude 版を含む）

- pi-scaffold（deterministic-scaffold）を main にマージしたあと、その commit を次の2か所に入れる。
  - **Claude 版**: claude-scaffold（`~/Documents/Github/claude-scaffold`）の `vendor/` の tgz と `package.json` の `deterministic-scaffold` を差し替えて `npm ci`。`bin/claude-dev` は既に `CLAUDE_SCAFFOLD_ORCHESTRATOR_WAIT` を export しているので変えない。
  - 箱の中（kec-orb の image・箱の中の claude-scaffold・pi）は変えない。待ちコマンドを動かすのはホストの orchestrator だけで、箱の中では herdr を読まれるだけだから（私の判断。builder check を受けて）。
  - **pi 版**: scaffold-profiles の `config/versions.yml` の `deterministic-scaffold-source` と `vendor/`、`~/.pi/local-packages/deterministic-scaffold/<commit>` の入れ直し。
- 今の固定は2か所でずれている（2026-11-15）: claude-scaffold は `bb9ab0dc`（pi-scaffold の main）、scaffold-profiles の vendor は `d7d5134c`（`feat/orchestrator-wait` の head）。今回の差し替えで両方を新しい commit にそろえる。
- スキル変更の関門（policy・評価 O01〜O04）への影響は計画で扱う。

## 4. 作り手に任せること

- ファイルの分け方。`Fleet` に箱用の読み口を足すか、別の reader にするか。
- 1回の ssh で2つの出力を分ける方法。
- 箱を並べて読むか、順に読むか（順でも5秒に収まる数なら可）。
- ssh 1回の時間切れ（ホストの herdr と同じ 15 秒を目安）。
- 記録の形、出力の細かい書式。
- kec-orb を呼ぶときに渡す環境変数（今の `execHerdr` は PATH・HOME・LANG だけを渡す。kec-orb がそれで箱用の known_hosts を見つけて動くことを確かめ、足りなければ足す）。

## 5. 試験

- 偽の kec-orb・herdr・時計で次を確かめる。
  - 箱のタブの本体が `blocked` になる、`idle`/`done` になる、pane が消える、で5秒の間隔の中で起きる。
  - 箱の中の manager の状態の変化では起きない。
  - 同じ状態が続いても、2回目はすぐには起きない。
  - ssh が255で返る・herdr が失敗する間は起きず、5分の `timeout` 行に errors として出る。つながり直したあと、前と同じ状態なら起きない。
  - `cleanup_waiting` の箱のタブは、箱の中とホストの両方から `working` が消えたときだけ起きる。
  - 規則に合わない箱名のタブは読まず、errors に出る。kec-orb の argv に箱名が1要素で渡り、箱の中のコマンドは固定である。
  - ホストのタブの今までの試験がそのまま通る。
- 実機の確認（利用者の決定）: scaffold-e2e-sandbox に箱で回せる小さい Epic（言語の image の表にある言語）を立て、`runIn: "box"` で計画の承認まで進め、Claude 版で1回（必須。利用者の依頼）・pi 版で1回、箱で起動する。本体が質問で `blocked` になれば人が答える。自然に起きる変化（`blocked` か `idle`/`done`）で、変化から待ちコマンドが行を出すまでの秒数を記録する（合格の目安: 10秒以内。仮置き）。

## 6. 決定ログ

- 2026-11-15 builder check を受けて改訂: 箱の中の版はそろえない（ホストだけで動くため）。実機の確認は scaffold-e2e-sandbox（利用者の決定）。
- 2026-11-15 利用者の決定: 速く知る範囲は「ホストと全部同じ」。255 ですぐ起こすことは含めない。作り方は案 A（`kec-orb ssh` で直接読む）。Claude Code 版の scaffold にも効かせる。
