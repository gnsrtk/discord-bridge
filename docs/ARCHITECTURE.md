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
       │  tmux send-keys -l (bracketed paste)
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

- 1行目: 選択肢ボタン（青、最大5個）
- 2行目: 「その他（テキスト入力）」ボタン（灰色）— 自由入力が必要な場合に使用
- ボタン押下後は元メッセージからボタンが削除され、選択結果が表示される
- 「その他」押下時はボタン削除後に「📝 回答を入力してください」のフォローアップが表示される
- プレーンテキストの質問はボタンに変換されず、ユーザーが手動でテキスト入力する必要がある
- CLAUDE.md で `AskUserQuestion` の使用を指示することで、エージェントに一貫した動作を促せる

### ツール実行の許可確認

`permissionTools` に設定したツール（例: `Bash`）の実行前に、Discord で **許可 / 拒否 / それ以外** の3ボタンが表示されます。

- **許可**（緑）: ツール実行を許可します
- **拒否**（赤）: ツール実行を拒否します
- **それ以外**: 「📝 理由を入力してください」と表示され、次のメッセージで理由を送信できます
- 120秒以内に応答がない場合は Claude Code のデフォルト動作に委ねられます

### Plan mode 承認（ExitPlanMode）

Claude Code の Plan mode で `ExitPlanMode` が呼ばれると、Discord に **Approve / Reject** の2ボタンが表示されます。

- **Approve**（緑）: プランを承認し、Claude が実装フェーズに移行します
- **Reject**（赤）: プランを却下し、Claude がプランモードに留まります。フィードバックは通常メッセージで送信できます
- ボタンメッセージには transcript から取得したプラン概要が含まれます
- 120秒以内に応答がない場合は Claude Code のデフォルト動作（ターミナルプロンプト）に委ねられます

### スレッド対応

監視対象チャンネル配下のスレッドからもメッセージの送受信が可能です。

- スレッドからメッセージを送ると、親チャンネルの tmux ウィンドウに新しいペインが自動作成され、独立した Claude Code セッションが起動します
- 各スレッドは専用のペインを持ち、親チャンネルのセッションとは独立して動作します
- Claude の応答はスレッドに直接返信されます（`DISCORD_BRIDGE_THREAD_ID` 環境変数で制御）
- 親チャンネルにメッセージを送るとアクティブスレッドは解除され、以降の応答は親チャンネルに戻ります
- 同一チャンネルで複数スレッドを使った場合、各スレッドがそれぞれ専用のペインを持ちます
- スレッドがアーカイブされると、対応するペインは自動的に終了します
- ペインの送信に失敗した場合は親チャンネルのセッションに自動フォールバックします

#### スレッド設定テンプレート（3層マージ）

スレッドごとに `model` / `projectPath` / `permission` / `isolation` を個別設定できます。設定の優先度（高い順）:

```
threads[i] フィールド
  → project.thread デフォルト（省略時）※ projectPath はこの層をスキップ
    → project フィールド（省略時）
```

> **注意**: `projectPath` は `project.thread` に定義がないため2層マージ（`threads[i].projectPath` → `project.projectPath`）になります。`model` / `permission` / `isolation` のみ3層マージです。

- `config.json` の `threads[]` 各エントリに設定を記述すると、そのスレッドにだけ適用されます
- `permission: "bypassPermissions"` を指定すると `--dangerously-skip-permissions` 付きで起動します
- 動的に作成されたスレッドの設定（model, projectPath, permission, isolation）も `config.json` の `threads[]` に自動保存されます
- `startup: true` を設定したスレッドは Bot 起動時に自動的にペインを作成します

#### Worktree 隔離（opt-in）

`isolation: "worktree"` を config に設定すると（project.thread または threads[] エントリで指定）、スレッドペインが Claude Code の `--worktree` (`-w`) フラグ付きで起動し、git worktree で隔離された作業環境を提供する。

- メインチャンネルから `git worktree list` や `git diff` で各スレッドの変更を確認可能
- ペイン・worktree の状態は `~/.discord-bridge/thread-state.json` に永続化
- クラッシュ後の再起動時に自動復元（worktree あり + ペインなし → ペイン再作成）
- 起動時に `.claude/worktrees/` をスキャンし、未登録の孤立 worktree を警告
- スレッドアーカイブ時に worktree を強制削除（未コミット変更がある場合は事前に警告）
- worktree が外部から削除された場合、スレッドに「アーカイブしてください」と通知

### コントロールパネル

`generalChannelId` を設定したチャンネルには、Bot 起動時にコントロールパネルが送信されます。その後はユーザーの操作（メッセージ送信・ボタン押下）により更新されます。

- 各プロジェクトの起動状態（🟢 実行中 / ⭕ 停止中）をリスト表示
- **▶ Start / 🛑 Stop** ボタンでプロジェクトの tmux ウィンドウを起動・停止
- アクティブな Worktree の一覧を表示

#### 自動起動（startup）

`config.json` の `startup` フィールドで、Bot 起動時の自動起動を制御できます。

- `project.startup: true` → Bot 起動時にプロジェクトの tmux ウィンドウを自動作成
- `project.startup: false`（デフォルト）かつウィンドウが実行中の場合 → Bot 起動時に停止
- `threads[i].startup: true` → Bot 起動時にそのスレッドのペインを自動作成

### 途中経過通知

`pre_tool_progress.py`（PreToolUse hook / 非同期）は、ツール実行前に transcript から最新のアシスタントテキストを取得し、Discord に `🔄` プレフィックス付きで送信します。

- 送信コンテンツの MD5 ハッシュで重複送信を防止（同一内容は再送しない）
- `AskUserQuestion` ツールは既存の `pre_tool_use.py` が処理するためスキップ
- スレッドがアクティブな場合はスレッドに送信、なければ親チャンネルへ

### Markdown テーブル変換

Claude の応答に Markdown テーブル（`| col | col |`）が含まれる場合、`stop.py` が `tabulate` ライブラリで ASCII テーブルに変換し、コードブロックで囲んで送信します。Discord は Markdown テーブル構文を未サポートのため、等幅フォント表示で読みやすくするための処理です。

- 変換ロジック: `hooks/lib/table.py`（`convert_tables_in_text()`）
- fenced code block（` ``` ` / `~~~`）内のテーブルは変換対象外
- 日本語混在テーブルは Discord のフォントフォールバックにより表示がズレる場合がある（既知の制限）
- 2000 文字を超える場合は改行位置で分割して複数メッセージで送信

### コンテキスト・モデル・レート制限フッター

Claude の応答ごとに、Discord メッセージ末尾にモデル名・コンテキスト使用量・レート制限情報を表示する。

**データフロー:**

1. `~/.claude/statusline.py` が Claude Code の statusLine API からコンテキスト情報とモデル名を受信
2. 同スクリプトが OAuth API (`/api/oauth/usage`) でレート制限情報を取得（60秒キャッシュ付き）
3. `/tmp/discord-bridge-context-{session_id}.json` にキャッシュ
4. `hooks/stop.py` がキャッシュを読み取り、メッセージ末尾にフッターを追加

**キャッシュ形式:**
```json
{
  "used_percentage": 50,
  "model": "Opus 4.6",
  "rate_limits": {
    "five_hour": {"utilization": 45, "resets_at": "2026-02-21T12:00:00Z"},
    "seven_day": {"utilization": 12, "resets_at": "2026-02-25T12:00:00Z"}
  }
}
```

**表示フォーマット:**

`📊 Opus 4.6 50% │ session:45%(2h30m) │ weekly:12%(5d03h)`

**関連ファイル:**
- `hooks/lib/context.py` — `format_footer()`, `format_context_status()`, `read_full_cache()`
- `~/.claude/statusline.py` — キャッシュ書き込み（プロジェクト外）

## IPC ファイル

hooks と Bot の間はファイルベースの IPC で通信します。

| ファイル | 用途 |
| --- | --- |
| `/tmp/discord-bridge-thread-{parentChannelId}.json` | アクティブスレッドの追跡（`{"threadId": "..."}` 形式） |
| `/tmp/discord-bridge-perm-{channelId}.json` | ツール許可確認の応答（`{"decision": "allow\|deny\|block"}` 形式） |
| `/tmp/discord-bridge-plan-{channelId}.json` | Plan mode 承認の応答（`{"decision": "approve\|reject"}` 形式） |
| `/tmp/discord-bridge-last-sent-{sessionId}.txt` | Stop hook の重複送信防止（`{sessionId}:{transcript_mtime}` 形式のプレーンテキスト） |
| `/tmp/discord-bridge-progress-{sessionId}.txt` | `pre_tool_progress.py` の重複送信防止（送信コンテンツの MD5 ハッシュ） |
| `/tmp/discord-bridge-debug.txt` | デバッグログ（`stop.py` / `pre_tool_progress.py`、`[progress]` プレフィックス） |
| `/tmp/discord-bridge-notify-debug.txt` | デバッグログ（`notify.py`） |
| `~/.discord-bridge/thread-state.json` | スレッドペイン・worktree の永続状態 |
