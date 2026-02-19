# 既知の問題

## CRITICAL

| # | 状態 | 問題 | 該当箇所 | 対策 |
|---|------|------|----------|------|
| 1 | ✅ | `notify.py` が削除済みの `generalChannelId` を参照してクラッシュ | `hooks/notify.py` L76 | `projects[0]["channelId"]` にフォールバック済み |
| 2 | ✅ | `install.sh` のテンプレートに `generalChannelId` が残っている | `install.sh` L95 | テンプレートから削除済み |
| 3 | ✅ | README の config 例・フィールド表に `generalChannelId` が残っている | `README.md` L74, L95 | 削除し、フォールバック動作を記載済み |

## HIGH

| # | 状態 | 問題 | 該当箇所 | 対策 |
|---|------|------|----------|------|
| 4 | ✅ | `projects` が空のとき `channel_id` が `None` / `IndexError` | 全フック | 空ならエラーメッセージ表示して exit(1) に修正済み |
| 5 | ✅ | cwd 完全一致でサブディレクトリが一致しない | 全フック | `startswith` + 最長一致に修正済み |
| 6 | ✅ | フック間のフォールバック動作が不整合（`notify.py` だけ `generalChannelId`） | 全フック | #1 の修正で統一済み |
| 10 | ✅ | `startswith` にパス区切り未考慮（`/app` が `/app2` に誤一致） | 全フック L72,86,257 | `hooks/lib/config.py` の `resolve_channel` で `cwd == pp or cwd.startswith(pp + "/")` に修正済み |
| 11 | ✅ | `config.json` が `chmod 600` なしで作成される（botToken が他ユーザーから読める） | `install.sh` L79,85 | `cp` 後に `chmod 600 "$CONFIG_FILE"` を追加済み |
| 12 | ✅ | `readPid()` が 0/負数を許容し `process.kill(0)` でプロセスグループ全体を殺す | `cli/index.ts` L64-71, L140 | `isNaN(pid) \|\| pid <= 0` ガードを追加済み |

## MEDIUM

| # | 状態 | 問題 | 該当箇所 | 対策 |
|---|------|------|----------|------|
| 7 | ✅ | `notify.py` の `idle_prompt` フィルタが未文書化 | `hooks/notify.py` L52-54 | README hooks 表に記載済み |
| 8 | ✅ | デバッグログファイルが README に不完全 | `README.md` デバッグ節 | `notify.py` の別ファイルも表形式で列挙済み |
| 9 | ✅ | 添付ファイルのタイムアウト・サイズ制限が README に未記載 | `src/bot.ts` L14-15 | 30秒 / 50MB を記載済み |
| 13 | ✅ | Zod スキーマが `projects` 空配列を許容（README は最低1件と記載） | `src/config.ts` L23 | `z.array(ProjectSchema).min(1)` に変更済み |
| 14 | ✅ | Zod の `z.string()` に `.min(1)` がなく空文字列が通過する | `src/config.ts` L6-21 | `botToken`, `channelId` 等に `.min(1)` 追加済み |
| 15 | ✅ | `guildId` が config で必須だが実行時に未使用 | `src/config.ts` L20 | `z.string().optional()` に変更済み |
| 16 | ✅ | 添付ダウンロードが `content-length` 不明時にフル読み込み（OOM リスク） | `src/bot.ts` L37-41 | ストリーミング読み込みでバイト数を逐次チェック済み |
| 17 | ✅ | 重複判定ファイルがロックなし。並行セッションで競合→メッセージ欠落 | `hooks/stop.py` L227-239 | `session_id` ごとにファイル分離済み |
| 29 | ✅ | `urlopen` は 4xx/5xx を `HTTPError` として raise するため `resp.status` チェックが実質デッドコード。エラーログが出ない | `hooks/stop.py` L192-194, `hooks/notify.py` L30-32, `hooks/pre_tool_use.py` L27-29 | `except urllib.error.HTTPError` を明示的に捕捉して `{e.code} {e.reason}` をログ出力・re-raise に修正済み |
| 30 | ✅ | `MessageCreate` ハンドラーで `sender.send()` が try-catch されておらず、tmux セッション不在時のエラーがサイレントに消える | `src/bot.ts` L167 | `trySend` ヘルパーで3箇所を一括ラップ済み |
| 33 | ✅ | README が「最後のアシスタントメッセージ」と記載しているが、実装は最後のユーザー入力以降の全アシスタントメッセージを送信する | `README.md` L139, L173 | 「最後のユーザー入力以降の全アシスタントメッセージ」に修正済み |
| 34 | ✅ | `notify.py`（Notification hook）と `pre_tool_use.py`（PreToolUse hook）のセットアップ手順が README に未記載。hooks 役割表には載っているが設定例がない | `README.md` L103-133 | 3フック分の `settings.json` / `CLAUDE.md` 設定例を追記済み |

## LOW

| # | 状態 | 問題 | 該当箇所 | 対策 |
|---|------|------|----------|------|
| 18 | ✅ | PID 再利用で無関係プロセスを kill する可能性 | `cli/index.ts` L136-140 | `isNodeProcess()` でプロセス名検証を追加済み |
| 19 | ✅ | ダウンロード添付ファイルが `/tmp/discord-uploads/` に蓄積（クリーンアップなし） | `src/bot.ts` L13,24 | `createBot` 起動時に24時間超ファイルを削除済み |
| 20 | ✅ | ボタンの `custom_id` が `label` 一致。ラベル重複時に応答が不定 | `hooks/pre_tool_use.py` L43-48 | `{i}:{label}` 形式の `custom_id` に変更済み |
| 21 | ✅ | 送信添付ファイルをフル `read()` でメモリに展開（サイズ制限なし） | `hooks/stop.py` L92-99 | `os.path.getsize` で25MB超をスキップ済み |
| 22 | ✅ | `install.sh` が `npm ci` ではなく `npm install`（再現性が低い） | `install.sh` L64 | `npm ci --silent` に変更済み |
| 23 | ✅ | デバッグログが生フック入力を `/tmp/` に書き出す（機密漏洩リスク） | `hooks/stop.py` L24, `hooks/notify.py` L46 | キー名のみ出力に変更済み |
| 24 | ✅ | チャンネル解決ロジックが 3 フックで重複（保守性低下） | 全フック | `hooks/lib/config.py` に共通化済み |
| 25 | ✅ | tmux `send-keys` に渡す config 値が未エスケープ（シェルメタ文字リスク） | `cli/index.ts` L54 | `escapeTmuxShellArg()` でエスケープ済み |
| 26 | ✅ | `projectPath` が末尾 `/` で終わる場合に `startswith(pp + "/")` が `"//"` になりマッチしない | `hooks/lib/config.py` L20 | `pp.rstrip("/")` で正規化済み（Codex レビューで検出） |
| 27 | ✅ | Stop hook が最後の1件しか送らず、途中のアシスタントテキストが Discord に届かない | `hooks/stop.py` | 全テキスト付きアシスタントメッセージを収集・順送信に変更済み |
| 28 | ✅ | 複数メッセージ送信ループで添付のみのメッセージが `display_text` 空判定でスキップされる | `hooks/stop.py` L278-279 | `not display_text and not attach_paths` に修正済み（Codex レビューで検出） |
| 31 | ✅ | `ProjectSchema` の `model` フィールドが全コードで未使用（バリデーションのみ）と誤検出 | `src/config.ts` L10 | `cli/index.ts` L58 で `--model` オプションとして使用中。誤検出のためクローズ |
| 32 | ✅ | `get_assistant_messages` が `tool_result` 型の `user` エントリを通常ユーザーメッセージと混同し、その前のアシスタントテキストを取得範囲外にする | `hooks/stop.py` L154-157 | `tool_result` のみで構成される `user` エントリをスキップするよう修正済み |
| 35 | ✅ | Bot 起動時の `🟢 Bot 起動` 通知が README に未記載 | `README.md` (未記載), `src/bot.ts` L144-156 | 「使い方」の `start` 説明に追記済み |
| 36 | ✅ | `DISCORD_BRIDGE_DEBUG=1 discord-bridge start` と記載されているが、フックは Claude Code が別プロセスで実行するため `discord-bridge` のプロセス環境変数では有効にならない | `README.md` L201 | `~/.zshrc` に `export DISCORD_BRIDGE_DEBUG=1` を追記する方法に修正済み（`~/.claude/.env` はフックに継承されないため不可） |
| 37 | ✅ | AskUserQuestion 呼び出し前のアシスタントテキスト（比較表・説明など）が Discord に届かない。PreToolUse hook 発火時点では Stop hook は未発火のため | `hooks/pre_tool_use.py` | `lib/transcript.py` に共通化した `get_assistant_messages` を使い、直前テキストをボタンメッセージに付加するよう修正済み |
| 38 | ✅ | 複数メッセージ連続送信時に Discord のレート制限（HTTP 429）で後続メッセージが欠落する | `hooks/stop.py` | `last_assistant_message` 移行（2026-02-19）で根本解決。Discord API 呼び出しが常に1件になりレート制限リスクがほぼゼロに。安全弁として `_send_request()` の 429 Retry-After リトライ（最大3回）は維持 |
| 39 | ✅ | Bot 再起動直後に Stop hook が送信するメッセージが Discord に届かない（Stop が transcript 書き込み完了前に発火 or 🟢 起動通知と競合） | `hooks/stop.py` L196, `src/bot.ts` L144 | `last_assistant_message` 移行（2026-02-19）で根本解決。メッセージが hook input に直接入るため transcript 書き込みとの race condition がなくなった。ClientReady での🟢送信間の 1 秒 delay は維持 |
| 40 | ✅ | config schemaVersion 1 ではサーバーが 1 つしか設定できず、複数 Discord サーバーを使い分けられない | `src/config.ts`, `hooks/lib/config.py` | schemaVersion 2 で `servers[]` 配列を導入。サーバーごとに Bot トークン・tmux セッション・プロジェクトを独立管理。`migrate_config.py` で v1 → v2 移行可能 |
| 41 | ✅ | フック（stop/notify/pre_tool_use）が `config["discord"]["botToken"]` をハードコードで参照しており、マルチサーバー非対応 | 全フック | `resolve_channel()` が `(channel_id, bot_token, project_name)` の 3-tuple を返すよう変更。cwd から全サーバーの projects を横断して最長一致で Bot トークンを自動解決 |
| 42 | ✅ | `setupTmuxWindowsForServer()` で tmux セッション作成に失敗した場合、存在しないセッションに対してウィンドウ作成を試みる | `cli/index.ts` | セッション作成失敗時に `return` で早期終了するよう修正 |
| 43 | ✅ | アシスタントがプレーンテキストで「〜しますか？」と質問した場合、Discord ではボタンにならず通常メッセージとして表示される。AskUserQuestion を使えばボタン化されるが、漏れが発生しやすい | `hooks/stop.py`, `src/bot.ts` | stop.py で `last_assistant_message` 末尾の質問パターンを正規表現で検出し（`しますか？` `でしょうか？` `しょうか？` `ますか？` 等）、3ボタン（はい/いいえ/それ以外）付きメッセージとして送信。「それ以外」（`customId: __other__`）押下時は tmux に注入せず「回答を入力してください」とリプライし、次のユーザーメッセージを通常の MessageCreate 経由で tmux に送信。添付ファイルがある場合はボタン化しない |
| 44 | ✅ | Permission 確認（Bash 等のツール実行許可）が Discord に通知されず、モバイルからの操作時に許可待ちが見えない | `hooks/pre_tool_use.py`, `src/bot.ts`, `src/config.ts` | `config.json` の `permissionTools` で対象ツールを設定。PreToolUse hook が該当ツール検出時に Discord へ許可/拒否/それ以外の3ボタンを送信。ファイルベース IPC（`/tmp/discord-bridge-perm-{channelId}.json`）で Bot → hook 間の応答を受け渡し。120秒タイムアウトで Claude Code デフォルト動作に委ねる |
| 45 | ✅ | Discord から複数行テキスト（エラーログ等）を送ると `send-keys -l` が改行を Enter として送信し、行ごとに分割入力される | `src/tmux-sender.ts` | 複数行テキストは `tmux load-buffer -` + `paste-buffer -d` でブラケットペースト送信に変更。単一行は従来通り `send-keys -l` |
| 46 | ✅ | Discord チャンネル内のスレッドから送ったメッセージが `listenChannelIds` にマッチせず無視される。Claude の応答も常に親チャンネルに送信される | `src/bot.ts`, `hooks/stop.py`, `hooks/notify.py`, `hooks/pre_tool_use.py` | スレッドトラッキング機構を導入。Bot 側で `msg.channel.isThread()` + `parentId` チェックにより監視チャンネル配下のスレッドを認識。ファイルベース IPC（`/tmp/discord-bridge-thread-{parentChannelId}.json`）で最後にメッセージを送った場所を記録し、全 hook が `resolve_target_channel()` でアクティブスレッドに応答を返す。スレッド 404 時は親チャンネルにフォールバック |
