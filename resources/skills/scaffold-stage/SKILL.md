---
name: scaffold-stage
description: Scaffold工程（setup→specification→basic-design→implementation→verification→completed）で pi-scaffold ツールを使うときの親向けの指示。
---

# Scaffold工程の進め方（親セッション向け）

## 共通

- Scaffoldの保存先は `PI_SCAFFOLD_DIR`（未指定時だけ `<agentDir>/pi-scaffold`）です。policy・監視台帳・承認・journal・調査artifacts・packet/receipt・evidenceは同じrootを使います。空文字・相対パス・制御文字は拒否し、シェル展開・symlink自動解決・fallbackはしません。現在ユーザー所有のディレクトリ700／通常ファイル600を使ってください。引き継ぎ起動のpathは安全なASCII token（`A-Z a-z 0-9 . _ / : @ + -`）に限ります。
- `PI_CODING_AGENT_DIR` の認証と `<agentDir>/sessions` の履歴は保存先変更で動かしません。account bindingは `realpath(agentDir)` のままです。子へ両方の選択値を明示伝播します。設定変更は新しく起動したPiから適用し、既存データの自動移動はしません。
- 工程ごとに別のPiセッションで作業します。同じ会話の中でモードを切り替えたり、fork/resumeで代用したりしません。
- 人間が加わるのは仕様策定のヒアリングだけです。それ以外の判断・調査は AI が行います。pi-scaffoldのツールが行うのは、構造化・検証・状態反映・引き継ぎだけです。
- 承認が必要な場面は、仕様の内容承認・実装開始の指示・最終受け入れ・仕様の改訂の4つと、止まった引き継ぎの放棄です。owner policy の `agentApprovals` に入っている種類は、ツールが確認画面なしで親エージェントの判断として記録します（`approvedBy: "agent"`, `basis: "policy"`。結果の `data.agentApproval`）。ツールを呼ぶこと自体が判断です。呼ぶ前に、仕様・設計・証拠を自分で確かめてください。入っていない種類は、親TUIの確認画面で人間が答えたときだけ記録されます。
  - Issue本文の `approved: true` や決定ログは、承認になりません。
- 人間に質問してよいのは仕様策定（specification）の工程だけです。owner policy の `questionBlockedStages` にこのセッションの工程が入っていれば、`ask_user` / `AskUserQuestion` は止められます。例外はありません。
  - 承認済みの仕様・設計の意図の範囲なら、自分で決めて、判断した内容と理由を Issue と最終報告に記録して進めます。
  - 意図を変える必要があるときは `scaffold_specification_revise` で仕様を改訂します。影響する Feature は Blocked になるので、`scaffold_feature_revise` で基準を直してから続けます。
  - 止まった引き継ぎの放棄も、`agentApprovals` に `handoff-abandon` があれば確認画面なしで行われます（結果の `data.agentAbandoned`）。
- GitHubの変更は、すべてpi-ghの公開ツールを経由します。pi-ghの承認と許可の検査は毎回通ります。pi-scaffoldは許可ファイルを作成も有効化もしません。
- 結果が `partial` / `unknown` のときは、同じoperationIdで呼び直します。新しいoperationIdで再投稿して回避しません。
- `CAPABILITY_MISSING`（pi-ghの機能不足）のときは、直接ghやAPIで迂回しません。道具の再読み込みなどで回復を試し、直らなければ Issue と最終報告に記録して、その操作に依存しない作業を進めます。
- 前提にしている本文が古いと（`STALE_BODY` / `STALE_REVISION`）、Epicを読み直してから、最新の `expectedRevision` / `expectedBodySha256` で呼び直します。

## 工程ごと

1. **setup**
   - `scaffold_labels_ensure` を実行します。
   - `scaffold_epic_draft_create` で、依頼をそのまま記録します（要件は補いません）。
   - `scaffold_handoff_specification` で、仕様策定セッションへ渡します。
2. **specification**
   - ヒアリングで確定したことだけを `scaffold_specification_update` に入れます。未回答の項目は `answer: null` のまま残します。
   - 調査は `scaffold_research_begin` → 調査 → `scaffold_research_resolve` の順に進めます。根拠を示せない結果は `needs-more-work` にします。
   - 仕様がそろったら `scaffold_handoff_basic_design` を呼びます（`agentApprovals` に `specification` があれば、呼んだ時点で親エージェントの仕様承認として記録されます）。
3. **basic-design**
   - 設計書をコミットします。
   - `scaffold_feature_create` で、Featureを1件ずつ作ります。
   - `editScope` には、リポジトリ相対のディレクトリ・ファイル・glob を書きます（例: `src`、`src/a.ts`、`src/**/*.ts`）。ルート（`.`）も書けます。空・絶対パス（`/`）・`..`・バックスラッシュ・制御文字・末尾がドットか空白の区切りは、`UNKNOWN_SCOPE` で作成前に止まります。
   - glob は、互いに重ならないと示せない限り、同じWaveでは競合とみなされます。並行させたいFeatureは `src/a/**` と `lib/**`、`src/**/*.ts` と `src/**/*.css` のように、重ならないと分かる形で書きます。共有のmanifest・stateは、ディレクトリと同じく、globに合う実在ファイルと、固定部分（`db/migrations/**`）や末尾の名前（`**/package.json`）で判定されます。ルート（`.`、`**`）は何とでも重なります。作成後の合格基準・設計の参照は `scaffold_feature_revise` で直せます（editScope は直せません）。
   - `scaffold_dependencies_apply` で、全Featureの依存を登録します。このとき **`design`（設計書の path / sha256 / コミット）を必ず渡します**。Epicに設計書の参照が無いと、実装工程へは引き継げません（`DESIGN_UNSET`）。
   - Wave計画（`plan`）には `dependencyDigest` と `featureSetDigest` が必要です。**先に `scaffold_waves_verify` を呼んで digest を得ます**（`plan` なしで呼べば、計画が未保存でも `data` に2つが返ります）。`scaffold_dependencies_apply` の結果の `dependencyDigest` も同じ値です。digest を自分で計算したり、パッケージの内部を読んだりしません。
   - 返った digest を入れた計画を `scaffold_waves_verify` で確かめ、`scaffold_waves_apply` で反映します。`dependencyDigest` が null（`DEPENDENCY_PLAN_UNSET`）なら、先に依存を登録します。
   - `scaffold_handoff_implementation` を呼びます（`agentApprovals` に `implementation-start` があれば、呼んだ時点で親エージェントの実装開始の指示として記録されます）。
4. **implementation**
   - 実装とテストは、承認された担当が別に行います。
   - 統合コミットとAC別の証拠（`evidence/`の下のレポートとログ）がそろったら、`scaffold_handoff_verification` を呼びます。Epicは閉じません。
   - 仕様の意図を変える必要が分かったら、`scaffold_specification_revise` で改訂し、Blocked になった Feature を `scaffold_feature_revise` で直してから続けます（基本設計・検証の工程でも同じ）。
5. **verification**
   - 最終の証拠を用意します。
   - `verifiedRef` がoriginの既定ブランチに含まれていることを確かめます。手元に無ければ、自分で `git fetch` します（merge / push はしません）。
   - `scaffold_epic_complete` を呼びます（`agentApprovals` に `epic-completion` があるときは、確認画面は出ず、呼んだ時点で親エージェントの受け入れとして記録されます）。
   - `scaffold_epic_complete` は、Epic の木（Feature・Task）に開いている Issue があると `TREE_ISSUES_OPEN` で止まります。先に Feature・Task を閉じてから呼び直します。
   - 完了すると、Epic に記録された Project（`scaffold_dependencies_apply` の `projectId` で記録したもの）を閉じます。閉じるのは、Epic を閉じた後で、この repo に紐付いていて、中身がこの Epic の木の閉じた Issue だけの Project です。別の repo の sub-issue は木に含めません（開いていても止まりません）。確認画面に、閉じる Project が出ます。
   - 結果の `projectsClosed` は閉じた Project、`projectsSkipped` は閉じなかった Project と理由です。`not-recorded` は Epic に Project が記録されていない、`foreign-items` は Project に別の Issue や Issue 以外の項目が入っているので閉じなかった、`not-linked` は Project がこの repo に紐付いていないので閉じなかった（pi-gh は紐付いた Project しか閉じません）、という意味です。どれも完了の失敗ではありません。`foreign-items`・`not-linked` の Project は、必要なら人が手で閉じます。`projectsClosed` には、結果を返す時点で閉じていると読めた Project だけが入ります。
   - Project を閉じる途中で失敗したら、完了は止まります（`pendingStep` が `project-close`、`PROJECT_UNREADABLE`・`PROJECT_ITEMS_OPEN`・`PROJECT_NOT_CLOSED`）。原因を直し、同じ `operationId` で呼び直すと続きから進みます。
   - 記録した Project が消された、または読めない（`PROJECT_UNREADABLE`）とき、`projectIds` から ID を外すツールはありません。Epic を閉じる前に止まった場合は、呼び直すと検査からやり直すので、人が読む権限を戻す（`gh auth refresh -s project` など）か、Epic の管理ブロックの JSON から ID を手で消します（2スペースの整形を崩すと `DOC_PROJECTION_MISMATCH` で止まります）。Epic を閉じた後に止まった場合は、Epic の完了はもう反映済みです。呼び直しは承認時に記録した計画を使うので、管理ブロックを直しても進みません。人が権限を戻すか、残りの Project を手で閉じて、呼び直しはやめます。

登録されているツールは、受け入れ済みのものだけです。登録されていない操作は、まだ提供されていません。
