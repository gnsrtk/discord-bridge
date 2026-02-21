# アーキテクチャ

## 全体構成

```text
Discord (スマホ/PC)
       │  メッセージ送信
       ▼
  Discord Bot (discord.js)          ← サーバーごとに Bot インスタンスを起動
       │  テキスト / ファイル添付
       ▼
  TmuxSender
       │  tmux send-keys / load-buffer + paste-buffer
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

## メッセージ転送（Discord → Claude Code）

1. `ownerUserId` のユーザーが対象チャンネルにメッセージを投稿
2. Bot がメッセージを受信し、チャンネル ID からプロジェクトを特定
3. `tmux send-keys` でそのプロジェクトの Claude Code セッションへテキストを送信
4. ファイル添付がある場合は `/tmp/discord-uploads/` にダウンロードして、パスを添えて送信
   （タイムアウト: 30秒、最大サイズ: 50MB）

## 返信（Claude Code → Discord）

1. Claude Code が処理を完了すると Stop フック（`stop.py`）が呼び出される
2. hook input の `last_assistant_message` フィールドから最後のアシスタントメッセージを取得
3. `cwd` と各サーバーの `projectPath` を最長一致で照合し、送信先チャンネルと Bot トークンを決定
4. Discord API へ POST（テキスト + ファイル添付対応）

## ファイル添付の送信（Claude → Discord）

Claude の応答に `[DISCORD_ATTACH: filename]` マーカーを含めると、
`/tmp/discord-bridge-outputs/` 配下のファイルが Discord にアップロードされます。

- アップロード可能なのは `/tmp/discord-bridge-outputs/` 以下のファイルのみです
- マーカーにはファイル名またはサブディレクトリを含む相対パスで指定します
- 許可ディレクトリ外を指すパスは無視され、添付は行われません

```text
画像を生成しました。

[DISCORD_ATTACH: output.png]
```

## ボタン操作

Discord のボタンインタラクションも受け付けます。
`customId` の内容が Claude Code のセッションへそのまま送信されます
（Yes/No 確認などに活用できます）。

### AskUserQuestion（推奨）

Claude Code の `AskUserQuestion` ツールを使うと、`pre_tool_use.py` が自動的に Discord のボタン付きメッセージに変換します。ユーザーへの質問・確認・選択にはこのツールの使用を推奨します。

- プレーンテキストの質問はボタンに変換されず、ユーザーが手動でテキスト入力する必要がある
- `AskUserQuestion` ならワンタップで回答でき、選択肢も明確に提示される
- CLAUDE.md で `AskUserQuestion` の使用を指示することで、エージェントに一貫した動作を促せる

### ツール実行の許可確認

`permissionTools` に設定したツール（例: `Bash`）の実行前に、Discord で **許可 / 拒否 / それ以外** の3ボタンが表示されます。

- **許可**（緑）: ツール実行を許可します
- **拒否**（赤）: ツール実行を拒否します
- **それ以外**: 「📝 理由を入力してください」と表示され、次のメッセージで理由を送信できます
- 120秒以内に応答がない場合は Claude Code のデフォルト動作に委ねられます

### スレッド対応

監視対象チャンネル配下のスレッドからもメッセージの送受信が可能です。

- スレッドからメッセージを送ると、親チャンネルの tmux ウィンドウに新しいペインが自動作成され、独立した Claude Code セッションが起動します
- ペインの起動モデルは `thread.model`（未設定時は `model`）、権限は `thread.permission` で制御できます
- `thread.permission` に `bypassPermissions` を指定すると `--dangerously-skip-permissions` 付きで起動します
- 各スレッドは専用のペインを持ち、親チャンネルのセッションとは独立して動作します
- Claude の応答はスレッドに直接返信されます（`DISCORD_BRIDGE_THREAD_ID` 環境変数で制御）
- 親チャンネルにメッセージを送るとアクティブスレッドは解除され、以降の応答は親チャンネルに戻ります
- 同一チャンネルで複数スレッドを使った場合、各スレッドがそれぞれ専用のペインを持ちます
- スレッドがアーカイブされると、対応するペインは自動的に終了します
- ペインの送信に失敗した場合は親チャンネルのセッションに自動フォールバックします

### 途中経過通知

`pre_tool_progress.py`（PreToolUse hook / 非同期）は、ツール実行前に transcript から最新のアシスタントテキストを取得し、Discord に `🔄` プレフィックス付きで送信します。

- 送信コンテンツの MD5 ハッシュで重複送信を防止（同一内容は再送しない）
- `AskUserQuestion` ツールは既存の `pre_tool_use.py` が処理するためスキップ
- スレッドがアクティブな場合はスレッドに送信、なければ親チャンネルへ

### コンテキスト残量プログレスバー + レート制限

Claude の応答ごとに、Discord メッセージ末尾にコンテキスト使用量とレート制限情報を表示する。

**データフロー:**

1. `~/.claude/statusline.py` が Claude Code の statusLine API からコンテキスト情報を受信
2. 同スクリプトが OAuth API (`/api/oauth/usage`) でレート制限情報を取得（60秒キャッシュ付き）
3. `/tmp/discord-bridge-context-{session_id}.json` にキャッシュ
4. `hooks/stop.py` がキャッシュを読み取り、メッセージ末尾にフッターを追加

**キャッシュ形式:**
```json
{
  "used_percentage": 50,
  "rate_limits": {
    "five_hour": {"utilization": 45, "resets_at": "2026-02-21T12:00:00Z"},
    "seven_day": {"utilization": 12, "resets_at": "2026-02-25T12:00:00Z"}
  }
}
```

**表示フォーマット:**

`📊 █████░░░░░ 50% │ session:45%(2h30m) │ weekly:12%(5d03h)`

| 範囲 | プログレスバー |
|------|--------|
| 0-69% | `📊` |
| 70-89% | `⚠️` |
| 90-100% | `🚨` |

**関連ファイル:**
- `hooks/lib/context.py` — `format_footer()`, `format_progress_bar()`, `read_full_cache()`
- `~/.claude/statusline.py` — キャッシュ書き込み（プロジェクト外）

## IPC ファイル

hooks と Bot の間はファイルベースの IPC で通信します。

| ファイル | 用途 |
| --- | --- |
| `/tmp/discord-bridge-thread-{parentChannelId}.json` | アクティブスレッドの追跡（`{"threadId": "..."}` 形式） |
| `/tmp/discord-bridge-perm-{channelId}.json` | ツール許可確認の応答（`{"decision": "allow\|deny\|block"}` 形式） |
| `/tmp/discord-bridge-dedup-{sessionId}.json` | Stop hook の重複送信防止 |
| `/tmp/discord-bridge-progress-{sessionId}.txt` | `pre_tool_progress.py` の重複送信防止（送信コンテンツの MD5 ハッシュ） |
| `/tmp/discord-bridge-debug.txt` | デバッグログ（`stop.py` / `pre_tool_progress.py`、`[progress]` プレフィックス） |
| `/tmp/discord-bridge-notify-debug.txt` | デバッグログ（`notify.py`） |
