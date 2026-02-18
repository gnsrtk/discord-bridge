# discord-bridge

Discord チャンネルと tmux ウィンドウ上の Claude Code セッションをブリッジする CLI ツールです。

Discord にメッセージを送ると、対応する tmux ウィンドウの Claude Code へそのまま転送されます。
Claude が応答を完了すると、結果が自動的に Discord へ返信されます。

## アーキテクチャ

```text
Discord (スマホ/PC)
       │  メッセージ送信
       ▼
  Discord Bot (discord.js)
       │  テキスト / ファイル添付
       ▼
  TmuxSender
       │  tmux send-keys
       ▼
  tmux ウィンドウ (プロジェクトごと)
       │  Claude Code が処理
       ▼
  Claude Code Hooks (stop.py)
       │  Discord API POST
       ▼
Discord チャンネルへ返信
```

複数プロジェクトに対応しており、チャンネルとプロジェクトディレクトリを 1:1 でマッピングできます。

## 必要な環境

- **Node.js** 18 以上
- **tmux** 3.0 以上
- **Claude Code** (`claude` コマンドが PATH に存在すること)
- **Python** 3.10 以上（hooks 用）
- **Discord Bot トークン**（後述）

## インストール

```bash
git clone https://github.com/YOUR_USERNAME/discord-bridge.git
cd discord-bridge
bash install.sh
```

`install.sh` が以下を自動で行います：前提チェック・ビルド・`npm link`・
`~/.discord-bridge/config.json` テンプレート生成。

## Discord Bot の準備

1. [Discord Developer Portal](https://discord.com/developers/applications) でアプリケーションを作成
2. **Bot** タブ → トークンを発行
3. **Privileged Gateway Intents** で **Message Content Intent** を有効化
4. **OAuth2 → URL Generator** でスコープ `bot` +
   権限 `Send Messages / Read Message History / Attach Files`
   を選択してサーバーに招待
5. サーバーの **チャンネル設定 → 権限** で Bot にチャンネルへのアクセスを許可

## 設定

`~/.discord-bridge/config.json` を作成します。

```json
{
  "schemaVersion": 1,
  "tmux": {
    "session": "discord-bridge"
  },
  "discord": {
    "botToken": "Bot トークンをここに記入",
    "guildId": "サーバー (Guild) ID",
    "ownerUserId": "メッセージを受け付けるユーザーの Discord ID"
  },
  "projects": [
    {
      "name": "my-project",
      "channelId": "このプロジェクト専用チャンネルの ID",
      "projectPath": "/path/to/my-project",
      "model": "claude-sonnet-4-5"
    }
  ]
}
```

### 設定フィールド

| フィールド | 説明 |
| --- | --- |
| `tmux.session` | tmux セッション名（`discord-bridge start` が自動作成） |
| `discord.botToken` | Discord Bot トークン |
| `discord.guildId` | Bot を招待したサーバーの ID（省略可） |
| `discord.ownerUserId` | コマンドを受け付けるユーザー ID（セキュリティ上、1 人に絞ることを推奨） |
| `projects[].name` | tmux ウィンドウ名 / 識別子 |
| `projects[].channelId` | このプロジェクトに対応する Discord チャンネル ID |
| `projects[].projectPath` | Claude Code を起動するディレクトリの絶対パス |
| `projects[].model` | 使用する Claude モデル（例: `claude-sonnet-4-5`） |

> **重要**: `projects` には最低 1 件のエントリが必要です。先頭のエントリ（`projects[0]`）は、cwd がどのプロジェクトにも一致しない場合のフォールバックチャンネルとして使われます。名前は自由に変更できますが、削除すると起動しません。

> **IDs の確認方法**: Discord の **設定 → 詳細設定 → 開発者モード** を有効にすると、右クリックメニューから各 ID をコピーできます。

## Claude Code Hooks のセットアップ

Discord との連携に必要な3つのフックを設定します。`.claude/settings.json` で設定する場合：

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "python3 /path/to/discord-bridge/hooks/stop.py"
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "python3 /path/to/discord-bridge/hooks/notify.py"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "AskUserQuestion",
        "hooks": [
          {
            "type": "command",
            "command": "python3 /path/to/discord-bridge/hooks/pre_tool_use.py"
          }
        ]
      }
    ]
  }
}
```

各プロジェクトの `CLAUDE.md`（または `~/.claude/CLAUDE.md`）に追記する場合：

```markdown
## Hooks

- Stop: python3 /path/to/discord-bridge/hooks/stop.py
- Notification: python3 /path/to/discord-bridge/hooks/notify.py
- PreToolUse[AskUserQuestion]: python3 /path/to/discord-bridge/hooks/pre_tool_use.py
```

### hooks の役割

| ファイル | タイミング | 役割 |
| --- | --- | --- |
| `hooks/stop.py` | Claude が応答完了 | 最後のユーザー入力以降の全アシスタントメッセージを Discord へ送信 |
| `hooks/notify.py` | Claude が通知を発火 | 重要な通知を Discord へ転送（`idle_prompt` は除外） |
| `hooks/pre_tool_use.py` | ツール実行前 | AskUserQuestion を Discord のボタン付きメッセージに変換し、ユーザーの操作完了までツール実行をブロック |

## 使い方

```bash
discord-bridge start   # バックグラウンドで起動
discord-bridge status  # 稼働確認（PID を表示）
discord-bridge stop    # 停止
```

`start` を実行すると以下が自動で行われます：

1. 設定した名前の tmux セッションを作成（存在しない場合）
2. 各プロジェクトの tmux ウィンドウを作成し、
   `cd <projectPath> && claude --model <model>` を実行（ウィンドウが既存の場合はスキップ）
3. Discord Bot をバックグラウンドで起動し、各プロジェクトのチャンネルに `🟢 Bot 起動` を通知
4. PID を `~/.discord-bridge/discord-bridge.pid` に保存、
   ログを `~/.discord-bridge/discord-bridge.log` に書き出し

## 動作の仕組み

### メッセージ転送（Discord → Claude Code）

1. `ownerUserId` のユーザーが対象チャンネルにメッセージを投稿
2. Bot がメッセージを受信し、チャンネル ID からプロジェクトを特定
3. `tmux send-keys` でそのプロジェクトの Claude Code セッションへテキストを送信
4. ファイル添付がある場合は `/tmp/discord-uploads/` にダウンロードして、パスを添えて送信
   （タイムアウト: 30秒、最大サイズ: 50MB）

### 返信（Claude Code → Discord）

1. Claude Code が処理を完了すると Stop フック（`stop.py`）が呼び出される
2. transcript ファイルから最後のユーザー入力以降の全アシスタントメッセージを取得
3. `cwd` と `projectPath` を照合して送信先チャンネルを決定
4. Discord API へ POST（テキスト + ファイル添付対応）

### ファイル添付の送信（Claude → Discord）

Claude の応答に `[DISCORD_ATTACH: filename]` マーカーを含めると、
`/tmp/discord-bridge-outputs/` 配下のファイルが Discord にアップロードされます。

- アップロード可能なのは `/tmp/discord-bridge-outputs/` 以下のファイルのみです
- マーカーにはファイル名またはサブディレクトリを含む相対パスで指定します
- 許可ディレクトリ外を指すパスは無視され、添付は行われません

```text
画像を生成しました。

[DISCORD_ATTACH: output.png]
```

### ボタン操作

Discord のボタンインタラクションも受け付けます。
`customId` の内容が Claude Code のセッションへそのまま送信されます
（Yes/No 確認などに活用できます）。

## デバッグ

`DISCORD_BRIDGE_DEBUG=1` を設定すると、以下のファイルにデバッグログが書き出されます。

この変数はフック（`stop.py` / `notify.py`）が実行される Claude Code の環境で有効にする必要があります。
`~/.zshrc`（または `~/.zprofile`）に追記してください（`~/.claude/.env` はフックには継承されません）。

```bash
# ~/.zshrc に追記
export DISCORD_BRIDGE_DEBUG=1
```

| ファイル | 出力元 |
| --- | --- |
| `/tmp/discord-bridge-debug.txt` | `hooks/stop.py` |
| `/tmp/discord-bridge-notify-debug.txt` | `hooks/notify.py` |

## ライセンス

MIT License — 詳細は [LICENSE](LICENSE) を参照してください。
