# pi-scaffold

[Pi](https://github.com/earendil-works/pi)のScaffold開発フローを、AIが呼び出せる14個の個別ツールとして提供する拡張です。GitHubの操作はすべて[pi-gh](https://github.com/KendrickMalar/pi-gh)の公開ツール経由で行います。

npm名は`@papillon6814/pi-scaffold`（MIT）。

## 導入

- npm版：`pi install npm:@papillon6814/pi-scaffold@0.5.1`。
- Developmentだけで使う場合：`pi-profile packages add --profile developer npm:@papillon6814/pi-scaffold@0.5.1`、`pi-profile packages install --profile developer`。共通settingsへは追加しません。
- 同じProfileにpi-gh 0.5.0以上も必要です。
- Profileの割り当て変更後はPiを再起動してください。`/reload`だけでは新しい指定へ切り替わりません。
- ツールを使うリポジトリごとに、owner policy（後述）を置いてください。

## Scaffoldの保存先

`PI_SCAFFOLD_DIR` に専用の絶対パスを指定すると、policy・監視台帳・workflow state・承認・journal・調査artifacts・引き継ぎpacket/receipt・evidenceを、そのディレクトリにまとめて保存します。未指定のときだけ `<agentDir>/pi-scaffold`（`agentDir` は `PI_CODING_AGENT_DIR`、未指定なら `~/.pi/agent`）を使います。例：`PI_SCAFFOLD_DIR=/private/scaffold`。設定変更は**新しく起動したPiから**適用されます。既存データの移動は自動では行いません。

- 空文字・相対パス・制御文字（NULを含む）は拒否します。環境変数や `~` のシェル展開、symlinkの自動解決、旧保存先へのfallbackは行いません。
- 保存先と配下ディレクトリは現在ユーザー所有の通常ディレクトリ（700）、ファイルは通常ファイル（600）が必要です。symlink・FIFO・過大ファイル等は拒否します。引き継ぎ起動では、認証ディレクトリと保存先の両方に安全なASCII token（`A-Z a-z 0-9 . _ / : @ + -`）だけを使ってください。
- `PI_CODING_AGENT_DIR` は**認証とPiのセッション履歴**の場所です。`PI_SCAFFOLD_DIR` で変更しません。監視が読むログも `<agentDir>/sessions` のままです。account bindingは `realpath(agentDir)` に結び付き、保存先から認証を推測しません。同じ認証で保存先を変えてもbindingは同じで、別の認証との承認/Profile照合は引き続き行います。
- 工程を引き継ぐ子Piへ、元の `PI_CODING_AGENT_DIR` と選択済みの `PI_SCAFFOLD_DIR`、ブラウザのアカウント `PI_BROWSER_ACCOUNT` を固定・quotedの起動コマンドで明示伝播します。`PI_BROWSER_ACCOUNT` は `playwright-browser` MCP（`~/.local/bin/pi-browser-mcp`）が操作する Chrome プロファイルを決めます。送り手に無ければ `PI_CODING_AGENT_DIR` から決め（`~/.pi/agent` は kuno、`~/.pi/agent-muu`・`~/.pi/agent-rbx` はそれぞれ muu・rbx）、それも決まらなければ kuno にします（0.7.0）。共有台帳の監視は引き継いだ本人だけが操作します。プロセス間の同時書き込みロックはありません。


## Issue本文の容量

上限は Issue 本文全体（表示・JSON・ブロック外の追記）の 64 KiB（UTF-8）だけです。管理JSONに個別の上限はありません（2026-10-16 変更。以前は 32 KiB）。正規形式・承認digest・所有権の検査は省略しません。JSON内に余裕があっても、本文全体が上限を超えれば保存できません。

依存・Wave適用は、読み取ったEpicへ計画を追加して保存できるかを外部変更前に確認します。最初から保存不能なら依存・Project・ラベルを変更せず拒否します。実行途中の本文変更などは最後の再読込で別途検査するため、途中で停止した場合は従来どおりpartial/unknownの記録を確認し、同じoperationIdで再開します。
## 工程とツール

Epicは `setup → specification → basic-design → implementation → verification → completed` と進みます。工程が変わるたびに、Herdrの新しいタブで別のPiセッションを起動して引き継ぎます。同じ会話の中でモードを切り替えることはしません。

| 工程 | ツール | 内容 |
|---|---|---|
| setup | `scaffold_labels_ensure` | 管理ラベル211種類（固定11＋`Wave: 1`〜`Wave: 200`）を照合し、足りないものだけを作成する。色や説明が違えば既定では止まる。pi-gh 0.7.0以上では40件ずつまとめて作る（211件で数分）。それより古いpi-ghでは1件ずつ作る |
| setup | `scaffold_epic_draft_create` | タイトル・目的・元の依頼からEpicを1件作る（要件は補わない）。`mode: "prepare"`はローカルの下書きだけ |
| setup→specification | `scaffold_handoff_specification` | 仕様策定セッションへ引き継ぐ |
| specification | `scaffold_specification_update` | ヒアリングで確定した事実・要件・合格基準・決定を、安定IDのpatchとして反映する（削除・再採番はしない）。足りない項目は`missingFields`で返す |
| specification | `scaffold_research_begin` | 調査項目の担当（claim）を取り、調査指示（brief）を返す。調査の実行やモデル呼び出しはしない |
| specification | `scaffold_research_resolve` | 根拠（https URL、またはハッシュ付きの手元ファイル）のある結果を反映する。結果をREQ/AC/Dへ自動で昇格しない |
| specification→basic-design | `scaffold_handoff_basic_design` | 仕様がそろっていることを確認し、**仕様の内容承認**を得てから引き継ぐ |
| basic-design | `scaffold_feature_create` | Featureを1件作る。pi-ghのtaskテンプレートで作成し、Epicのnative sub-issueとして接続する。`editScope`はリポジトリ相対のディレクトリ・ファイル・glob（例: `src`、`src/a.ts`、`src/**/*.ts`、`{a,b}`、`[ab]`、`?`）。ルート（`.`、`./`、`**`）も書ける。空・絶対パス・`..`・バックスラッシュ・制御文字/ゼロ幅文字・末尾がドットか空白の区切りは、GitHubに書く前に`UNKNOWN_SCOPE`で止まる |
| basic-design | `scaffold_dependencies_apply` | Feature間の依存を検査し（循環・未知・自己辺、判定できない`editScope`）、足りない依存だけを追加する。計画と固定IDのMermaid図をEpicに保存する。`design`（設計書のpath/sha256/コミット。手元のgitで確認）を渡すと、Epicの基本設計の参照も同じ更新で保存する（実装工程への引き継ぎに必要）。結果の`dependencyDigest`は、Wave計画に入れる値 |
| basic-design | `scaffold_waves_verify` | （読み取りのみ）Wave・依存順・同じWave内の編集競合・ラベルを検証する。globの重なりは、互いに重ならないと示せない限り重なりとみなす（例: `src/**/*.ts`と`src/**/*.css`は並行可、`src/**`と`src/a.ts`・ルートと何でもは競合）。共有のmanifest/lockfile・state（migrations、workflows、schema）は、ディレクトリと同じくglobに合う実在ファイルと、globの固定部分（`db/migrations/**`）や末尾の名前（`**/package.json`）で判定する。合格しない場合も、Wave計画に入れる`dependencyDigest`と`featureSetDigest`を`data`に返す。依存計画が未保存なら`dependencyDigest`はnullで、`DEPENDENCY_PLAN_UNSET`を返す |
| basic-design | `scaffold_waves_apply` | 検証を通ったWave計画をFeatureのラベルへ反映し、計画をEpicに保存する。計画の2つのdigestは、先に`scaffold_waves_verify`を呼んで得る |
| basic-design→implementation | `scaffold_handoff_implementation` | 設計・Feature・合格基準・Waveを確認し、**実装開始の指示**を得てから引き継ぐ |
| implementation→verification | `scaffold_handoff_verification` | 統合コミットと、FeatureごとのAC別の証拠（レポート・ログのハッシュ）を固定して引き継ぐ。Epicは閉じない |
| verification→completed | `scaffold_epic_complete` | 完了条件を確認し、**最終受け入れ**を得てから、本文・Stage・closeを反映する（owner policyの`agentApprovals`に`epic-completion`があれば、親エージェントが自分で記録する。後述）。指定があればProjectをDoneにする。Epicの木（Feature・Task）に開いたIssueがあれば`TREE_ISSUES_OPEN`で止まる。完了後、Epicに記録されたProjectのうち、中身がこのEpicの木の閉じたIssueだけのものを閉じる（確認画面に出る。結果は`projectsClosed`・`projectsSkipped`。閉じる途中の失敗は同じ`operationId`で呼び直すと続きから進む） |
| basic-design・implementation・verification | `scaffold_specification_revise` | 承認済みの仕様を改訂する（意図を変えるときだけ）。patchは`scaffold_specification_update`と同じ形で、理由を必ず付ける。改訂後も仕様がそろっていること。調査結果は戻さない。**仕様の改訂**の承認を得てから、Epicの`specRevisions`に記録し、変わったREQ/ACを合格基準に持つFeatureだけに`Blocked`を付ける。Stageは動かさない |
| basic-design・implementation・verification | `scaffold_feature_revise` | Featureを1件、改訂後の仕様に合わせる（合格基準と、任意で設計の参照）。Featureの`expectedRevision`・`expectedBodySha256`を渡す。仕様の改訂で止まったFeatureなら`Blocked`を外す（ほかの理由の`Blocked`は残す） |

完了条件は次のとおりです。
- 要件がすべて合格基準でカバーされ、証拠が合格している
- `verifiedRef`がoriginの既定ブランチに含まれている

## 共通の約束

- **承認**の対象は、仕様の内容承認・実装開始の指示・最終受け入れ・仕様の改訂の4つです。どれも、見せた内容のdigestに結び付けます。内容が変われば失効します。Issue本文の`approved: true`や決定ログは承認として扱いません。
  - owner policyの`agentApprovals`に種類が書いてあれば、確認画面を出さずに親エージェントが記録します（headlessでも可）。記録には`approvedBy: "agent"`と`basis: "policy"`が入り、ツール結果の`data.agentApproval`（`kind`・`basis`・`viewDigest`）で分かります。この記録は、Profileの指示文のdigestを照合しません（記録には残します）。指示文を直しても、承認はやり直しになりません。
  - 書いていない種類は、親TUIの確認画面で人が答えたときだけ記録します。headlessでは新しく作れません。
  - 子セッション（subagent）は、どの場合も承認を記録できません。
  - `scaffold_feature_create`は、今の仕様に使える承認が無いとき（指示文が変わった人の承認など）、仕様がそろっていれば承認をやり直します（policyなら親エージェント、そうでなければ確認画面）。
  - 止まっている引き継ぎの放棄（`HANDOFF_IN_PROGRESS`）は、`agentApprovals`に`handoff-abandon`があれば確認画面なしで親エージェントが行います。結果の`data.agentAbandoned`に放棄したoperationIdが入ります。
- **固定資料の照合（`scaffold_stage_check`）**：Epicが固定した`docs/…@sha256:…`を、セッションの作業フォルダで読んでハッシュを照らし合わせます。別の拡張が`pi.events`の`worktree:active`（`{path, mainRoot}`）で切り替え先のworktreeを知らせていれば、そちらで読みます（dotfilesの`enforce-worktree`が送ります）。ただし、作業フォルダがその`mainRoot`の中にあり、`path`がgitの一覧に載った同じリポジトリのworktreeであるときだけです。ほかのツールの作業フォルダは変えません。
- **質問の遮断（`questionBlockedStages`）**：人間に質問してよいのは仕様策定の工程だけです。owner policyの`questionBlockedStages`（`"setup"`・`"basic-design"`・`"implementation"`・`"verification"`）に入った工程のセッションでは、`ask_user`（pi-ask-user）と`AskUserQuestion`の呼び出しを`tool_call`で止めます。例外はありません（以前の`【事前作業】`の例外は廃止）。
  - 工程は、このセッションが受け付けた引き継ぎpacketの`targetStage`で決まります。packetを受け付けていないセッション（setupの元のセッションや、手で起動したPiなど）、別のセッション、packetと違うリポジトリ・workflowでは止めません。
  - 止められたら、承認済みの仕様・設計の意図の範囲で自分で決めて記録します。意図を変える必要があれば`scaffold_specification_revise`を使います。
  - `tool_call`を出さないホスト（Claude Code上のclaude-scaffoldなど）では、この遮断はホスト側（claude-scaffoldのフック）が同じpolicyで行います。
- **旧形式の`agentDecisionStages`**（`"implementation"`・`"verification"`）も読みます。書いた工程は質問を止め、その工程のセッションでの承認と放棄を親エージェントが記録します（記録は`approvedBy: "agent"`と`stage`）。以前の記録も有効です。
- **operationId**：書き込みのあるツールは、手順ごとにjournalへ記録します。同じoperationIdでの再実行は、続きから再開するか`noop`を返します。別の内容で同じoperationIdを使うと止まります。結果が分からない書き込みは、GitHubを読み直して照合してから進め、むやみに再送しません。
- **結果のstatus**：`validated` `prepared` `applied` `noop` `blocked` `partial` `unknown` `cancelled` の8種類です。
  - `partial`と`unknown`は`resumeToken`（＝operationId）付きで返します。同じoperationIdで再開してください。
  - `blocked`・`partial`・`unknown`・`cancelled`はエラー（`isError: true`）として返します。
- **書き込み**はpi-ghの前提条件付き更新（`*_if_current`）を使います。本文やラベルが読んだ後に変わっていれば、上書きせずに止まります。管理ブロックの外にあるメモは、1バイトも変えません。
- **取消**：reload / tree / forkで会話が変わると、実行中の呼び出しは`cancelled`になります（書き込みの途中なら`unknown`）。
- pi-ghに必要な機能が無いときは`CAPABILITY_MISSING`で止まります。ghやAPIを直接呼んで回避することはしません。


### 下位工程セッションの監視

引き継ぎが完了すると、親セッションはその下位 pane を60秒ごとに確認します（Herdr 0.9.1 か 0.9.5／protocol 22 のときだけ）。

- pane が消えた、pi が終了した、確認・入力待ち、エラー停止、返事待ち・完了のときは、親TUIに通知します。同じ状態で通知を繰り返すことはありません。
- 別のセッションが動いている pane（pane ID が使い回された場合など）には送らず、監視を終えます。
- Herdr がその pane のセッションを報告しないときは、自動の「続けて」だけを止め、そのことを一度通知します。ほかの通知は出します。
- 一時的な API エラー（429・5xx・overloaded・接続エラーなど）で止まったときだけ、1分→5分→15分あけて最大3回「続けて」を送ります。送る直前に、同じエラーで止まったままかを確かめます。
- usage limit・認証・400系のエラーは通知だけです。下位のセッションログの形式（version 3）が違う場合も、自動では送りません。
- 監視台帳は `<scaffoldDir>/state/watches.json`（未指定時は `<agentDir>/pi-scaffold/state/watches.json`） です。監視するのは、引き継いだ本人のセッションだけです。同じセッションを開き直すと、監視を再開します。

## 必要なもの

- Pi 1.x、pi-gh 0.5.0以上（`gh_labels_list`、ラベル絞り込み、`*_if_current`）
- 引き継ぎには次が必要です。
  - Herdr 0.9.1 または 0.9.5（protocol 22。0.9.5 は `tab create` 直後の `pane process-info` が一瞬 `pane_not_found` を返すので、最大2秒待ち直す）
  - pi-profileの scaffold 用 Profile（`developer` か `roblox-game`。これ以外の Profile からは引き継げません）
  - owner policy（`<scaffoldDir>/policy.json`、未指定時は `<agentDir>/pi-scaffold/policy.json`、`authMode: "file-backed"`と、許可するモデルtuple）。`repos`のキーは`OWNER/REPO`か、そのオーナー配下の全リポジトリを表す`OWNER/*`です。両方あれば`OWNER/REPO`を優先します。それ以外のワイルドカードは使えません。
  - 各リポジトリのエントリには、任意で`agentDecisionStages`（旧形式：`"implementation"`・`"verification"`）を書けます。
  - AI承認と質問の遮断は、同じディレクトリの**別ファイル`policy.agent.json`**に書きます。policy.jsonを旧形式のまま保つので、この版より前のpi-scaffoldが動いているセッションも壊れません（前の版はこのファイルを読みません）。policy.jsonと同じキーのエントリにだけ足され、無ければ旧形式だけで動きます。壊れていればpolicyのエラーです。
    - `agentApprovals`：`"specification"`・`"implementation-start"`・`"epic-completion"`・`"handoff-abandon"`・`"specification-revision"`
    - `questionBlockedStages`：`"setup"`・`"basic-design"`・`"implementation"`・`"verification"`（`"specification"`は書けません）
    - どちらもpolicy.jsonに直接書くこともできますが、その場合は前の版が読めなくなります。

```json
// policy.json（旧形式のまま）
{"version": 1, "repos": {"OWNER/*": {"authMode": "file-backed", "models": [], "agentDecisionStages": ["implementation", "verification"]}}}
// policy.agent.json
{"version": 1, "repos": {"OWNER/*": {
  "agentApprovals": ["specification", "implementation-start", "epic-completion", "handoff-abandon", "specification-revision"],
  "questionBlockedStages": ["setup", "basic-design", "implementation", "verification"]}}}
```
- 引き継ぎの受け手は、送り手と同じProfile（id）で起動していれば受け付けます。Profileの指示文が送り手の開始後に変わっていても止めず、受領（`ready.json`）に両方のdigestを残し、結果の`data.profileChanged`で知らせます。cwd・アカウント・必要なツール・固定した文書の検査はそのままです。
- GitHubへの書き込みは、pi-ghのTUI承認か、所有者が置いたpi-ghの許可ファイルを経由する必要があります。pi-scaffoldは許可ファイルを作りません。

新しいPiは、送り手と同じProfileで`env PI_CODING_AGENT_DIR=<dir> PI_SCAFFOLD_DIR=<dir> PI_BROWSER_ACCOUNT=<account> pi-profile launch --profile <送り手のid> -- --scaffold-handoff <packet>`として起動します（`env` の値は送り手のもの）。既存のタブを閉じたり、相手のセッションを止めたりはしません。scaffold-watchdog が止まった工程を再開するときも、`developer` 以外の Profile なら同じ Profile で起動し直します（pi は `env PI_CODING_AGENT_DIR=<dir> PI_BROWSER_ACCOUNT=<account> pi-profile launch --profile <id> -- --session <path>`、Claude は `claude-dev --scaffold-profile=<id> --resume <id>`）。pi の `<dir>` は工程を見つけた scaffold の置き場所（`~/.pi/agent*/pi-scaffold`）の親で、アカウントもそこから決めます。置き場所が `~/.pi/agent*` の下に無いときは `PI_CODING_AGENT_DIR` を付けず、アカウントは kuno です（0.7.0）。

## 範囲外

- 手動スラッシュコマンド
- 実装者・テスト担当の自動起動、調査の自動実行、テストの代行
- 仕様や設計の内容判断
- fetch / merge / push、リリース、通知
- 証拠の内容の真正性の保証（参照とハッシュは確認しますが、内容の真偽は人間が判断します）

## 役割の分担

- **pi-scaffold**：工程ごとの個別ツール、専用テンプレート、工程の条件、実行ウェーブ、セッションの引き継ぎ。
- **pi-gh**：汎用のGitHub操作、入力検証、承認、変更結果の確認。pi-scaffoldは`ctx.executeTool()`でpi-ghを呼び、`gh_capabilities`（contractVersion 1と必要な機能）を確認します。

## scaffold-watchdog（止まった工程の自動回復）

`bin/scaffold-watchdog` は、工程のペインが止まったときに人を介さず回復させる常駐です。launchd から1分ごとに `--once` で起動します（plist は dotfiles の `scripts/launchd/com.kendrickmalar.scaffold-watchdog.plist`）。通知はしません。処理はすべて `~/.local/state/scaffold-watchdog.log`（JSON Lines）に残し、毎回ディスクの空きも記録します。

- 見る対象: 各 scaffold dir の handoff 記録（`state/*/*/handoff/*/packet.json` と `ready.json`）。Pi（`~/.pi/agent*/pi-scaffold`）と Claude（`~/.claude/scaffold/pi-scaffold`）の両方です。14日より古い handoff は見ません
- ペインの特定: 全 herdr セッション（`herdr session list --json`）の `pane list` で、セッションが一致するペインを探します
- 起動し直した会話への結び直し: 記録上の会話が見つからず、全セッションが読めたときは、後継の会話を探します。候補は、同じ種別（pi/Claude）で cwd が packet と同じ、他の工程や親が持っていない、handoff より後に作られた会話です（作成時刻は Pi のファイル名か UUIDv7 から）。結び直すのは引き継ぎのタブ（label `scaffold-<nonceSha256 の先頭12桁>`）にある会話だけです。1つなら以後それを追い、`rebound`（`from`・`to`・ペイン）をログに出します。複数なら `rebind-ambiguous` を出して何もしません。タブの外で cwd だけ一致する会話は、人が別の作業で開いたものかもしれないので結び直さず、`rebind-candidate-outside-tab`（会話 ID とペイン）を一度だけ出します
- 完了の判定: `gh issue view` で Epic の Stage ラベルを読みます。閉じているか、ラベルが対象より後の工程なら、その工程は二度と触りません（`retired`）。前の工程のラベルのまま（引き継ぎ直後でラベルが追いついていない）なら監視を続け、`stage-not-yet` を一度だけ出します。工程でないラベルも外さず `stage-unknown` を出します。理由なしで `retired` になった古い state は再判定し、外れなければ `unretired` を出して戻します。読めないときは何もしません

| 状況 | 処理 |
|---|---|
| 完了前の idle（仕様策定以外、質問待ちでない） | 5分動きがなければ「続けて」を送る。同じ停止に2回まで（15分おき）、工程あたり8回まで |
| 上の idle で、その会話の pi-subagents の async run が動いている（running/queued で status.json が10分以内に更新、または runner の pid が生存） | 送らない。回数も使わない。`waiting-child`（run id）を状態が変わったときだけ出す |
| 上の idle で、run が親の最後の発話より後に終わっている | 「続けて」の代わりに「子 run <id> は <時刻> に完了済みです…保存された結果を読んで続けてください」を送る（上限は同じ） |
| 一時エラー | 親の pi が生きていれば親内の監視（`watch/watcher.ts`）に任せる。居なければ同じ `decide()` で再開する |
| pi・Claude が消えてシェルだけ残った | `env [PI_CODING_AGENT_DIR=<dir>] PI_BROWSER_ACCOUNT=<account> pi --session <path>`（shim 経由。Profile があれば `pi-profile launch`）または `claude --resume <id>` を打つ。3回まで、5分おき |
| 仕様策定の idle、Esc での中断、回復しないエラー、ペイン消失 | ログだけ |
| pi-subagents の runner が死んだ run | `SCAFFOLD_WATCHDOG_SUBAGENTS_RECONCILE` のスクリプトを毎回呼ぶ（failed にして結果ファイルで親へ届く） |

送る直前に、ペインの revision・状態・セッションが観測時と同じかを確かめます。違えば送りません。`--dry-run` は判断をログに書くだけです。常駐の state ファイルは読むだけで書かず、自分の記憶は隣の `<state>.dry-run` に置きます。

環境変数: `SCAFFOLD_WATCHDOG_ROOTS`（`pi=/abs,claude=/abs`）、`SCAFFOLD_WATCHDOG_STATE`、`SCAFFOLD_WATCHDOG_LOG`、`SCAFFOLD_WATCHDOG_HERDR`、`SCAFFOLD_WATCHDOG_GH`、`SCAFFOLD_WATCHDOG_CLAUDE_COMMAND`、`SCAFFOLD_WATCHDOG_SUBAGENTS_RECONCILE`、`SCAFFOLD_WATCHDOG_SUBAGENT_RUNS`（既定は `<TMPDIR>/pi-subagents-uid-<uid>/async-subagent-runs`。TMPDIR が無ければ `getconf DARWIN_USER_TEMP_DIR`）。run の持ち主は status.json の `sessionId`（親の会話ファイル）で決めます。Claude の工程は対象外です。

## 開発と検証

```sh
npm install --ignore-scripts
npm run typecheck
npm test
```

いずれのスクリプトも、合成したHOMEと偽の`gh`・ループバックのモデルで動きます。実際のGitHubには触れません。

- **実Piでの確認**：`python3 scripts/test-native-pi.py --pi-gh <pi-gh 0.5.0以上>`
- **Herdr実機での引き継ぎ**：`python3 scripts/test-native-handoff.py --pi-gh <pi-gh> --pi-profile <pi-profile>`
- **Herdr実機での下位監視**：`python3 scripts/test-native-watch.py --pi-gh <pi-gh> --pi-profile <pi-profile>`。一時的なエラーへの「続けて」が1回だけ届くこと、親の `/reload` 後もタイマーが1本であること、下位の `/new` で送らずに監視が終わることを確かめます。60秒ごとの確認を待つため、10分ほどかかります。
- **全工程を通す試験**：`python3 scripts/test-native-workflow.py --pi-gh <pi-gh> --pi-profile <pi-profile>`
  - Herdrを使う3つは、専用のherdr session `pst`で実行します。終了後にセッションを停止し、一時ディレクトリを削除します。

起動中のPiは、pi-ghやpi-scaffoldを入れ替えたら再起動しないと新しい版を読み込みません。
