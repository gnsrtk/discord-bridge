[English](README_en.md)

# discord-bridge

Discord チャンネルと tmux ウィンドウ上の Claude Code セッションをブリッジする CLI ツールです。

Discord にメッセージを送ると、対応する tmux ウィンドウの Claude Code へそのまま転送されます。
Claude が応答を完了すると、結果が自動的に Discord へ返信されます。

## 主な機能

- **双方向メッセージリレー** — Discord ↔ tmux 上の Claude Code をリアルタイム中継
- **マルチサーバー / マルチプロジェクト** — サーバーごとに Bot トークン・tmux セッションを分離
- **ファイル添付** — Discord からの画像・ファイルを Claude に渡す / Claude の出力をDiscordにアップロード
- **スレッド対応** — スレッドごとに独立した Claude Code セッション（tmux ペイン）を自動起動
- **ボタン操作** — `AskUserQuestion` ツールを自動検出して Discord のボタンに変換（CLAUDE.md での使用推奨を推奨）
- **ツール許可確認** — `Bash` 等の実行前に Discord で許可/拒否を選択可能
- **途中経過通知** — ツール実行前に Claude の途中テキストを `🔄` 付きでリアルタイム転送

> 詳細な動作の仕組みは [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) を参照してください。

## 必要な環境

- **Node.js** 18 以上
- **tmux** 3.0 以上
- **Claude Code** 2.1.47 以上（`last_assistant_message` フィールド対応バージョン）
- **Python** 3.9 以上（hooks 用）
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
          "model": "claude-sonnet-4-6",
          "thread": {
            "model": "claude-sonnet-4-6",
            "permission": "bypassPermissions"
          }
        }
      ],
      "permissionTools": ["Bash"],
      "generalChannelId": "コントロールパネル用 general チャンネルの ID（省略可）"
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
| `servers[].projects[].thread.model` | スレッド用ペインで使用するモデル（省略時は `model` を継承） |
| `servers[].projects[].thread.permission` | スレッド用ペインの権限モード。`bypassPermissions` を指定すると `--dangerously-skip-permissions` 付きで起動（省略時はデフォルト権限） |
| `servers[].projects[].thread.isolation` | スレッド用ペインの隔離モード。`worktree` を指定すると git worktree で独立した作業環境を作成（省略時は隔離なし） |
| `servers[].projects[].startup` | `true` にすると Bot 起動時にこのプロジェクトの tmux ウィンドウを自動作成（デフォルト: `false`） |
| `servers[].projects[].threads[]` | スレッドごとの設定エントリ（Bot が自動保存）。各エントリに `name`・`channelId`・`model`・`projectPath`・`permission`・`isolation`・`startup` を設定可能 |
| `servers[].permissionTools` | ツール実行前に Discord で許可確認を行うツール名のリスト（例: `["Bash"]`）。省略時は空 |
| `servers[].generalChannelId` | コントロールパネル専用チャンネルの ID（省略可）。設定するとボット起動時にプロジェクト一覧・Start/Stop/Refresh ボタンを送信し、テキスト送信でステータスをリフレッシュ |

> **重要**: `servers` には最低 1 件のエントリが必要です。各サーバーの `projects` にも最低 1 件必要です。`servers[0].projects[0]` は cwd がどのプロジェクトにも一致しない場合のフォールバックチャンネルとして使われます。

> **複数サーバー**: `servers` 配列に複数のエントリを追加すると、それぞれ別の Bot トークン・tmux セッションで独立に動作します。同じチャンネル ID を複数サーバーで共有すると警告が表示されます。

> **IDs の確認方法**: Discord の **設定 → 詳細設定 → 開発者モード** を有効にすると、右クリックメニューから各 ID をコピーできます。

## Claude Code Hooks のセットアップ

Discord との連携に必要なフックを設定します（3イベント / 4コマンド）。`.claude/settings.json` で設定する場合：

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
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "python3 /path/to/discord-bridge/hooks/pre_tool_use.py"
          },
          {
            "type": "command",
            "command": "python3 /path/to/discord-bridge/hooks/pre_tool_progress.py",
            "async": true
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
- PreToolUse: python3 /path/to/discord-bridge/hooks/pre_tool_use.py
- PreToolUse (async): python3 /path/to/discord-bridge/hooks/pre_tool_progress.py
```

> **注意**: CLAUDE.md 形式では `async: true` を指定できません。途中経過通知を有効にするには `settings.json` での設定を推奨します。

### hooks の役割

| ファイル | タイミング | 役割 |
| --- | --- | --- |
| `hooks/stop.py` | Claude が応答完了 | Claude の最後の返答テキスト（`last_assistant_message`）を Discord へ送信 |
| `hooks/notify.py` | Claude が通知を発火 | 重要な通知を Discord へ転送（`idle_prompt` は除外） |
| `hooks/pre_tool_use.py` | ツール実行前 | AskUserQuestion を Discord のボタン付きメッセージに変換。`permissionTools` に設定されたツールの許可確認ボタンを表示 |
| `hooks/pre_tool_progress.py` | ツール実行前（非同期） | Claude の途中テキストを `🔄` プレフィックス付きで Discord へ送信。送信コンテンツのハッシュで重複防止 |

## 使い方

```bash
discord-bridge start   # バックグラウンドで起動
discord-bridge status  # 稼働確認（PID を表示）
discord-bridge stop    # 停止
```

`start` を実行すると以下が自動で行われます：

1. 各サーバーの tmux セッションを作成（存在しない場合）
2. `startup: true` のプロジェクトの tmux ウィンドウを作成し、
   `cd <projectPath> && claude --model <model>` を実行（ウィンドウが既存の場合はスキップ）
3. サーバーごとに Discord Bot を起動し、`generalChannelId` が設定されている場合はそのチャンネルにコントロールパネルを送信
4. PID を `~/.discord-bridge/discord-bridge.pid` に保存、
   ログを `~/.discord-bridge/discord-bridge.log` に書き出し

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
| `/tmp/discord-bridge-debug.txt` | `hooks/stop.py` / `hooks/pre_tool_progress.py`（`[progress]` プレフィックス） |
| `/tmp/discord-bridge-notify-debug.txt` | `hooks/notify.py` |

## ライセンス

MIT License — 詳細は [LICENSE](LICENSE) を参照してください。
