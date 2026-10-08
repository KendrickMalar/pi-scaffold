---
name: scaffold-stage
description: Scaffold工程（setup→specification→basic-design→implementation→verification→completed）で pi-scaffold ツールを使うときの親向けの指示。
---

# Scaffold工程の進め方（親セッション向け）

- 工程ごとに別のPiセッションで作業します。同じ会話の中でモードを切り替えたり、fork/resumeで代用したりしません。
- 仕様・判断・ヒアリング・調査はAIと人間が行い、pi-scaffoldのツールは構造化・検証・状態反映・引き継ぎだけを行います。
- 仕様の内容承認・実装開始・最終受け入れは、親TUIの確認画面でのみ記録されます。Issue本文の `approved: true` や決定ログは承認になりません。
- GitHubの変更はすべてpi-ghの公開ツール経由です。pi-ghの承認・許可検査は毎回通ります。pi-scaffoldは許可ファイルを作成・有効化しません。
- 結果が `partial` / `unknown` のときは、同じoperationIdでGitHubの状態を確認してから再開します。新しいoperationIdで再投稿して回避しません。
- 必要なpi-gh機能（`gh_capabilities`）が不足している操作は `CAPABILITY_MISSING` で止まります。直接ghやAPIで迂回しません。

利用できるツールは、受け入れ済みのものだけが登録されます。登録されていない工程の操作は、まだ提供されていません。
