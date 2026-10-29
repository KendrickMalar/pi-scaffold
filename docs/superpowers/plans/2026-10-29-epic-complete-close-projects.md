# Epic の完了時に Project を閉じる 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `scaffold_epic_complete` が、Epic に記録した Project を、中身がすべてその Epic の閉じた Issue のときだけ閉じるようにする。あわせて、Feature・Task が開いていれば Epic を閉じる前に止める。

**Architecture:** pi-gh に Project を閉じる書き込み操作と、`closed`・Issue の `state` の読み取りを足す。pi-scaffold は `scaffold_dependencies_apply` で Epic の管理ブロックに `projectIds` を記録し、`scaffold_epic_complete` が前の検査で閉じる予定を決めて承認画面に出し、journal に残して実行・再開する。配布は claude-scaffold と scaffold-profiles の tgz・版・手順書を差し替える。

**Tech Stack:** TypeScript（Node 26、`node --test`）、GitHub GraphQL（Projects V2）、pi-gh の変更ファイル方式、npm pack の tgz。

**Spec:** `docs/superpowers/specs/2026-10-29-epic-complete-close-projects-design.md`（pi-scaffold、コミット 94b532d）

## Global Constraints

- 閉じる GraphQL は `updateProjectV2(input: {projectId, closed: true})`（2026-10-29 にスキーマのイントロスペクションで `UpdateProjectV2Input.closed: Boolean`、`ProjectV2.closed` を確認）。
- `projectIds` は任意キー。古い Epic には無い。`PVT_[A-Za-z0-9_-]{1,200}` に合う文字列で重複なし。既存の digest（`designDigest`・`dependencyPlanDigest`・`specificationDigest`）に含めない。
- 結果の `data` に `projectsClosed: string[]` と `projectsSkipped: {projectId: string | null; reason: 'not-recorded' | 'foreign-items'}[]` を足す。
- `pendingStep` に `'project-close'` を足す。journal の手順名は `project-close:<projectId>`、閉じる予定は `run.note('projects-plan', {close: string[], skipped: …})` に1回だけ残す。
- エラーコード: `TREE_ISSUES_OPEN`（Epic を閉じる前）、`PROJECT_UNREADABLE`（既存）、`PROJECT_ITEMS_OPEN`、`PROJECT_NOT_CLOSED`。
- pi-gh の新しい操作名は `gh_project_close`、変更ファイルの `operation` は `'project-close'`、キーは `version`・`repo`・`operation`・`projectId` だけ（`issue` なし）。
- 版: pi-gh 0.11.1 → **0.12.0**、pi-scaffold 0.7.0 → **0.8.0**（仕様は版番号を作る側に任せている。筆者の判断）。
- 各リポジトリで作業は worktree・feature branch で行い、main へは `git merge --no-ff`。push と実機の入れ替えは人の確認を取ってから。コミットに AI 帰属行を付けない。

## Review Focus

1. **Epic を閉じた後の再開**：閉じる予定は承認時の読み取りで決まる。再開時（`closedByUs`）は前の検査を飛ばすので、journal の `projects-plan` から読む。読み直しで決め直さない → Task 7 のテスト `a resume after a failed Project close closes only the remaining Projects without a second Issue close`。
2. **人が先に Project を閉じた**：既に `closed` なら書き込まずに `projectsClosed` に入れる → Task 7 `an already closed Project is reported closed without a write`。
3. **承認の後に Project へ別の Issue が足された**：実行時の読み直しで `foreign-items` にして閉じない。完了は `applied` → Task 7 `an item added after the acceptance makes the Project skipped, not closed`。
4. **Project に PR・下書きが入っている**：Issue でない項目は木の外として `foreign-items` → Task 6 `a pull request or draft item makes the Project foreign`。
5. **pi-gh が別 repo の Project を閉じようとする**：Project がその repo にリンクされていなければ書き込まずに拒否 → Task 2 `project close refuses a Project not linked to the repo`。

---

## リポジトリと worktree

| リポジトリ | 場所 | ブランチ |
|---|---|---|
| pi-gh | `~/Documents/Github/pi-gh` | `feat/project-close`（新規 worktree を `~/.config/superpowers/worktrees/pi-gh/project-close` に） |
| pi-scaffold | `~/.config/superpowers/worktrees/pi-scaffold/epic-complete-close-projects` | `feat/epic-complete-close-projects`（作成済み、ベースライン 991件合格） |
| claude-scaffold | `~/Documents/Github/claude-scaffold` | `feat/pi-scaffold-0.8.0`（新規 worktree） |
| scaffold-profiles | `~/Code/scaffold-profiles` | `feat/project-close`（新規 worktree） |

---

### Task 1: pi-gh の読み取りに `closed` と Issue の `state` を足す

**Files:**
- Modify: `src/github-api.ts:6-7`（`projectFieldsQuery` の ProjectV2 に `closed`、`projectItemsQuery` の `... on Issue` に `state`）、`src/github-api.ts:33-40`（`project()` の戻り値に `closed` を含める。`kind==='fields'` のとき）
- Test: `test/operations.test.mjs`、必要なら `test/github-fixture.mjs`（fixture の Project に `closed`、items の Issue に `state` を持たせる）

**Interfaces:**
- Produces: `gh_project_get` の `data` = `{id, title, closed: boolean, fields}`。`gh_project_items` の各 item の `content` が Issue のとき `{__typename:'Issue', id, number, state: 'OPEN'|'CLOSED', repository:{nameWithOwner}}`。

- [ ] **Step 1: 失敗するテストを書く**：`test('project get returns closed and items carry Issue state', …)`。fixture の Project を `closed:true`、item の Issue を `state:'CLOSED'` にして、`gh_project_get` の `data.closed === true`、`gh_project_items` の `items[0].content.state === 'CLOSED'` を assert する。
- [ ] **Step 2: 失敗を確かめる**：`npm run build && node --test test/operations.test.mjs` → 新しいテストが FAIL。
- [ ] **Step 3: クエリと `project()` を直す**（ページングの判定は既存のまま）。
- [ ] **Step 4: 合格を確かめる**：同じコマンドで PASS、続けて `npm test` 全件 PASS。
- [ ] **Step 5: コミット**：`feat: Project の closed と項目の Issue state を読む`

### Task 2: pi-gh に `gh_project_close` を足す

**Files:**
- Modify: `src/operation-input.ts:6`（`githubWrites` に `'gh_project_close'`）、`:36` 付近（`'project-close':{name:'gh_project_close',keys:['projectId']}`）、`:47`（`issue` の必須から `project-close` を外す）
- Modify: `src/github-api.ts`（`export const closeProjectMutation='mutation($projectId:ID!){updateProjectV2(input:{projectId:$projectId,closed:true}){projectV2{id closed}}}'`）
- Modify: `src/operations.ts`：事前読み取り（`project-close` は fields だけ読み、`closed` なら `s.noop=true`。`api.projectRepos(c.projectId)` に `c.repo` が無ければ `fail('GITHUB_IDENTITY','','Project is not linked to the specified repository.')`）と、実行（`case 'project-close': return api.mutateGraphql(closeProjectMutation,{projectId:c.projectId})`）、実行後の読み戻しで `closed===true`
- Modify: `src/permissions.ts:13`（`allowed` に `'gh_project_close'`）
- Modify: `extensions/tools.ts`（ほかの書き込み操作と同じ登録。`destructiveHint:false`、`idempotentHint:true`）、README の操作一覧
- Modify: `package.json` の `version` を `0.12.0`
- Test: `test/operations.test.mjs`、`test/permissions.test.mjs`、`test/tools.test.mjs`

**Interfaces:**
- Consumes: Task 1 の `project()` の `closed`。
- Produces: ツール `gh_project_close`（引数 `{changePath}`。変更ファイル `{version:1, repo, operation:'project-close', projectId}`）。状態は `applied`（閉じた）／`noop`（既に閉じていた）／`rejected`。

- [ ] **Step 1: 失敗するテストを書く**（すべて `test/operations.test.mjs`）
  - `project close closes a linked Project`：`status==='applied'`、mutation が1回、送った変数が `{projectId:'PVT_demo'}`
  - `project close is a noop for a closed Project`：`status==='noop'`、mutation 0回
  - `project close refuses a Project not linked to the repo`：`status==='rejected'`、`problems[0].code==='GITHUB_IDENTITY'`、mutation 0回
  - `project close refuses extra keys`：`issue` を足した変更ファイルは `rejected`
  - `test/permissions.test.mjs` の agentApproves のループ（20行）に `'gh_project_close'` を足す
  - `test/tools.test.mjs`：`gh_capabilities` の `operations` に `gh_project_close` が含まれる
- [ ] **Step 2: 失敗を確かめる**：`npm test` → 上のテストが FAIL。
- [ ] **Step 3: 実装する**（Files のとおり）。
- [ ] **Step 4: 合格を確かめる**：`npm test` 全件 PASS、`npm run typecheck`（あれば）PASS。
- [ ] **Step 5: コミット**：`feat: gh_project_close で Project を閉じる（0.12.0）`
- [ ] **Step 6: 配布用 tgz を作る**：main へ `--no-ff` で入れた後（push は人の確認後）、そのコミットを `git archive` で取り出して `npm ci --ignore-scripts && npm run build && npm pack`。tgz 名は `pi-gh-<commit先頭8桁>.tgz`、sha256 を控える（scaffold-profiles `vendor/README.md` の手順どおり）。

### Task 3: Epic の管理ブロックに `projectIds` を持てるようにする

**Files:**
- Modify: `src/core/contracts.ts:77-86`（`EpicDocV1` に `projectIds?: string[]`。コメント「Absent until a Project is recorded (older Epics never carry it).」）、`:345-365`（`epic()` で `specRevisions` と同じく任意で読む。パターン不一致は既存の `r.pattern`、重複は `r.unique(…, 'projectIds', 'projectId')`、件数上限 10）。`EPIC_KEYS` の扱いは `specRevisions` に合わせる
- Modify: `src/core/epic-render.ts`（管理ブロックに書き出す。見える本文に「Project: <ID>」の行を足すかは任意。足すなら1行）
- Test: `test/contracts.test.ts`

**Interfaces:**
- Produces: `EpicDocV1.projectIds?: string[]`。

- [ ] **Step 1: 失敗するテストを書く**
  - `an Epic without projectIds still decodes and round-trips unchanged`
  - `projectIds round-trips through render and parse`（`['PVT_a1','PVT_b2']`）
  - `projectIds rejects a non-PVT id and a duplicate`
  - `projectIds does not change designDigest, dependencyPlanDigest or specificationDigest`（同じ doc で `projectIds` の有無を比べて digest が等しい）
- [ ] **Step 2: 失敗を確かめる**：`npm test` → 上が FAIL。
- [ ] **Step 3: 実装する**。
- [ ] **Step 4: 合格を確かめる**：`npm test` 全件 PASS。
- [ ] **Step 5: コミット**：`feat: Epic の管理ブロックに projectIds を持てるようにする`

### Task 4: `scaffold_dependencies_apply` が `projectId` を記録する

**Files:**
- Modify: `src/services/dependencies-apply.ts`（Feature を Project に入れて読み戻した後、`epic.projectIds` に `input.projectId` が無ければ足して Epic 本文を書く。本文を書く条件に「`projectIds` が変わる」を加える。書いたら結果は `applied`）
- Test: `test/dependencies-apply.test.ts`

**Interfaces:**
- Consumes: Task 3 の `projectIds`。

- [ ] **Step 1: 失敗するテストを書く**
  - `a projectId is recorded on the Epic once`：1回目で `docOf(gh).projectIds` が `['PVT_…']`、同じ入力の2回目で本文が変わらず `noop`
  - `a second Project is appended, not replacing the first`
  - `without projectId the Epic gets no projectIds key`
  - `recording projectIds leaves dependencyDigest unchanged`
- [ ] **Step 2: 失敗を確かめる**：`npm test` → FAIL。
- [ ] **Step 3: 実装する**。
- [ ] **Step 4: 合格を確かめる**：`npm test` 全件 PASS。
- [ ] **Step 5: コミット**：`feat: dependencies_apply が Project を Epic に記録する`

### Task 5: Epic の木を読む

**Files:**
- Create: `src/ports/epic-tree.ts`
- Modify: `test/helpers/fake-pi-gh.ts`（`gh_subissues_list` の返す Issue に `state` が無ければ足す。`gh_project_get` に `closed`、`gh_project_items` の Issue に `state`（`'OPEN'|'CLOSED'`）、`gh_project_close` の実装（変更ファイルのキー検査、`closedProjects: Set<string>`、閉じ済みは `noop`）、Issue でない項目を入れるための `projectExtraItems: Map<string, unknown[]>`）
- Test: `test/epic-tree.test.ts`

**Interfaces:**
- Produces: `export interface TreeIssue { number: number; state: 'open' | 'closed'; parent: number | null }` と `export async function readEpicTree(repo: string, epicIssue: number, bridge: PiGhBridge, scope: CallScope): Promise<Decoded<TreeIssue[]>>`。Epic 自身（`parent: null`）、その sub-issue（Feature）、Feature の sub-issue（Task）。別リポジトリの sub-issue は `failed`（`FOREIGN_CHILD`、`feature-set.ts` の判定に合わせる）。

- [ ] **Step 1: 失敗するテストを書く**：`reads the Epic, its Features and their Tasks with state`、`a sub-issue of another repository fails`、`an Epic without Features returns only itself`。
- [ ] **Step 2: 失敗を確かめる**：`npm test` → FAIL。
- [ ] **Step 3: 実装する**（`gh_subissues_list` を Epic に1回、Feature ごとに1回。`state` は REST の `state`）。
- [ ] **Step 4: 合格を確かめる**：`npm test` 全件 PASS。
- [ ] **Step 5: コミット**：`feat: Epic の木（Feature・Task）を読む`

### Task 6: `scaffold_epic_complete` の前の検査（開いた木で止める・閉じる予定を決める・承認画面）

**Files:**
- Create: `src/core/project-close-plan.ts`
- Modify: `src/services/epic-complete.ts:47-125`（前の検査）、`src/core/completion-gate.ts:43-60`（`completionApprovalView` に閉じる予定を渡して表示する）
- Modify: `test/epic-complete.test.ts` の `world()`（Feature を `state:'closed'` にする。今の fixture は Feature が open のまま完了しているので、新しい検査で既存テストが止まるため）
- Test: `test/project-close-plan.test.ts`、`test/epic-complete.test.ts`

**Interfaces:**
- Consumes: Task 5 の `readEpicTree`・`TreeIssue`、Task 1 の `closed`・`state`、Task 3 の `projectIds`。
- Produces:
  - `export interface ProjectClosePlan { close: string[]; alreadyClosed: string[]; skipped: {projectId: string | null; reason: 'not-recorded' | 'foreign-items'}[] }`
  - `export function planProjectClose(projectIds: string[] | undefined, tree: TreeIssue[], repo: string, projects: {projectId: string; closed: boolean; items: unknown[]}[]): ProjectClosePlan`（純関数。Issue でない項目・別 repo・木に無い番号があれば `foreign-items`）
  - `completionApprovalView(…, project?, closePlan?: ProjectClosePlan)`：表示行を足す（例「Project を閉じる: PVT_x」「閉じない: PVT_y（別の Issue が混ざっている）」「Project の記録なし」）

- [ ] **Step 1: 失敗するテストを書く**
  - `test/project-close-plan.test.ts`：`no projectIds gives a not-recorded skip`、`only tree issues of the repo gives close`、`an issue outside the tree makes the Project foreign`、`a pull request or draft item makes the Project foreign`、`an issue of another repo makes the Project foreign`、`a closed Project goes to alreadyClosed`
  - `test/epic-complete.test.ts`：`an open Feature or Task blocks before any change with TREE_ISSUES_OPEN`（`expectBlocked(t, 'TREE_ISSUES_OPEN', …)`。記録の無い Epic でも同じ）、`an unreadable recorded Project blocks before any change`（`PROJECT_UNREADABLE`）、`the acceptance shows the Projects to close and the skipped ones`（承認画面の文字列に ID と理由が出る。閉じる予定が変わると承認の digest が変わる）
- [ ] **Step 2: 失敗を確かめる**：`npm test` → FAIL。
- [ ] **Step 3: 実装する**。必要な道具（`gh_project_get`・`gh_project_items`・`gh_project_close`）は `projectIds` があるときだけ `requireCapabilities` に足す。
- [ ] **Step 4: 合格を確かめる**：`npm test` 全件 PASS（既存の epic-complete テストは `world()` の変更で通る）。
- [ ] **Step 5: コミット**：`feat: epic_complete が開いた木で止め、閉じる Project を承認画面に出す`

### Task 7: `scaffold_epic_complete` の実行（閉じる・読み戻す・再開・結果）

**Files:**
- Modify: `src/services/epic-complete.ts:126-204`（手順4の後に手順5を足す。結果と `pendingStep`）、`src/services/epic-complete.ts:25`（`EpicCompleteData` に `projectsClosed`・`projectsSkipped`）
- Modify: `extensions/tools/epic-complete.ts:13-14`（説明文に「記録した Project を閉じる」）
- Test: `test/epic-complete.test.ts`

**Interfaces:**
- Consumes: Task 6 の `ProjectClosePlan`（承認前に決めたものを `run.note('projects-plan', plan)` で保存。再開では `run.done('projects-plan')` から読む）。

- [ ] **Step 1: 失敗するテストを書く**
  - `a recorded Project whose items are all closed tree issues is closed and read back`：`gh.closedProjects.has(id)`、`data.projectsClosed` が `[id]`、`gh.count('gh_project_close')===1`
  - `an already closed Project is reported closed without a write`
  - `a Project with another Issue is skipped as foreign-items and the completion is applied`
  - `an Epic without projectIds completes with a not-recorded skip and no Project call`
  - `a failed Project close blocks with pendingStep project-close and issueClosed true`
  - `a resume after a failed Project close closes only the remaining Projects without a second Issue close`（`closes(gh)===1`）
  - `an item added after the acceptance makes the Project skipped, not closed`
  - `a tree issue reopened after the acceptance blocks with PROJECT_ITEMS_OPEN`
  - `a close reported applied but not visible is caught by the read-back`（`PROJECT_NOT_CLOSED`）
  - `the optional project Done step still runs before the Projects are closed`
- [ ] **Step 2: 失敗を確かめる**：`npm test` → FAIL。
- [ ] **Step 3: 実装する**。各 Project を `run.write('project-close:<id>', …, {reconcile: 読み戻しの closed})` で閉じる。`run.checkpoint()` を Done の手順と同じ位置で使う。
- [ ] **Step 4: 合格を確かめる**：`npm test` と `npm run typecheck` が PASS。
- [ ] **Step 5: コミット**：`feat: epic_complete が記録した Project を閉じる`

### Task 8: pi-scaffold の文書・版・実機テスト

**Files:**
- Modify: `resources/skills/scaffold-stage/SKILL.md:51` 付近（完了時に Project を閉じること、`projectsSkipped` の読み方、`TREE_ISSUES_OPEN` のときは Feature・Task を閉じてから呼び直すこと）
- Modify: `README.md:49`（表の説明に追記）
- Modify: `package.json` の `version` を `0.8.0`
- Modify: `scripts/test-native-pi.py:558-` と `scripts/test-native-workflow.py:278-286`（実 pi-gh で `gh_project_close` まで通る。fixture は Task 2 の pi-gh を使う）

- [ ] **Step 1: 文書と版を直す**。
- [ ] **Step 2: 確かめる**：`npm test`、`npm run typecheck`、`npm run test:native`（Task 2 の pi-gh tgz を入れた状態で）がすべて PASS。
- [ ] **Step 3: コミット**：`docs: Project を閉じる完了手順を書き、0.8.0 にする`
- [ ] **Step 4: 配布用 tgz を作る**：main へ `--no-ff` で入れた後（push は人の確認後）、Task 2 Step 6 と同じ手順で `pi-scaffold-<commit先頭8桁>.tgz` と sha256。

### Task 9: scaffold-profiles と claude-scaffold へ配る

**Files（scaffold-profiles）:**
- Add: `vendor/pi-gh-<8桁>.tgz`、`vendor/pi-scaffold-<8桁>.tgz`。表 `vendor/README.md` を更新（commit・sha256・作成環境）。旧 `pi-scaffold-56376ba3.tgz`・`pi-gh-ca5f0147.tgz` は `test/old-version-compat.test.ts` が使っていないか確かめてから外す
- Modify: `config/versions.yml`（pi-gh 0.12.0、pi-scaffold 0.8.0、`*-source` を `~/.pi/local-packages/<名前>/<フルcommit>`）
- Modify: `config/permissions.yml`（ワイルドカード grant の `operations` に `gh_project_close  # 2026-10-29 追加（Epic の完了時に Project を閉じる。許可の判定は agentApproval で通る）`）
- Modify: `src/profile/skills/scaffold/references/tests.md`（手順6：`TREE_ISSUES_OPEN` の扱い、Project を閉じること、`projectsSkipped` の `not-recorded` は人が手で閉じる旨を最終報告に書く）、`src/profile/skills/scaffold/references/basic-design.md:78`（`scaffold_dependencies_apply` に渡した Project が Epic に記録されること）
- Regenerate: `dist/`（リポジトリの生成コマンド）

**Files（claude-scaffold）:**
- Modify: `vendor/` の2つの tgz と `package.json:19-20`、`package-lock.json`

- [ ] **Step 1: scaffold-profiles を直し、生成する**。
- [ ] **Step 2: 確かめる**：scaffold-profiles の `npm test`（`old-version-compat` を含む）と生成物の一致検査が PASS。
- [ ] **Step 3: コミット**：`chore: pi-gh 0.12.0・pi-scaffold 0.8.0 に上げ、完了時に Project を閉じる手順を足す`
- [ ] **Step 4: claude-scaffold の tgz を差し替え**、`npm install` 後に `npm test` PASS。MCP のツール一覧に `gh_project_close` が出ることを確かめる（`toMcpTools(host.tools())` を呼ぶ既存テストか、起動して list_tools）。
- [ ] **Step 5: コミット**：`chore: pi-gh 0.12.0・pi-scaffold 0.8.0 を取り込む`

### Task 10: 実行環境への入れ替えと実機確認（人の確認を取ってから）

- [ ] **Step 1: 動いている scaffold の工程セッションが無いことを確かめる**：全 herdr セッションの `herdr agent list` と `ps` で `pi`・`claude-dev` の scaffold セッションを探す。あれば人に伝えて止める。
- [ ] **Step 2: 人に確認する**：4つのリポジトリの push と、`~/.pi/local-packages` の入れ替えの可否を `AskUserQuestion` で聞く。
- [ ] **Step 3: 入れ替える**：`~/.pi/local-packages/pi-gh/<commit>`・`pi-scaffold/<commit>` に置く。scaffold-profiles の `bin/install-config.sh` を実行し、claude-scaffold の `bin/link-profiles` を実行する。
- [ ] **Step 4: 実機で確かめる**：`scaffold-e2e-sandbox` で小さな Epic を1つ、Claude 版と pi 版でそれぞれ通す。合格基準は次のとおり。
  - Epic の管理ブロックに `projectIds` がある
  - 完了後、`gh project list --owner KendrickMalar --closed` にその Project が出る
  - `gh project list --owner KendrickMalar` に残らない
- [ ] **Step 5: 記録する**：ai-secretary の引き継ぎメモとメモリ（`scaffold-orchestrator-skill` の隣に Project 運用の1件）を更新する。

---

## 自己点検の結果

- 仕様の各節と Task の対応：2章の決定事項 → Task 3〜7、3.1 → Task 3・4、3.2 → Task 5〜7、3.3 → Task 1・2、3.4 → Task 8〜10、4章 → 各 Task のテストと Task 10、7章のリスク（古い版の `UNKNOWN_FIELD`）→ Task 10 Step 1。
- 未解決の質問はありません。仕様の「作る側に任せること」は、版番号（0.12.0・0.8.0）、キー名（`projectIds`）、木の求め方（`gh_subissues_list` 2段）、エラー名を、この計画で決めました。
