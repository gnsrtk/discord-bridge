# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.1] - 2026-02-23

### Fixed

- `src/bot.ts`: AskUserQuestion ボタン押下時に `btn.reply({ ephemeral })` → `btn.update()` に変更。
  ボタン削除+選択結果表示を即座に行い、3秒タイムアウトエラーを防止
- `src/bot.ts`: `__other__` ボタン押下時に `btn.update()` + `btn.followUp()` に変更。
  ボタン削除後「📝 回答を入力してください」を表示

### Added

- `hooks/pre_tool_use.py`: AskUserQuestion のボタンに「その他（テキスト入力）」ボタン（灰色）を
  2行目の ActionRow として常に追加。AskUserQuestion の「Other」に相当する自由入力オプション

## [2.0.0] - 2026-02-22

### Added
- スレッド worktree 隔離 (`thread.isolation: "worktree"`)
  - Claude Code の `--worktree` (`-w`) フラグで各スレッドに独立した git worktree を作成
  - メインチャンネルから `git worktree list` / `git diff` で各スレッドの変更を確認可能
- 永続スレッド状態管理 (`~/.discord-bridge/thread-state.json`)
  - クラッシュ後の自動復元
  - 孤立 worktree の検出・警告
  - アトミック書き込みによるファイル破損防止
- worktree 消失検出: 外部から worktree が削除されたらアーカイブ促進メッセージを送信
- スレッドアーカイブ時の未コミット変更警告
- General チャンネル コントロールパネル (`generalChannelId` 設定フィールド)
  - ボット起動時に general チャンネルへプロジェクト一覧・実行状態・操作ボタンを表示
  - `▶ Start` / `🛑 Stop` ボタンで tmux ウィンドウを Discord から起動・停止
  - `🔄 Refresh` ボタンでパネルをその場で更新
  - general チャンネルへのテキスト送信でもステータス更新（tmux への転送なし）
  - アクティブな worktree 一覧を表示（マルチサーバー時は当該サーバーのみ）
  - Discord ボタン上限（5行×5ボタン=25）に対応した自動キャップ
- `project.startup` フィールド（boolean, default: false）— Bot 起動時に `startup: true` のプロジェクトの tmux ウィンドウを自動起動
  - `autoStartProjects()` (`src/bot.ts`) が `ClientReady` 時に実行
  - `startup: false` かつ実行中のウィンドウは停止する（config との同期）
- スレッド設定テンプレート機能 — `threads[]` エントリに `model` / `projectPath` / `permission` / `isolation` / `startup` を設定可能
  - `resolveThreadConfig()` (`src/config.ts`) で `threads[i]` → `project.thread` → `project` の3層マージ
    （`model` / `permission` / `isolation` が対象。`projectPath` は2層マージ）
  - `appendThreadToConfig()` に `permission` / `isolation` の保存を追加（既存エントリ更新時は `startup` フラグを保持）
  - `threads[i].startup: true` → Bot 起動時にそのスレッドのペインを自動作成

### Changed
- `hooks/pre_tool_use.py`: 許可確認の出力形式を `hookSpecificOutput.permissionDecision` 形式に移行
  - `build_hook_output()` ヘルパーで出力を統一
  - `decision: "block"` を `"deny"` に変更（`additionalContext` 付き）
  - 未知の decision は `"ask"` にフォールバック（安全側）
- `MessageCreate` / `restoreThreadState` / `autoStartStaticThreads` を `resolveThreadConfig()` 経由に統一
  （`project.thread?.` 直接参照を廃止）
- `restoreThreadState()` のプロジェクト検索を `parentChannelId` 基準に変更（`projectPath` オーバーライド対応）
- `restoreThreadState()`: ペインが既存の場合も常に `threadPaneMap` に復元し重複起動を防止

### Fixed
- install.sh: Python バージョンチェックを 3.10+ → 3.9+ に修正（README と一致）

### Other
- `.gitignore` に `.worktrees/` を追加

## v1.8.2

### Changed
- Footer: replaced progress bar graph with model name display
- Display format: `📊 Opus 4.6 50% │ session:45%(2h30m) │ weekly:12%(5d03h)`
- Added `format_context_status()` in `hooks/lib/context.py`
- Cache now includes `model` from `~/.claude/statusline.py`

## v1.8.1

### Added
- Rate limit info (session/weekly utilization + reset time) on every Discord message footer
- `format_footer()`, `format_reset_time()`, `format_rate_limit_entry()`, `read_full_cache()` in `hooks/lib/context.py`
- Cache now includes `rate_limits` from OAuth API via `~/.claude/statusline.py`
- Display format: `📊 █████░░░░░ 50% │ session:45%(2h30m) │ weekly:12%(5d03h)`

### Fixed
- `notify.py`: 429 rate limit retry logic added (was missing, unlike stop.py/pre_tool_progress.py)
- All hook files: added `from __future__ import annotations` for Python 3.9 compatibility
- `stop.py`: session_id 空時のデデュプファイル名衝突を防止
- `transcript.py`: compact 後の summary エントリを境界として扱い、古いメッセージの混入を防止
- `statusline.py`: キャッシュ書き込みをアトミック化（temp → rename）で race condition 防止

## v1.8.0

### Added
- Context window progress bar on every Discord message footer
- `hooks/lib/context.py` — progress bar formatting utilities
- Cache integration in `~/.claude/statusline.py` for context data

### Fixed
- Fixed stale test `test_message_sent_with_title` (title removed in v1.7)

## [1.7.0] - 2026-02-20

### Added

- `hooks/pre_tool_progress.py`: 途中経過通知 — PreToolUse hook（非同期）として
  ツール実行前に transcript から最新アシスタントテキストを取得し、`🔄` プレフィックス付きで
  Discord へ送信。送信コンテンツの MD5 ハッシュで重複防止 (closes #50)
- `src/config.ts`: `ThreadConfigSchema`（`model` / `permission`）を追加。
  スレッドペインのモデルと権限モードをプロジェクトごとに個別設定可能に
- `src/bot.ts`: `buildPermissionFlag()` を追加。`thread.permission` が
  `bypassPermissions` の場合 `--dangerously-skip-permissions` 付きで起動
- `CLAUDE.md`: エージェント向け指示ファイルを追加（AskUserQuestion 使用推奨）
- `docs/ARCHITECTURE.md` / `docs/ARCHITECTURE_en.md`: 動作の仕組み・IPC ファイル・
  スレッド対応・ボタン操作の解説を README から分離して新規作成

### Changed

- **i18n**: ハードコードされた日本語 UI 文字列をすべて英語に置換
  - `hooks/stop.py`: `"✅ Claude 完了"` タイトルを削除、Claude の生出力をそのまま送信
  - `hooks/notify.py`: `"⚠️ Claude 確認待ち"` タイトルを削除、通知メッセージをそのまま送信
  - `hooks/pre_tool_use.py`: `許可/拒否/それ以外` → `Allow/Deny/Other`、
    `🔑 ツール許可確認` → `🔑 Tool permission`
  - `src/bot.ts`: ボタン応答・添付ラベル・エラーメッセージをすべて英語化、
    `🟢 Bot 起動` → `🟢 discord-bridge started`
- `src/bot.ts`: スレッドペイン作成時に `project.thread?.model` / `project.thread?.permission` を参照するよう変更
- `src/bot.ts`: ペイン送信失敗時のフォールバックで `writeThreadTracking` を呼び出し、
  hook の応答がスレッドに届くよう修正

### Fixed

- `src/tmux-sender.ts`: 複数行テキストを Discord から送ると bracketed paste 後の Enter が
  ドロップされ Claude Code が入力待ちのまま止まる問題を修正。`send-keys -l` で
  bracketed paste シーケンス送信後、100ms 待機してから Enter を送るよう変更 (closes #48)

### Removed

- `hooks/stop.py`: 日本語質問パターン自動検出（`QUESTION_PATTERN` / `BINARY_QUESTION_PATTERN` /
  `is_question()` / `post_message_with_buttons()`）を完全削除。質問のボタン化は
  `AskUserQuestion`（pre_tool_use.py）に一本化 (closes #49)
- `docs/plans/` 配下の設計ドキュメント4件と `docs/session-2026-02-18.md` を削除

### Documentation

- `README.md` / `README_en.md`: フック数を「3イベント / 4コマンド」に修正、
  `thread` 設定フィールド追記、CLAUDE.md 形式の例に `pre_tool_progress.py` を追加、
  `AskUserQuestion` 使用推奨を追記
- `docs/ARCHITECTURE.md` / `docs/ARCHITECTURE_en.md`: `AskUserQuestion`（推奨）セクション追加、
  途中経過通知セクション追加、`thread.model` / `thread.permission` 説明追記

## [1.6.0] - 2026-02-19

### Added

- スレッド対応 — 監視チャンネル配下のスレッドからメッセージの送受信に対応。
  ファイルベース IPC（`/tmp/discord-bridge-thread-{parentChannelId}.json`）で
  アクティブスレッドを追跡し、全 hook がスレッドに応答を返す。
  スレッド 404 時は親チャンネルにフォールバック (closes #46)
- スレッドごとの tmux ペイン自動作成 — `tmux split-window` でスレッドごとに
  独立した Claude Code セッションを起動。`threadPaneMap` でスレッド→ペインのマッピングを管理。
  `threadPaneCreating` Set でレース条件を防止。スレッドアーカイブ時にペインを自動終了 (closes #47)
- `hooks/lib/thread.py` 新規作成: `get_thread_id()` / `resolve_target_channel()`
- `src/bot.ts`: `createThreadPane()` / `killThreadPane()` / `writeThreadTracking()` を追加

### Changed

- `hooks/stop.py` / `hooks/notify.py` / `hooks/pre_tool_use.py`:
  `resolve_target_channel()` を使用し、アクティブスレッドがあればスレッドに送信するよう変更
- `src/bot.ts`: MessageCreate ハンドラでスレッドメッセージを認識
  （`msg.channel.isThread()` + `parentId` チェック）

## [1.5.0] - 2026-02-19

### Fixed

- `src/tmux-sender.ts`: 複数行テキスト（エラーログ等）を Discord から送ると
  `send-keys -l` が改行を Enter として送信し、行ごとに分割入力される問題を修正。
  複数行テキストは `tmux load-buffer` + `paste-buffer` で bracketed paste 送信に変更 (closes #45)

## [1.4.0] - 2026-02-19

### Added

- ツール実行の許可確認 — `permissionTools` 設定で Bash 等の実行前に
  Discord で許可/拒否/それ以外の3ボタンを表示。ファイルベース IPC
  （`/tmp/discord-bridge-perm-{channelId}.json`）で Bot → hook 間の応答を受け渡し。
  120秒タイムアウトで Claude Code デフォルト動作に委ねる (closes #44)
- `src/config.ts`: `permissionTools` フィールドを追加
- `hooks/pre_tool_use.py`: `permissionTools` に該当するツールの実行前にボタン送信・応答待機
- `hooks/lib/config.py`: `resolve_channel()` の戻り値に `permission_tools` を追加し
  `(channel_id, bot_token, project_name, permission_tools)` の4-tuple に変更

## [1.3.0] - 2026-02-19

### Added

- ~~質問パターン自動検出~~ (v1.7 で削除 — #49)
- `src/bot.ts`: `__other__` ボタン押下時に tmux 注入をスキップし
  「📝 回答を入力してください」とリプライ

## [1.2.0] - 2026-02-19

### Added

- マルチサーバー・マルチセッション対応（config schemaVersion 2）
  - `servers[]` 配列で複数 Discord サーバー（個別 Bot トークン）を定義可能に
  - サーバーごとに tmux セッションを分離（`servers[].tmux.session`）
  - サーバーごとに独立した Discord Bot インスタンスを起動
  - 同じチャンネル ID を複数サーバーで共有した場合に警告を表示
- `migrate_config.py`: schemaVersion 1 → 2 の設定ファイル移行スクリプト
  （`.json.bak` バックアップ付き）
- `README_en.md`: 英語版 README を追加

### Changed

- `src/config.ts`: スキーマを v2 に移行。`ServerSchema`（name/discord/tmux/projects）を導入し
  `ConfigSchema` を `{ schemaVersion: 2, servers: ServerSchema[] }` に変更
- `src/bot.ts`: `createBot(config)` → `createServerBot(server)` に変更。
  サーバー単位で Bot を生成・起動
- `cli/index.ts`: `setupTmuxWindowsForServer(server)` を追加。
  `runDaemon()` が複数 Client を管理し、全サーバーの Bot を一括 shutdown
- `hooks/lib/config.py`: `resolve_channel()` の戻り値を `(channel_id, project_name)` →
  `(channel_id, bot_token, project_name)` に変更。全サーバーの projects を横断して最長一致
- `hooks/stop.py` / `hooks/notify.py` / `hooks/pre_tool_use.py`:
  `resolve_channel()` から Bot トークンを取得するよう変更
- `src/config.ts`: `discord.generalChannelId` を廃止。`projects[0].channelId` でフォールバック

### Fixed

- `src/bot.ts`: Discord ボタンインタラクション処理に try/catch を追加。
  tmux send-keys 失敗時でも Discord インタラクションを必ず acknowledge するよう変更
- `cli/index.ts`: tmux セッション作成失敗時に window 作成を試みないよう `return` を追加
- `cli/index.ts`: `~/.discord-bridge/` 不在時の ENOENT を修正（`mkdirSync` 追加）(closes #3)
- `src/bot.ts`: 添付ダウンロード失敗時の unhandled rejection を修正 (closes #4)
- `src/bot.ts`: `downloadAttachment()` にタイムアウト（30秒）と最大サイズ制限（50MB）を追加 (closes #4)
- `src/bot.ts`: 到達不能な channel warn 分岐を削除、ファイル名衝突を防止 (closes #5)
- `hooks/notify.py`: デバッグログが常時書き込まれる問題を修正 (closes #6)

### Security

- `hooks/stop.py`: `[DISCORD_ATTACH]` マーカーのパス検証を強化。
  許可ディレクトリ配下のファイルのみアップロード可能に (closes #2)

### Documentation

- `README.md`: マルチサーバー対応に合わせて全面改訂（設定例・フィールド表を v2 に更新）
- `README.md`: `hooks/pre_tool_use.py` の説明を実装に合わせて修正 (closes #7)
- `README.md`: config 例から削除済みの `projects[].order` フィールドを除去 (closes #7)

## [1.1.0] - 2026-02-19

### Changed

- `hooks/stop.py`: 応答取得を transcript ファイル解析から hook input の
  `last_assistant_message` フィールド優先に移行（transcript フォールバック付き）。
  Bot 再起動直後の race condition を根本解決

## [1.0.0] - 2026-02-19

### Added

- Discord チャンネルと tmux 上の Claude Code セッションをブリッジする CLI ツール初版
- `discord-bridge start` でデーモン起動（PID/ログファイル管理）
- tmux セッション・ウィンドウを自動作成
- Discord → Claude Code へのメッセージ転送（`tmux send-keys` 経由）
- Claude Code 応答完了時に Stop フック (`hooks/stop.py`) で Discord へ返信
- ファイル添付の送受信対応
- Discord ボタンインタラクション対応
- `hooks/notify.py`: Notification フックで Claude の確認待ちを Discord へ通知
- `hooks/pre_tool_use.py`: PreToolUse フックで AskUserQuestion を Discord ボタンに変換
- `install.sh`: 前提チェック・ビルド・`npm link`・設定テンプレート生成を自動化
- `uninstall.sh`: プロセス停止・`npm unlink`・設定削除を自動化
- 複数プロジェクト対応（チャンネルとプロジェクトディレクトリを 1:1 でマッピング）
- `DISCORD_BRIDGE_DEBUG=1` によるデバッグログ出力

[Unreleased]: https://github.com/YOUR_USERNAME/discord-bridge/compare/v2.0...HEAD
[2.0.0]: https://github.com/YOUR_USERNAME/discord-bridge/compare/v1.7...v2.0
[1.7.0]: https://github.com/YOUR_USERNAME/discord-bridge/compare/v1.6...v1.7
[1.6.0]: https://github.com/YOUR_USERNAME/discord-bridge/compare/v1.5...v1.6
[1.5.0]: https://github.com/YOUR_USERNAME/discord-bridge/compare/v1.4...v1.5
[1.4.0]: https://github.com/YOUR_USERNAME/discord-bridge/compare/v1.3...v1.4
[1.3.0]: https://github.com/YOUR_USERNAME/discord-bridge/compare/v1.2...v1.3
[1.2.0]: https://github.com/YOUR_USERNAME/discord-bridge/compare/v1.1...v1.2
[1.1.0]: https://github.com/YOUR_USERNAME/discord-bridge/compare/v1.0...v1.1
[1.0.0]: https://github.com/YOUR_USERNAME/discord-bridge/releases/tag/v1.0
