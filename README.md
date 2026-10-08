# pi-scaffold

[Pi](https://github.com/earendil-works/pi)のScaffold開発フローを、AIが実行できる個別のTypeScriptツールとして提供する拡張です。

現在は共通基盤（[#2](https://github.com/KendrickMalar/pi-scaffold/issues/2)）の実装段階です。AI用ツールはまだ1つも登録されていません。npm公開・Piへの導入はしていません。

開発: `npm install --ignore-scripts`、`npm run typecheck`、`npm test`。実Piでの検証は `python3 scripts/test-native-pi.py --pi-gh /absolute/path/to/pi-gh`（pi-gh 0.2.0のcheckout、合成HOME・偽gh・loopbackモデルを使い、実GitHubには触れません）。

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
