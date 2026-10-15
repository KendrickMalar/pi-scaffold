# Feature親子接続のunknown復旧 修正計画

> 作成：2026-10-15。出所：feature-create/lifecycleの実装、停止中操作の読取結果。目的：接続成功後の応答不明を同じoperationIdで安全に復旧する。
> 実行担当：親が直接TDDで実装し、最後に独立レビューを行う。

## 1．結論・仕様

接続済みでもattachステップがrequested/unknownなら、既存run.writeの読戻し照合へ必ず到達させます。lifecycleのunknown保護は弱めません。実GitHub・実台帳・ロード中パッケージは変更しません。

## 2．制約

- 対象：src/services/feature-create.ts、test/feature-create.test.ts。
- 基準：c01dbca7994edc19dd195f1ec8fad1fd3be72af3。
- Issue再作成・成功済み接続の再送0。確認不能はunknown維持。
- 専用worktreeだけ変更。依存/cache/TMPDIRもその中。
- fixtureの自動削除だけ承認済み。実台帳や記録は削除しない。
- distを削除する既存buildは使わず、tsc直接で上書き。
- commit/push/merge/現行パッケージ反映・ゲーム再開は別の境界として扱う。

## 3．レビュー重点

1. 接続実施済み＋unknown：同IDでapplied、submit/attach各1回。
2. 接続未実施＋unknown：読戻し後だけ再試行、submit増加0。
3. 親子一覧取得不能：unknown維持、後続操作の安全停止維持。
4. requestedとunknownの両状態、3回目noop、後続別Featureの再開。
5. 本文/ラベル/親子の既存整合検査を維持し、実台帳を手修正しない。

## 4．Task 1：再現→修正→検証

対象ファイル：上記2件。入力は既存createFeature/OperationRun、出力は既存ScaffoldResult。新APIなし。

- [ ] FakePiGhでgh_subissue_addの実変更後にunknownを返すテストを追加。
- [ ] 同operationId再開でapplied/parentAttached=true、submit/attach各1回、再々実行noop、別FeatureがWORKFLOW_UNRESOLVEDにならないことをassert。
- [ ] tscでcore/testを生成し、対象テストがRECONCILE_REQUIRED付きunknownで失敗することを確認（RED）。
- [ ] attachにpending requested/unknownがあるときも既存run.writeへ進む最小修正。
- [ ] 接続未実施unknown・一覧取得不能もテストし安全境界を固定。
- [ ] 対象テストGREEN、全テストと型検査を実行。
- [ ] 全差分を独立レビューし、必要な修正はRED→GREENで検証。

検証コマンド（worktree内、TMPDIR=.verification/tmp）：

```sh
./node_modules/.bin/tsc -p tsconfig.core.json
./node_modules/.bin/tsc -p tsconfig.test.json
node --test --test-timeout=60000 dist/test/feature-create.test.js
node --test --test-timeout=60000 dist/test/*.test.js
./node_modules/.bin/tsc --noEmit -p tsconfig.test.json
./node_modules/.bin/tsc --noEmit -p tsconfig.extension.json
```

合格基準：再現RED→GREEN、全検査exit0。新規fixtureは合成GitHub/合成HOMEだけを使い、実リポジトリのremote操作0。

## 5．未解決・次の境界

- [ ] 検証済み修正版の現行Profile反映方法・承認。
- [ ] 正式ツール経由で停止中F013を同じoperationIdで復旧する承認。
- 実装未実施時点の計画。テスト結果は.verificationへ記録し、完了報告で提示する。
