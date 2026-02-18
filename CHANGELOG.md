# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `src/config.ts`: `discord.generalChannelId` を廃止。`projects[0]` の `channelId` をフォールバックとして使用するよう変更
- `hooks/stop.py` / `hooks/pre_tool_use.py`: `discord.generalChannelId` 参照を削除し、`projects[0]["channelId"]` でフォールバック
- `src/bot.ts`: `generalChannelId` を `listenChannelIds` から除去

### Fixed

- `src/bot.ts`: Discord ボタンインタラクション処理に try/catch を追加。
  tmux send-keys 失敗時でも Discord インタラクションを必ず acknowledge するよう変更。
  未対応だと「インタラクションに失敗しました」が表示されていた

### Security

- `hooks/stop.py`: `[DISCORD_ATTACH]` マーカーのパス検証を強化。
  許可ディレクトリ (`/tmp/discord-bridge-outputs/`) 配下のファイルのみアップロード可能にし、
  それ以外のパスは無視するよう変更 (closes #2)

### Fixed

- `cli/index.ts`: `discord-bridge start` 実行時に `~/.discord-bridge/` が存在しない場合、
  `openSync`/`writeFileSync` が ENOENT で失敗する問題を修正。
  `mkdirSync(CONFIG_DIR, { recursive: true })` を追加 (closes #3)
- `src/bot.ts`: Discord からの添付ファイルダウンロード失敗時に unhandled rejection が
  発生する問題を修正。try/catch を追加し、失敗時は Discord へエラー返信して
  メッセージ本文のみ Claude Code へ転送するよう変更 (closes #4)
- `src/bot.ts`: `downloadAttachment()` にタイムアウト（30秒）と最大サイズ制限（50MB）を追加。
  巨大ファイルや応答ハングでボットが固まる問題を防止 (closes #4)
- `src/bot.ts`: 到達不能だった channel warn 分岐を削除 (closes #5)
- `src/bot.ts`: ダウンロードファイル名に `Math.random()` ベースのユニーク ID を追加し、
  同一ミリ秒内の同名ファイル衝突を防止 (closes #5)
- `hooks/notify.py`: デバッグログ (`/tmp/discord-bridge-notify-debug.txt`) が
  `DISCORD_BRIDGE_DEBUG` フラグなしで常時書き込まれる問題を修正 (closes #6)

### Documentation

- `README.md`: `hooks/pre_tool_use.py` の説明を実装に合わせて修正
  （破壊的操作通知 → AskUserQuestion のボタン変換） (closes #7)
- `README.md`: config 例から削除済みの `projects[].order` フィールドを除去 (closes #7)
- `README.md`: `[DISCORD_ATTACH]` の使用方法をセキュリティ制限に合わせて更新

## [1.0.0] - 2026-02-18

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

[Unreleased]: https://github.com/YOUR_USERNAME/discord-bridge/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/YOUR_USERNAME/discord-bridge/releases/tag/v1.0.0
