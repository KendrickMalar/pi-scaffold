# Epic の完了時に Project を閉じる設計

- 作成日: 2026-10-29
- 目的: `scaffold_epic_complete` で Epic を閉じるとき、その Epic のために作った GitHub Project も閉じる。完了した Epic の Project が open のまま溜まらないようにする。

## 1. 背景

- scaffold は基本設計の工程で、Epic ごとに Project を1つ作る（AI が `gh_project_create` で作り、`scaffold_dependencies_apply` の `projectId` に渡して Feature を入れる）。名前は「<リポジトリ> — Epic N」。中身は Feature と Task で、Epic 自身は入っていない。
- Epic と Project の対応は、どこにも記録されていない。`scaffold_dependencies_apply` は `projectId` を受け取るが、保存しない。
- `scaffold_epic_complete` は、任意の `project`（`projectId`・`itemId`・`statusFieldId`・`doneOptionId`）で Project の項目を Done にできる。ただし Project を閉じる処理は無い。
- その結果、Epic が閉じても Project は open のまま残る。2026-10-29 時点で `KendrickMalar` の open な Project は7つあり、そのうち4つは Epic が閉じ済みで中身も全部 Done だった。7つとも同日に手で閉じた。
- pi-gh には Project を閉じる操作が無い。`gh_project_get` は Project の `closed` を返さず、`gh_project_items` は Issue の open/closed を返さない。

## 2. 決定事項

| 論点 | 決定 | 理由・補足 |
|---|---|---|
| 当該 Project の決め方 | **Epic の管理ブロックに Project の ID を記録し、それを使う**（人が決定） | 管理ブロックは scaffold が digest で守る正本。名前や Project の説明文は誰でも書き換えられるので、判断に使わない |
| 記録する時点 | **`scaffold_dependencies_apply` が `projectId` を受け取ったとき**（筆者の判断） | 同じ処理の中で Epic の本文も書いているので、書き込みが増えない |
| 閉じる条件 | **中身がすべてその Epic の Issue（Epic・Feature・Task）で、すべて閉じている Project だけを閉じる**（人が決定） | 手で別の Issue を足された Project や共有ボードを閉じない |
| 記録が無い Epic | **閉じずに、結果に「記録が無いので閉じなかった」と書く**（人が決定） | この改修より前に基本設計を終えた Epic（KnoudeCode#1・launchd-manager#31 など）。人が手で閉じる |
| 閉じる操作の失敗 | **完了を止める（`blocked`）。同じ `operationId` で呼び直すと、閉じ残した Project から続ける**（人が決定） | 片付けまでを完了の条件にする。今の「Project を Done にする」手順と同じ扱い |
| 中身に別の Issue が混ざっている | **閉じない。結果に理由を書く。失敗にはしない**（筆者の判断） | 安全のために閉じないだけで、操作が失敗したわけではない |
| Feature・Task が開いている | **Epic を閉じる前の検査で止める（`blocked`、何も変えない）。対象は Epic の木全体で、Project の記録の無い Epic にも効く**（人が決定、2026-10-29） | 今の完了検査は Feature・Task が閉じているかを見ていない。Epic を閉じた（戻せない）後で止まるのを防ぐ。完了の条件が1つ増える |
| 既に閉じている Project | **何もしない。閉じた扱いで結果に載せる**（筆者の判断） | 再実行や、人が先に閉じた場合に止まらない |
| 閉じる順番 | **Epic を閉じる → 任意の `project` を Done にする → 記録した Project を閉じる**（筆者の判断） | 完了の検査に通らなければ何も閉じない。Done にする手順は閉じる前に行う必要がある |
| 承認画面 | **閉じる予定の Project と、閉じない Project とその理由を表示する**（筆者の判断） | 最終受け入れの対象に、片付けの中身も含める |
| 既存の `project` 引数 | **そのまま残す**（筆者の判断） | 使っている呼び出し元を壊さない |
| Project の説明文に Epic の URL を書く | **今回は入れない**（筆者の判断） | 表示のためだけで、pi-gh に Project を更新する操作が別に要る。後回しにする |
| Project の削除 | **しない** | 閉じれば中身が残り、`--undo` で開き直せる |
| repo に紐付いていない Project | **閉じない。結果に `not-linked` と書く。失敗にはしない。実行時にも紐付きを読み直し、承認後に外れたものも `not-linked` にする**（2026-10-29 改訂） | pi-gh の `project-close` は紐付いていない Project を拒否する。Epic を閉じた後に拒否されて、再開しても進まなくなるのを防ぐ。人が手で閉じる |

## 3. 動作

### 3.1 記録する（`scaffold_dependencies_apply`）

- `EpicDocV1` に任意のキー `projectIds?: string[]` を足す。古い Epic には無い（`specRevisions` と同じ扱い）。値は `PVT_…` の Project の node ID で、重複させない。
- `scaffold_dependencies_apply` が `projectId` を受け取り、Feature を Project に入れ終えたら、その ID がまだ無ければ `projectIds` に足して Epic の本文を書く。同じ Epic で別の `projectId` を渡されたときは、追加して両方を残す。
- `projectIds` は、`designDigest`・`dependencyPlanDigest` など既存の digest に含めない。既存の Epic の digest を変えないため。
- 管理ブロックの外の見える本文に「Project」の行を出すかどうかは、作る側に任せる。

### 3.2 閉じる（`scaffold_epic_complete`）

前の検査（承認画面を出す前）:

1. Epic の `projectIds` を読む。無い、または空なら、閉じる対象は無しとする（結果に `not-recorded`）。
2. Epic の木を求める。Epic 自身と、その sub-issue（Feature）、さらにその sub-issue（Task）の Issue 番号の集合とする。リポジトリは `input.repo` だけとする。
3. 記録した Project ごとに、Project（`closed`）と全項目を読む。
   - 既に閉じている → `already-closed`。
   - repo に紐付いていない → 閉じない（`not-linked`）（2026-10-29 改訂）。
   - Issue でない項目（PR・下書き）がある、または別リポジトリの Issue か、木に無い Issue がある → 閉じない（`foreign-items`）。
   - Project を読めない → `blocked`（`PROJECT_UNREADABLE`）。
4. Epic の木のうち Epic 以外（Feature・Task）が1つでも開いていれば、何も変えずに `blocked`（`TREE_ISSUES_OPEN`、開いている番号を載せる）。Project の記録の有無に関わらず行う。
5. 承認画面に、閉じる予定の Project と、閉じない Project とその理由を出す。

実行（Epic を閉じ、任意の `project` を Done にした後）:

6. 閉じる予定の Project ごとに、もう一度項目を読む。前の検査の後に木に無い項目が増えていれば、閉じずに `foreign-items` とする。木の Issue が開き直されていれば `blocked`（`PROJECT_ITEMS_OPEN`）。
7. `gh_project_close` で閉じ、読み戻して `closed` を確かめる。journal の手順名は `project-close:<projectId>` とし、reconcile は読み戻しで判定する。読み戻せなければ `blocked`（`PROJECT_NOT_CLOSED`）。
8. 再開（Issue を閉じた後の再実行）では、閉じ残した Project の手順だけを行う。今の `pendingStep` の考え方に `project-close` を足す。

結果の `data` に、次を足す。

- `projectsClosed: string[]`：閉じた Project（既に閉じていたものを含む）
- `projectsSkipped: {projectId: string | null; reason: 'not-recorded' | 'foreign-items' | 'not-linked'}[]`：閉じなかった Project と理由

### 3.3 pi-gh に足すもの

- 書き込み操作 `gh_project_close`。変更ファイルは `{version: 1, repo, operation: 'project-close', projectId}`。GraphQL の `updateProjectV2(input: {projectId, closed: true})` を使う。
- pi-gh の書き込み許可の集合（`src/permissions.ts` の `allowed`）に足す。足さないと `agentApproval` でも拒否される。
- 許可の判定は、ほかの Project 操作（`gh_project_field_update`）と同じにする。実際に通る道筋は `agentApproval` である（`projectIds` の無いワイルドカード grant は、`projectId` 付きの操作を通さない。builder check で確認、2026-10-29）（筆者の判断）。
- 閉じる前に、その Project が変更ファイルの `repo` にリンクされていることを、既存の `projectReposQuery` で確かめる。リンクされていなければ拒否する（筆者の判断）。`agentApproval` は `projectId` を見ないので、同じ持ち主の別の Project を閉じない歯止めを pi-gh 側にも置く。scaffold の Project は `gh_project_create` が repo にリンクして作る。
- `gh_project_get` の結果に `closed` を足す。
- `gh_project_items` の Issue に `state`（OPEN/CLOSED）を足す。
- 版を上げる。

### 3.4 配る

| 場所 | 変えるもの |
|---|---|
| pi-gh（`~/Documents/Github/pi-gh`） | 3.3 の操作・読み取り、テスト、版 |
| pi-scaffold（`~/Documents/Github/pi-scaffold`） | 3.1・3.2、ツールの説明文、`resources/skills/scaffold-stage/SKILL.md`、README の表、テスト、版、依存する pi-gh の版 |
| claude-scaffold（`~/Documents/Github/claude-scaffold`） | `vendor/` の pi-gh・pi-scaffold の tgz と `package.json` |
| scaffold-profiles（`~/Code/scaffold-profiles`） | `config/versions.yml`、`vendor/` の tgz、`config/permissions.yml`（ワイルドカードの grant の一覧に `gh_project_close` を足す。許可の判定には効かず、使う操作の一覧として揃えるため）、`src/profile/skills/scaffold/references/tests.md`（手順6・7に Project を閉じることと結果の読み方を書く）、生成物 `dist/` |
| pi の実行環境 | `~/.pi/local-packages/` に新しい版を置き、`bin/install-config.sh` で許可ファイルを入れ直す |

## 4. 検証と合格基準

- pi-gh の単体テスト：`gh_project_close` の変更ファイルの検査、許可の判定、`closed`・`state` の読み取り。
- pi-scaffold の単体テスト：次の場合がそれぞれ期待どおりになる。
  - 記録あり・中身が全部木の Issue で閉じている → 閉じる
  - 既に閉じている → 閉じた扱い、書き込みなし
  - 別の Issue が混ざっている → 閉じない、`foreign-items`、完了は `applied`
  - 記録なし → 閉じない、`not-recorded`、完了は `applied`
  - 閉じる操作が失敗 → `blocked`、同じ `operationId` の再実行で閉じ残しだけ閉じる（Issue を二度閉じない）
  - Feature か Task が開いている → Epic を閉じる前に `blocked`、何も書き込まない（記録の無い Epic でも同じ）
  - `scaffold_dependencies_apply` が `projectIds` を記録し、重複させず、既存の digest を変えない
- 既存テスト（2026-10-29 時点で 991件）がすべて通る。`npm run typecheck` が通る。
- 実機：`scaffold-e2e-sandbox` で小さな Epic を1つ通し、完了後に `gh project list --owner KendrickMalar --closed` にその Project が出ることを確かめる。Claude 版・pi 版の両方で行う。

## 5. やらないこと

- 記録の無い既存の Epic へ、`projectIds` をさかのぼって書く。
- Project を削除する。Epic を開き直したときに Project も開き直す。
- Project の説明文に Epic の URL を書く（後回し、2026-10-29）。
- 複数の Epic をまたぐ並列実行計画用の Project（scaffold-orchestrator 側の話）。

## 6. 作る側に任せること

- `projectIds` の正確なキー名と、見える本文での表示。
- エラーコードの名前（上の名前は仮置き）。
- Epic の木の求め方（`gh_subissues_list` を2段たどるなど）と、上限の扱い。
- pi-gh・pi-scaffold の新しい版番号。

## 7. リスク

| リスク | 影響 | 対策 |
|---|---|---|
| 古い版の pi-scaffold は、管理ブロックに知らないキーがあると `UNKNOWN_FIELD` で止まる | 新しい版が `projectIds` を書いた Epic を、古い版の工程セッションが読めなくなる | pi・Claude の両方の実行環境を同時に入れ替える。入れ替えるときに動いている scaffold の工程セッションが無いことを確かめる |
| 閉じてはいけない Project を閉じる | 共有ボードが一覧から消える | 記録した ID だけを対象にし、中身が全部その Epic の Issue であることを確かめる。閉じても `--undo` で戻せる |
| Project の項目の反映が遅れる（2026-10-18 に `project-add` の検証が初回 unknown になった例がある） | 読み戻しで閉じたことを確かめられない | journal の reconcile で読み直し、決まらなければ `blocked` にして再実行で続ける |
| 許可ファイルの入れ直し漏れ | `gh_project_close` が拒否される | 完了が `blocked` になるので気づける。配る手順に `install-config.sh` を入れる |

## 8. 残る空白

- （解決、2026-10-29）`gh_project_close` は `agentApproval` で通す。ワイルドカード grant だけでは通らない（3.3）。
- 今の `scaffold_epic_complete` は、Feature・Task が閉じているかを検査していない（builder check で確認、2026-10-29。`src/core/completion-gate.ts` は証拠と要件だけを見る）。
