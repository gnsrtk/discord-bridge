# discord-bridge

Discord チャンネルと tmux ウィンドウ上の Claude Code セッションをブリッジする CLI ツールです。

Discord にメッセージを送ると、対応する tmux ウィンドウの Claude Code へそのまま転送されます。
Claude が応答を完了すると、結果が自動的に Discord へ返信されます。

## アーキテクチャ

```text
Discord (スマホ/PC)
       │  メッセージ送信
       ▼
  Discord Bot (discord.js)          ← サーバーごとに Bot インスタンスを起動
       │  テキスト / ファイル添付
       ▼
  TmuxSender
       │  tmux send-keys
       ▼
  tmux セッション:ウィンドウ         ← サーバーごとに tmux セッションを分離
       │  Claude Code が処理
       ▼
  Claude Code Hooks (stop.py)       ← cwd から Bot トークン・チャンネルを自動解決
       │  Discord API POST
       ▼
Discord チャンネルへ返信
```

複数サーバー・複数プロジェクトに対応しており、サーバーごとに Bot トークンと tmux セッションを分離できます。
チャンネルとプロジェクトディレクトリは 1:1 でマッピングされ、cwd ベースの最長一致で自動解決します。

## 必要な環境

- **Node.js** 18 以上
- **tmux** 3.0 以上
- **Claude Code** 2.1.47 以上（`last_assistant_message` フィールド対応バージョン）
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

`~/.discord-bridge/config.json` を作成します（schemaVersion 2）。

```json
{
  "schemaVersion": 2,
  "servers": [
    {
      "name": "personal",
      "discord": {
        "botToken": "Bot トークンをここに記入",
        "guildId": "サーバー (Guild) ID",
        "ownerUserId": "メッセージを受け付けるユーザーの Discord ID"
      },
      "tmux": {
        "session": "discord-bridge"
      },
      "projects": [
        {
          "name": "my-project",
          "channelId": "このプロジェクト専用チャンネルの ID",
          "projectPath": "/path/to/my-project",
          "model": "claude-sonnet-4-6"
        }
      ]
    }
  ]
}
```

### 設定フィールド

| フィールド | 説明 |
| --- | --- |
| `servers[].name` | サーバー識別子（ログ出力に使用） |
| `servers[].discord.botToken` | Discord Bot トークン |
| `servers[].discord.guildId` | Bot を招待したサーバーの ID（省略可） |
| `servers[].discord.ownerUserId` | コマンドを受け付けるユーザー ID（セキュリティ上、1 人に絞ることを推奨） |
| `servers[].tmux.session` | このサーバー用の tmux セッション名（`discord-bridge start` が自動作成） |
| `servers[].projects[].name` | tmux ウィンドウ名 / 識別子 |
| `servers[].projects[].channelId` | このプロジェクトに対応する Discord チャンネル ID |
| `servers[].projects[].projectPath` | Claude Code を起動するディレクトリの絶対パス |
| `servers[].projects[].model` | 使用する Claude モデル（例: `claude-sonnet-4-6`） |

> **重要**: `servers` には最低 1 件のエントリが必要です。各サーバーの `projects` にも最低 1 件必要です。`servers[0].projects[0]` は cwd がどのプロジェクトにも一致しない場合のフォールバックチャンネルとして使われます。

> **複数サーバー**: `servers` 配列に複数のエントリを追加すると、それぞれ別の Bot トークン・tmux セッションで独立に動作します。同じチャンネル ID を複数サーバーで共有すると警告が表示されます。

> **IDs の確認方法**: Discord の **設定 → 詳細設定 → 開発者モード** を有効にすると、右クリックメニューから各 ID をコピーできます。

### v1 からの移行

schemaVersion 1 の設定ファイルは `migrate_config.py` で v2 に変換できます。

```bash
python3 migrate_config.py
```

元のファイルは `~/.discord-bridge/config.json.bak` にバックアップされます。

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
| `hooks/stop.py` | Claude が応答完了 | Claude の最後の返答テキスト（`last_assistant_message`）を Discord へ送信 |
| `hooks/notify.py` | Claude が通知を発火 | 重要な通知を Discord へ転送（`idle_prompt` は除外） |
| `hooks/pre_tool_use.py` | ツール実行前 | AskUserQuestion を Discord のボタン付きメッセージに変換し、ユーザーの操作完了までツール実行をブロック |

## 使い方

```bash
discord-bridge start   # バックグラウンドで起動
discord-bridge status  # 稼働確認（PID を表示）
discord-bridge stop    # 停止
```

`start` を実行すると以下が自動で行われます：

1. 各サーバーの tmux セッションを作成（存在しない場合）
2. 各プロジェクトの tmux ウィンドウを作成し、
   `cd <projectPath> && claude --model <model>` を実行（ウィンドウが既存の場合はスキップ）
3. サーバーごとに Discord Bot を起動し、各プロジェクトのチャンネルに `🟢 Bot 起動` を通知
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
2. hook input の `last_assistant_message` フィールドから最後のアシスタントメッセージを取得
3. `cwd` と各サーバーの `projectPath` を最長一致で照合し、送信先チャンネルと Bot トークンを決定
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
