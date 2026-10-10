---
name: scaffold-stage
description: Scaffold工程（setup→specification→basic-design→implementation→verification→completed）で pi-scaffold ツールを使うときの親向けの指示。
---

# Scaffold工程の進め方（親セッション向け）

## 共通

- 工程ごとに別のPiセッションで作業します。同じ会話の中でモードを切り替えたり、fork/resumeで代用したりしません。
- 仕様・判断・ヒアリング・調査はAIと人間が行います。pi-scaffoldのツールが行うのは、構造化・検証・状態反映・引き継ぎだけです。ツールの結果を、人間の判断の代わりにしないでください。
- 承認が必要な場面は、仕様の内容承認・実装開始の指示・最終受け入れの3つです。どれも、親TUIの確認画面で人間が答えたときだけ記録されます。
  - Issue本文の `approved: true` や決定ログは、承認になりません。
  - 確認画面の内容を、自分で要約して承認済みとみなさないでください。
- GitHubの変更は、すべてpi-ghの公開ツールを経由します。pi-ghの承認と許可の検査は毎回通ります。pi-scaffoldは許可ファイルを作成も有効化もしません。
- 結果が `partial` / `unknown` のときは、同じoperationIdで呼び直します。新しいoperationIdで再投稿して回避しません。
- `CAPABILITY_MISSING`（pi-ghの機能不足）のときは、直接ghやAPIで迂回しません。止まって親に伝えます。
- 前提にしている本文が古いと（`STALE_BODY` / `STALE_REVISION`）、Epicを読み直してから、最新の `expectedRevision` / `expectedBodySha256` で呼び直します。

## 工程ごと

1. **setup**
   - `scaffold_labels_ensure` を実行します。
   - `scaffold_epic_draft_create` で、依頼をそのまま記録します（要件は補いません）。
   - `scaffold_handoff_specification` で、仕様策定セッションへ渡します。
2. **specification**
   - ヒアリングで確定したことだけを `scaffold_specification_update` に入れます。未回答の項目は `answer: null` のまま残します。
   - 調査は `scaffold_research_begin` → 調査 → `scaffold_research_resolve` の順に進めます。根拠を示せない結果は `needs-more-work` にします。
   - 仕様がそろったら `scaffold_handoff_basic_design` を呼びます。確認画面で人間の承認を待ちます。
3. **basic-design**
   - 設計書をコミットします。
   - `scaffold_feature_create` で、Featureを1件ずつ作ります。
   - `scaffold_dependencies_apply` で、全Featureの依存を登録します。このとき **`design`（設計書の path / sha256 / コミット）を必ず渡します**。Epicに設計書の参照が無いと、実装工程へは引き継げません（`DESIGN_UNSET`）。
   - Wave計画（`plan`）には `dependencyDigest` と `featureSetDigest` が必要です。**先に `scaffold_waves_verify` を呼んで digest を得ます**（`plan` なしで呼べば、計画が未保存でも `data` に2つが返ります）。`scaffold_dependencies_apply` の結果の `dependencyDigest` も同じ値です。digest を自分で計算したり、パッケージの内部を読んだりしません。
   - 返った digest を入れた計画を `scaffold_waves_verify` で確かめ、`scaffold_waves_apply` で反映します。`dependencyDigest` が null（`DEPENDENCY_PLAN_UNSET`）なら、先に依存を登録します。
   - `scaffold_handoff_implementation` を呼び、実装開始の指示を待ちます。
4. **implementation**
   - 実装とテストは、承認された担当が別に行います。
   - 統合コミットとAC別の証拠（`evidence/`の下のレポートとログ）がそろったら、`scaffold_handoff_verification` を呼びます。Epicは閉じません。
5. **verification**
   - 最終の証拠を用意します。
   - `verifiedRef` がoriginの既定ブランチに含まれていることを確かめます。手元に無ければ、人間に `git fetch` を依頼します。
   - `scaffold_epic_complete` を呼び、最終受け入れを待ちます。

登録されているツールは、受け入れ済みのものだけです。登録されていない操作は、まだ提供されていません。
