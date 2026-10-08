# pi-scaffold

[Pi](https://github.com/earendil-works/pi)のScaffold開発フローを、AIが実行できる個別のTypeScriptツールとして提供する拡張です。

共通基盤（[#2](https://github.com/KendrickMalar/pi-scaffold/issues/2)）の上に、受け入れ済みのツールだけを登録しています。npm公開・Piへの導入はしていません。

| ツール | 内容 |
|---|---|
| `scaffold_labels_ensure` | 管理ラベル211種類（固定11＋`Wave: 1`〜`Wave: 200`）を一覧1回で照合し、不足分だけpi-gh経由で作成。最後に全件を読み戻してから成功を返す。色・説明・大小文字の違いは既定で停止（`onMismatch: "update"`で更新）。無関係ラベルの改名・削除、Issueへの付与はしない。1回の呼び出しは約60秒で区切り、`partial`なら同じoperationIdで続きを実行 |
| `scaffold_epic_draft_create` | タイトル・目的・元の依頼から#4 v1のEpic下書きを作る（要件などは補完しない）。`mode: "prepare"`はローカルの下書きだけ、既定の`publish`はpi-gh（template kind parent）で未完成のEpicを1件作成し、`Type: Scaffold`/`Scope: Epic`だけを付ける（Stageなし）。同じoperationIdの再実行は同じIssueを返し、成否不明の投稿は再投稿しない。セッションのモデルはplannerとして記録するだけで呼び出さない。先に`scaffold_labels_ensure`が必要 |

pi-ghの`gh_labels_list`（[KendrickMalar/pi-gh#5](https://github.com/KendrickMalar/pi-gh/issues/5)）が必要です。ない版では`CAPABILITY_MISSING`で止まります。ラベル作成はpi-ghの承認を1件ずつ通ります。`onMismatch: "update"`の更新はpi-ghのlabel-editを使うため、pi-gh側で影響範囲としてIssue一覧を読みます。Issueが非常に多いリポジトリでは更新が`GITHUB_LIMIT`で止まることがあります（作成だけなら影響しません）。TUIで承認するか、所有者がpi-ghの許可ファイルに`gh_label_create`を明示した場合だけ自動で進みます。

Epic本文はpi-ghが組み立てるため、管理ブロックの前に`## Scaffold Epic（自動管理）`、後ろに`## 担当モデル`（planner）が付きます。管理ブロックの外側は読み戻し時もそのまま保持します。

開発: `npm install --ignore-scripts`、`npm run typecheck`、`npm test`。実Piでの検証は `python3 scripts/test-native-pi.py --pi-gh /absolute/path/to/pi-gh`（pi-gh 0.3.0以上のcheckoutまたはインストール済みパッケージ、合成HOME・偽gh・loopbackモデルを使い、実GitHubには触れません）。

## 役割の分担

- **pi-scaffold**：工程ごとの個別ツール、専用テンプレート、工程条件、実行ウェーブ、セッション引き継ぎ。
- **[pi-gh](https://github.com/KendrickMalar/pi-gh)**：汎用GitHub操作、入力検証、承認、変更結果の確認。
- pi-ghの公開ツールを`ctx.executeTool()`で利用し、`gh_capabilities`の契約バージョンと必要機能を確認します。初期候補は`@papillon6814/pi-gh@0.2.0`・contractVersion 1です。
- 手動用スラッシュコマンドではなく、AI用の個別ツールを中心にします。内部処理は共有しても、各操作の入口・入力・結果・完了条件は分けます。

## 個別操作の予定

| 工程 | 操作 |
|---|---|
| 環境セットアップ | 管理ラベルの準備 |
| 環境セットアップ | Epicの下書き作成 |
| 環境セットアップ | 仕様策定セッションへの引き継ぎ |
| 仕様策定 | ヒアリング内容の仕様への整理 |
| 仕様策定 | 未解決の調査項目への着手 |
| 仕様策定 | 調査結果のEpicへの反映 |
| 仕様策定 | 基本設計セッションへの引き継ぎ |
| 基本設計 | Feature Issueの作成 |
| 基本設計 | Feature間の依存関係の登録・可視化 |
| 基本設計 | 実行ウェーブの割り当て |
| 基本設計 | 実行ウェーブの割り当て検証 |
| 基本設計 | 詳細設計・実装セッションへの引き継ぎ |
| 詳細設計・実装 | 検証セッションへの引き継ぎ |
| 検証 | Epicの完了処理 |

## 開発前に決めること

各Issueに目的・範囲・対象外・完了条件・未決事項を記録しています。ツール名や入力schema、Epic/Feature/Taskのテンプレート、必須ラベル、Herdrへの接続方法は実装前に確定します。

判断・ヒアリング・調査はAIが担当し、ツールは構造化、検証、状態反映、引き継ぎを担当します。自然言語の指示をそのまま任意API・shellとして実行しません。

pi-ghに必要な汎用操作が不足している場合はpi-gh側へIssueを分け、内部実装の直接importや直接gh実行で安全境界を迂回しません。自動実行の権限設定をこの拡張が無断で有効化することはありません。

進捗と完了条件の正本は、このリポジトリのGitHub Issuesです。
