# TBD を scaffold の仕組みに入れる（＋ walkthrough は TBD を作る）

## Context
- 今: 会話（依頼）→ setup（Epic 下書き作成）→ spec。依頼を残す記録が無い。Epic の前段は Looper の TBD（`KendrickMalar/Looper` に集約、`repo:` ラベルで対象指定）だけで、scaffold 外。
- 欲しい: scaffold が setup の前に必ず TBD を作る。TBD は対象リポジトリの Issue。walkthrough は会話→要望をまとめて TBD 下書きを作って止まる。Looper・Moja も対象リポジトリの TBD を読む。
- 前回の walkthrough ブランチ（Epic 下書きを作る版）は、TBD 版に作り直す。

## 決定事項
| 論点 | 決定 |
|---|---|
| 置き場所 | **対象リポジトリの Issue、ラベル `Scope: TBD`**（人） |
| 直接 scaffold を頼んだとき | **TBD を作ってそのまま setup→spec へ続ける**（人） |
| walkthrough | **TBD を下書き（ready なし）で作って止まる**。エージェント（`agent:*`）は**作るときに選ぶ**（人） |
| jig | **今のまま**（TBD を作らない）（人） |
| Looper・Moja | **今回まとめて切り替える**（人） |
| TBD の中身 | 本文は人が読む文章。walkthrough が作るときだけ管理ブロック（`kind: "tbd"`: originalRequest・background・initialFacts・research・epicIssue）を添える。Moja 起票は本文だけ（AI 判断） |
| Epic との結び | setup が TBD から Epic を作る（管理ブロックがあれば facts 等を引き継ぐ、無ければ本文を originalRequest）。Epic の `originalRequest.sourceRefs` に TBD の URL（Looper の今の Epic 検出と互換） |
| TBD を閉じる人 | **scaffold**（`scaffold_handoff_specification` 成功時に、Epic へのリンクをコメントして閉じる）。Looper は「閉じてリンクあり」を done と読む（AI 判断） |
| 実行中の見分け | TBD 管理ブロック／コメントに Epic 番号があれば running（Moja に「始める」を出さない）（AI 判断） |
| 新規プロジェクト | リポジトリが無ければ、TBD の前にリポジトリ作成・ラベル用意を行う（今の setup 手順2〜4を前へ）（AI 判断） |
| TBD の識別 | Looper・relay・Moja とも `owner/name#番号`（URL）。番号だけの前提をやめる（AI 判断） |
| 旧 TBD | Looper リポジトリに開いた TBD は 0 件（2026-11-17 確認）。旧置き場所の読み取りは残さない（AI 判断） |

## 段階と作業（この順。各段階は別ブランチ・worktree、TDD）

### 1. deterministic-scaffold（`~/Documents/Github/pi-scaffold`）0.13.0
- `contracts.ts`: `kind: "tbd"`（`TbdDocV1`）を `decodeScaffoldDoc` に追加。Epic に任意キー `sourceTbd?`（前例 `specRevisions?` `contracts.ts:83-87`）。
- `labels-v1.json`＋`label-policy.ts`: `Scope: TBD`（`FIXED_LABEL_NAMES` と順序一致。件数 211 の試験・説明・README を更新）。
- 新ツール `scaffold_tbd_create`（`extensions/tools/` → `register-tools.ts`）: `epic-draft.ts` の型を流用（operationId 冪等・`gh_issue_validate`→`gh_issue_submit`・読み戻し）。引数 title・body・任意の originalRequest/background/initialFacts/research。ラベル `Type: Scaffold`＋`Scope: TBD`。
- `scaffold_epic_draft_create` に `tbdIssue?`: TBD を読み、管理ブロックを引き継ぎ、`sourceTbd`・sourceRefs を記録、TBD 管理ブロックへ epicIssue を書く。
- `scaffold_handoff_specification`: `sourceTbd` があれば TBD にリンクのコメント＋`gh_issue_close_if_current`（`run.write`＋reconcile）。
- 試験: `test/tbd-create.test.ts`（`epic-draft.test.ts` を手本）、epic-draft・handoff の追加ケース、`scripts/test-native-pi.py` のツール一覧。
- claude-scaffold: vendor tgz 差し替え、`test/host.test.ts:47`（17→18）。

### 2. scaffold-profiles（今の `feat/walkthrough-skill` を作り直す）
- 前回の setup・orchestrator の「setup の Epic を受け取る」直しを外す。
- `scaffold/SKILL.md`: 工程表に「0 TBD」。入口は「依頼」か「TBD <URL> を入口に」。
- `references/setup.md`: 手順の頭に TBD 作成（`scaffold_tbd_create`）。TBD が入口なら作らない。`scaffold_epic_draft_create` に `tbdIssue`。箱・relaunch（`parts/setup-box.md:76`、`parts/relaunch-in-new-session.md:11`）は TBD の URL を渡す。
- walkthrough: 出力を `scaffold_tbd_create`（下書き）に。最後に TBD ごとに agent を聞き、`gh_labels_apply`（label-create-many＋issue-labels。orchestrator の plan-pending と同じ型）で `agent:*`（任意 `profile:*`）を付ける。続け方は Moja/`looper tbd start`、または「scaffold で TBD <URL> を入口に」。
- orchestrator: Epic なしの要望は各タブの scaffold が TBD を作る（手順は変えず、Epic 探しに TBD の URL を使えることを足す）。
- `config/versions.yml`・`vars.pi.yml` の source を 0.13.0 へ。生成・写し・試験。

### 3. Looper（`~/Code/Looper`）
- 設定 `looperRepo` → `owners`（既定 `["KendrickMalar"]`）。一覧は `gh search issues --owner … --label "Scope: TBD"`（ready・claimed・needs-attention）。
- `Tbd`/`TbdView`/`Entry`/通知 noticeId/エージェント名/タブ名を `repo#番号` に。`repo:` ラベル廃止（Issue のリポジトリ＝対象）。
- 起動の指示を「scaffold スキルで、TBD <URL> を入口に始めてください」に。done 判定は「scaffold が閉じ、Epic リンクあり」（`closeHandedOff` は既に閉じていれば何もしない）。
- `looper tbd add` は対象リポジトリに起票（`Scope: TBD`・`agent:` 等のラベルを `--force` で用意）、`start` は URL（または repo＋number）を受ける。
- 試験: `tests/domain/tbd*.test.ts`、`tests/application/{tick,tbd-commands*}.test.ts`、`tests/infrastructure/gh-tracker.test.ts`、`support/world.ts`。README の契約・design.md を更新。

### 4. muxy-ask-relay ＋ Moja（`~/Code/muxy-ask-relay`、`ios/`）
- RPC `tbdStart` の引数を `{url}`（または `{repo, number}`）に、`Tbd` の識別を URL に。`protocol/vectors/tbd.json`・`validate.ts`・`looper/parse.ts`。
- Moja: `Tbd.id`、`LooperDestination.tbd`、`TbdDetailView`・`TbdRow` の識別子、`LooperStore` の保存キー版上げ（v2）。
- 試験: relay の `tests/protocol/tbd-contract.test.ts` ほか、Moja の `TbdContractTests`・`Looper*Tests`・UI テスト（**実機 iPhone で**。シミュレーター不可）。

## 検証（通し）
- 各リポジトリの `npm test`（Looper は vitest、Moja は実機の xcodebuild test）。
- `scaffold-e2e-sandbox` で:
  1. scaffold に直接依頼 → TBD 作成 → Epic（`sourceTbd`）→ spec へ引き継ぎ時に TBD が閉じてリンク。
  2. walkthrough → TBD 下書き2件（agent ラベル付き、Looper に拾われない）→ Moja で「始める」→ Looper（Mac mini）が拾い TBD を入口に scaffold → Epic → TBD 閉じ → Moja で done。
  3. orchestrator に要望2件 → 各タブで TBD→Epic。
- 証拠は tmp 外へ残す。

## 注意
- 計画時の Exa 調査は、この環境に Exa ツールが無いため未実施。
- Mac mini は main を自動で取り込む（記憶）。各段階を main へ入れたら Mac mini の版もそろえる。Looper は Mac mini で常駐。
- マージ・push は各段階で人に確認。

## 残る質問
- なし（細部は各段階の設計書で決めて記録）。

## 段階1（deterministic-scaffold）での改訂（2026-11-17、実装前の調査から）
| 論点 | 決定 | 理由 |
|---|---|---|
| TBD を閉じる時点 | **`scaffold_epic_draft_create` が TBD から Epic を作れたとき**（計画の「handoff_specification 成功時」から変更） | TBD の役目は Epic になること。引き継ぎ（タブ生成）の仕組みに手を入れずに済む。Looper は Epic 本文の TBD URL で Epic を見つけるので互換 |
| TBD へのコメント | 付けない | deterministic-gh にコメントの道具が無い。Epic の参照資料（sourceRefs）に TBD の URL を載せる |
| 管理ブロックの無い TBD | 読める（Moja・Looper が作るもの）。Epic の originalRequest は「題＋本文」 | 人が GitHub で直接作る TBD も扱うため |
| Epic の任意キー | `sourceTbd`（TBD の番号）。表示には出さない（参照資料に URL が出る） | `projectIds` と同じ扱い |
| 発行テンプレート | `scaffold-tbd-v1`（kind parent、役割 planner） | Epic と同じ発行経路（validate→submit→読み戻し） |
