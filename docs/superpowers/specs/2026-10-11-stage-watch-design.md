# 下位工程セッションの監視（stage watch）設計

- 作成日: 2026-10-11
- 目的: 上位（親）セッションが、自分の引き継いだ下位工程セッションの Herdr pane を定期的に見て、止まっていれば知らせる。一時的な API エラーで止まったときだけ、自動で再開させる。

## 1. 背景

今の `handoffStage`（`src/handoff/driver.ts`）は、下位の `turn-started` 受領を確認した時点で `applied` を返して終わる。その後、下位が動いているか、止まっているか、終わったかを親は見ていない。下位がエラーで止まっていても、人が見に行くまで気づけない。

## 2. 決定事項

| 論点 | 決定 | 理由 |
|---|---|---|
| 監視の仕組み | **親の拡張の中で動く常駐タイマー** | 親の会話を止めずに見られる |
| 判定の情報源 | **Herdr の agent 状態 ＋ 下位の pi セッションログ末尾** | 下位を改修しない。Herdr の pi 連携は API エラーでも `idle` を報告するため、`idle` の理由だけログで見分ける |
| 下位の改修 | **しない** | 親側だけで完結させる |
| 検知後の動作 | **一時的エラーは自動「続けて」、それ以外は通知のみ** | 誤操作の危険を、確実に分かる場合だけに限る |
| 入力待ち（blocked） | **通知のみ。自動で答えない** | 承認は親 TUI だけで行う既存設計を守る |
| 固まり検知・Epic 照合 | **入れない** | 固まりは長いビルドと区別できず誤検知しやすい。工程の進行は次の handoff ツールが確認済み |
| 周期 | **60 秒** | 数分以内に気づければ足りる |
| 自動「続けて」 | **最大 3 回、待ち 1 分 → 5 分 → 15 分** | pi 本体の自動リトライが尽きた後なので、間隔をあけて少数回だけ試す |
| 通知先 | **親 TUI の `ctx.ui.notify` のみ** | 親の会話に差し込まず、コンテキストを消費しない |
| 監視の存続 | **親が開いている間。親の再起動では台帳から再開** | 親を開き直すたびに監視が消えるのを防ぐ |

## 3. 動作

### 3.1 開始と終了

- **開始**: `handoffStage` が `applied`（`turn-started` 済み）を返した直後に、監視台帳へ登録する。登録内容は `ownerSessionId`（引き継いだ親のセッション ID）・`paneId`・`tabId`・`workspaceId`・`targetSessionId`・`cwd`（packet の `cwd`）・`repo`・`epicIssue`・`targetStage`。
- **持ち主だけが監視する**: 台帳は同じ agentDir の全 Pi セッション（親・下位・さらに下位）で共有される。各セッションは `ownerSessionId` が自分のものだけを監視する。下位が次の工程へ引き継げば、その下位が親として監視する。`PI_SUBAGENT_CHILD` のセッションと Herdr 外のセッションは監視しない。（2026-10-11 計画時に追加）
- **再開**: 親の `session_start` で台帳を読み、自分が持ち主の監視を再開する（同じセッションを開き直した場合）。
- **終了**: pane が消えた、または pi が終了してシェルに戻った場合は、通知してから台帳から外す。親の `session_shutdown` ではタイマーだけ止め、台帳は残す。
- 台帳が空ならタイマーは動かさない。`extensions/index.ts` 冒頭の「タイマーは起動しない」というコメントは、この例外を書き足して更新する。

### 3.2 1 回の確認（60 秒ごと、監視対象ごと）

1. `herdr pane get <paneId>` で状態を読む。`pane_not_found` なら「pane が消えた」とする。`agent` が `pi` でなく、`pane process-info` でシェルが前面にあれば「pi が終了した」とする。シェルでもなければ「読めなかった」として扱う（5 章）。
2. 状態ごとの動作は次のとおり。

| 観測 | 動作 |
|---|---|
| pane が消えた / pi が終了した | 通知し、監視を終える |
| `blocked` | 通知（前回も `blocked` なら何もしない） |
| `working` | 予定していた自動再開を取り消す。回数は戻さない（0 に戻すのはターンが正常に終わったときだけ。エラーを繰り返す下位を無限に再開しないため。2026-10-11 改訂） |
| `idle` | ログ末尾を読む（3.3）。結果に応じて下の表 |

| `idle` 時のログ末尾 | 動作 |
|---|---|
| 一時的エラー、かつ回数が 3 未満、かつ待ち時間を過ぎた | 送る直前に再度「`idle` かつ同じエラー記録」を確かめてから、固定文面の「続けて」を `herdr agent prompt` で送る。回数を 1 増やす |
| 一時的エラー、かつ回数が 3 に達した | 「自動再開を 3 回試しましたが止まっています: 〈エラー先頭〉」と通知し、そのエラー記録ではもう送らない |
| その他のエラー | 「止まっています: 〈errorMessage 先頭 120 文字〉」と通知 |
| 中断（`stopReason: aborted`） | 「中断されています」と通知。回数を 0 に戻す |
| エラーでない | 「返事待ちか完了です」と通知。回数を 0 に戻す |
| `unknown`（読めない・形式違い） | 「状態を判定できません（idle）」と通知。自動送信はしない |

3. 通知は、前回通知した内容から変わったときだけ出す。同じエラー記録（同じ `timestamp`）について同じ通知は繰り返さない。

「続けて」の固定文面: `pi-scaffold: 一時的なエラーで止まったため再開します。直前の作業を続けてください。`

### 3.3 ログ末尾の読み方

- 場所: `<agentDir>/sessions/` の下で、ファイル名が `_<targetSessionId>.jsonl` で終わるもの。まず `cwd` に対応するディレクトリ（`--` ＋ パスの `/` を `-` に置き換え ＋ `--`）を見て、なければ `sessions/` 直下の各ディレクトリを探す。見つからなければ `unknown`。
- 1 行目の `{"type":"session","version":3,...}` を確かめる。version が 3 でなければ `unknown`。
- 末尾から読み、最後の assistant メッセージの `stopReason` と `errorMessage` を取る。壊れた行は読み飛ばす。
- `stopReason` が `"error"` なら `error`、それ以外（`stop`・`aborted`・`toolUse`）なら `stopped`。エラー記録の識別にはメッセージの `timestamp` を使う。
- **一時的エラーの判定**（`errorMessage` に対して。2026-10-11 実ログの集計に合わせて改訂）: まず `usage limit`・`authentication`・`invalidated`・`maximum context length` を含むものは一時的でない（数分では直らない）。それ以外で、先頭が `429` か `5xx`、または `rate_limit_error`・`overloaded_error`・`api_error`・`fetch failed`・`Connection error`・`ECONNRESET`・`ETIMEDOUT`・`socket hang up`・`timed out`・`upstream connect error`・`exceeded request buffer limit` を含むものを一時的とする。それ以外（400・401・403・404 など）は一時的でない。
- 読むのは末尾の一部だけ（最大 256 KiB）。ファイル全体は読まない。

## 4. 部品

| ファイル | 役割 | 依存 |
|---|---|---|
| `src/watch/session-tail.ts` | ログの特定、末尾読み取り、エラー分類。戻り値 `{kind:'error', transient, message, at} \| {kind:'ok'} \| {kind:'unknown', reason}` | fs のみ |
| `src/watch/decide.ts` | 副作用のない判定。`decide(watchState, observation, now) → {actions, next}`。`actions` は `notify` / `prompt` / `stop` | なし |
| `src/watch/registry.ts` | 台帳 `<agentDir>/pi-scaffold/state/watches.json` の読み書き（既存の `writeOwnedFile` を使う） | `core/files` |
| `src/watch/watcher.ts` | 60 秒タイマー、同時実行の抑止、観測 → `decide` → 実行。Herdr・ログ読み取り・通知・時計は注入 | 上 3 つ、`HerdrPort` |
| `src/handoff/herdr-client.ts` | `HerdrPort` に `paneGet(paneId) → {exists:false} \| {exists:true, agent?, status?}` を追加 | 既存 |
| `extensions/index.ts` | `session_start` で再開、`session_shutdown` で停止 | 既存 |
| handoff 系ツール（`handoffStage` の呼び出し側） | `applied` の直後に台帳へ登録し、監視を起こす | 既存 |

台帳の 1 件: `entry`（3.1 の登録内容）＋ `progress`（`retryCount`・`pendingRetryAt`・`exhaustedErrorAt`・`lastNoticeKey`・`herdrFailures`）。

## 5. 異常時の扱い

- Herdr の呼び出しに失敗したら、その回の確認は飛ばす。同じ監視で 3 回続けて失敗したら 1 回だけ通知する。
- Herdr が 0.9.1 / protocol 22 以外なら監視を始めず、1 回だけ通知する（既存の handoff と同じ条件）。
- 前の回の確認が終わっていなければ、次の回は飛ばす。
- 「続けて」の送信が失敗、または結果が不明なら、回数は増やしたうえで通知する（二重送信より送り損ねを選ぶ）。
- 台帳が壊れていたら読み飛ばし、1 回だけ通知する。

## 6. テスト

- `decide.ts`: 状態の組み合わせを表にした単体テスト。主なケースは次の 4 つ。
  - 一時的エラーで 3 回送って止まる
  - `working` で回数が 0 に戻る
  - 同じ状態では通知しない
  - `unknown` は通知のみ
- `session-tail.ts`: fixture の JSONL で確かめる。ケースは、エラー記録（実ログと同じ形）、正常終了、壊れた行、version 違い、ファイルなし、一時的エラーとそうでないエラーの分類。
- `watcher.ts`: 偽の時計・偽の Herdr・偽の通知で確かめる。項目は、再開、同時実行の抑止、pane 消失での終了。
- `herdr-client.ts`: `paneGet` の JSON 解釈を既存テストに追加する。
- 既存の 673 件が通ること。実機での確認（`scripts/test-native-handoff.py` の拡張）を入れるかは計画で決める。

## 7. 合格基準

- 下位が一時的エラーで止まったら、60 秒以内に検知し、待ち時間の後に「続けて」が届く。
- 下位がそれ以外のエラー・入力待ち・pi 終了・pane 消失になったら、2 分以内に親 TUI に通知が出る。
- 同じ状態のまま、通知や送信が繰り返されない。
- 監視対象がないとき、タイマーは動いていない。

## 8. リスク

| リスク | 対策 |
|---|---|
| pi がログ形式を変える | version 3 以外は `unknown` として通知のみにする |
| pi の設定でセッションの置き場所が変わっている | ファイルが見つからなければ `unknown` として通知のみにする |
| 人が下位を直接操作中に「続けて」が割り込む | 送る直前に `idle` と同じエラー記録を再確認する。人が動かせば `working` になり送らない |
| Herdr の pi 連携が状態を誤る | 自動送信の根拠はログの `stopReason` に限り、Herdr の状態だけでは送らない |

## 9. 残る論点

- 実機テスト（`test-native-handoff.py` の拡張）を入れるか。計画の段階で決める。
