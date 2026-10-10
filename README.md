# pi-scaffold

[Pi](https://github.com/earendil-works/pi)のScaffold開発フローを、AIが呼び出せる14個の個別ツールとして提供する拡張です。GitHubの操作はすべて[pi-gh](https://github.com/KendrickMalar/pi-gh)の公開ツール経由で行います。

npm名は`@papillon6814/pi-scaffold`（MIT）。

## 導入

- npm版：`pi install npm:@papillon6814/pi-scaffold@0.4.0`。
- Developmentだけで使う場合：`pi-profile packages add --profile developer npm:@papillon6814/pi-scaffold@0.4.0`、`pi-profile packages install --profile developer`。共通settingsへは追加しません。
- 同じProfileにpi-gh 0.5.0以上も必要です。
- Profileの割り当て変更後はPiを再起動してください。`/reload`だけでは新しい指定へ切り替わりません。
- ツールを使うリポジトリごとに、owner policy（後述）を置いてください。

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
| specification→basic-design | `scaffold_handoff_basic_design` | 仕様がそろっていることを確認し、**親TUIで仕様の内容承認**を得てから引き継ぐ |
| basic-design | `scaffold_feature_create` | Featureを1件作る。pi-ghのtaskテンプレートで作成し、Epicのnative sub-issueとして接続する。`editScope`はリポジトリ相対のディレクトリかファイル（例: `src`、`src/a.ts`）。空・ルート・glob・絶対パス・`..`は`scaffold_waves_verify`で判定できないため、GitHubに書く前に`UNKNOWN_SCOPE`で止まる（`src/**`ではなく`src`と書く） |
| basic-design | `scaffold_dependencies_apply` | Feature間の依存を検査し（循環・未知・自己辺、判定できない`editScope`）、足りない依存だけを追加する。計画と固定IDのMermaid図をEpicに保存する。`design`（設計書のpath/sha256/コミット。手元のgitで確認）を渡すと、Epicの基本設計の参照も同じ更新で保存する（実装工程への引き継ぎに必要）。結果の`dependencyDigest`は、Wave計画に入れる値 |
| basic-design | `scaffold_waves_verify` | （読み取りのみ）Wave・依存順・同じWave内の編集競合・ラベルを検証する。合格しない場合も、Wave計画に入れる`dependencyDigest`と`featureSetDigest`を`data`に返す。依存計画が未保存なら`dependencyDigest`はnullで、`DEPENDENCY_PLAN_UNSET`を返す |
| basic-design | `scaffold_waves_apply` | 検証を通ったWave計画をFeatureのラベルへ反映し、計画をEpicに保存する。計画の2つのdigestは、先に`scaffold_waves_verify`を呼んで得る |
| basic-design→implementation | `scaffold_handoff_implementation` | 設計・Feature・合格基準・Waveを確認し、**親TUIで実装開始の指示**を得てから引き継ぐ |
| implementation→verification | `scaffold_handoff_verification` | 統合コミットと、FeatureごとのAC別の証拠（レポート・ログのハッシュ）を固定して引き継ぐ。Epicは閉じない |
| verification→completed | `scaffold_epic_complete` | 完了条件を確認し、**親TUIで最終受け入れ**を得てから、本文・Stage・closeを反映する。指定があればProjectをDoneにする |

完了条件は次のとおりです。
- 要件がすべて合格基準でカバーされ、証拠が合格している
- `verifiedRef`がoriginの既定ブランチに含まれている

## 共通の約束

- **承認は親TUIでのみ記録します。** 対象は、仕様の内容承認・実装開始の指示・最終受け入れの3つです。どれも、確認画面で見せた内容のdigestに結び付けます。内容が変われば失効し、headlessや子セッションでは新しく作れません。Issue本文の`approved: true`や決定ログは承認として扱いません。
- **operationId**：書き込みのあるツールは、手順ごとにjournalへ記録します。同じoperationIdでの再実行は、続きから再開するか`noop`を返します。別の内容で同じoperationIdを使うと止まります。結果が分からない書き込みは、GitHubを読み直して照合してから進め、むやみに再送しません。
- **結果のstatus**：`validated` `prepared` `applied` `noop` `blocked` `partial` `unknown` `cancelled` の8種類です。
  - `partial`と`unknown`は`resumeToken`（＝operationId）付きで返します。同じoperationIdで再開してください。
  - `blocked`・`partial`・`unknown`・`cancelled`はエラー（`isError: true`）として返します。
- **書き込み**はpi-ghの前提条件付き更新（`*_if_current`）を使います。本文やラベルが読んだ後に変わっていれば、上書きせずに止まります。管理ブロックの外にあるメモは、1バイトも変えません。
- **取消**：reload / tree / forkで会話が変わると、実行中の呼び出しは`cancelled`になります（書き込みの途中なら`unknown`）。
- pi-ghに必要な機能が無いときは`CAPABILITY_MISSING`で止まります。ghやAPIを直接呼んで回避することはしません。


### 下位工程セッションの監視

引き継ぎが完了すると、親セッションはその下位 pane を60秒ごとに確認します（Herdr 0.9.1／protocol 22 のときだけ）。

- pane が消えた、pi が終了した、確認・入力待ち、エラー停止、返事待ち・完了のときは、親TUIに通知します。同じ状態で通知を繰り返すことはありません。
- 別のセッションが動いている pane（pane ID が使い回された場合など）には送らず、監視を終えます。
- 一時的な API エラー（429・5xx・overloaded・接続エラーなど）で止まったときだけ、1分→5分→15分あけて最大3回「続けて」を送ります。送る直前に、同じエラーで止まったままかを確かめます。
- usage limit・認証・400系のエラーは通知だけです。下位のセッションログの形式（version 3）が違う場合も、自動では送りません。
- 監視台帳は `<agentDir>/pi-scaffold/state/watches.json` です。監視するのは、引き継いだ本人のセッションだけです。同じセッションを開き直すと、監視を再開します。

## 必要なもの

- Pi 1.x、pi-gh 0.5.0以上（`gh_labels_list`、ラベル絞り込み、`*_if_current`）
- 引き継ぎには次が必要です。
  - Herdr 0.9.1（protocol 22）
  - pi-profileの`developer` Profile
  - owner policy（`$PI_CODING_AGENT_DIR/pi-scaffold/policy.json`、`authMode: "file-backed"`と、許可するモデルtuple）。`repos`のキーは`OWNER/REPO`か、そのオーナー配下の全リポジトリを表す`OWNER/*`です。両方あれば`OWNER/REPO`を優先します。それ以外のワイルドカードは使えません。
- GitHubへの書き込みは、pi-ghのTUI承認か、所有者が置いたpi-ghの許可ファイルを経由する必要があります。pi-scaffoldは許可ファイルを作りません。

新しいPiは`pi-profile launch --profile developer -- --scaffold-handoff <packet>`で起動します。既存のタブを閉じたり、相手のセッションを止めたりはしません。

## 範囲外

- 手動スラッシュコマンド
- 実装者・テスト担当の自動起動、調査の自動実行、テストの代行
- 仕様や設計の内容判断
- fetch / merge / push、リリース、通知
- 証拠の内容の真正性の保証（参照とハッシュは確認しますが、内容の真偽は人間が判断します）

## 役割の分担

- **pi-scaffold**：工程ごとの個別ツール、専用テンプレート、工程の条件、実行ウェーブ、セッションの引き継ぎ。
- **pi-gh**：汎用のGitHub操作、入力検証、承認、変更結果の確認。pi-scaffoldは`ctx.executeTool()`でpi-ghを呼び、`gh_capabilities`（contractVersion 1と必要な機能）を確認します。

## 開発と検証

```sh
npm install --ignore-scripts
npm run typecheck
npm test
```

いずれのスクリプトも、合成したHOMEと偽の`gh`・ループバックのモデルで動きます。実際のGitHubには触れません。

- **実Piでの確認**：`python3 scripts/test-native-pi.py --pi-gh <pi-gh 0.5.0以上>`
- **Herdr実機での引き継ぎ**：`python3 scripts/test-native-handoff.py --pi-gh <pi-gh> --pi-profile <pi-profile>`
- **全工程を通す試験**：`python3 scripts/test-native-workflow.py --pi-gh <pi-gh> --pi-profile <pi-profile>`
  - Herdrを使う2つは、専用のherdr session `pst`で実行します。終了後にセッションを停止し、一時ディレクトリを削除します。

起動中のPiは、pi-ghやpi-scaffoldを入れ替えたら再起動しないと新しい版を読み込みません。
