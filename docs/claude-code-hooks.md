# Claude Code Hooks リファレンス

discord-bridge プロジェクト向けの Claude Code Hooks 調査メモ。
公式ドキュメント: https://code.claude.com/docs/en/hooks

## フック一覧（全15種）

| フック | 発火タイミング | ブロック | DCB使用 | マッチャー |
|---|---|---|---|---|
| **SessionStart** | セッション開始・再開 | No | - | `startup`, `resume`, `clear`, `compact` |
| **SessionEnd** | セッション終了 | No | - | `clear`, `logout`, `prompt_input_exit` 等 |
| **UserPromptSubmit** | ユーザー入力後、Claude処理前 | Yes | - | - |
| **PreToolUse** | ツール実行前 | Yes | **使用中** | ツール名（正規表現） |
| **PermissionRequest** | 権限ダイアログ表示前 | Yes | - | ツール名 |
| **PostToolUse** | ツール成功後 | No（feedback可） | - | ツール名 |
| **PostToolUseFailure** | ツール失敗後 | No | - | ツール名 |
| **Notification** | 通知送信時 | No | **使用中** | `permission_prompt`, `idle_prompt` 等 |
| **SubagentStart** | サブエージェント起動 | No | - | エージェント種別名 |
| **SubagentStop** | サブエージェント完了 | Yes | - | エージェント種別名 |
| **Stop** | メインエージェント応答完了 | Yes | **使用中** | - |
| **TeammateIdle** | チームメンバーがアイドル移行 | Yes | - | - |
| **TaskCompleted** | タスク完了マーク | Yes | - | - |
| **ConfigChange** | 設定ファイル変更 | Yes | - | `user_settings`, `project_settings` 等 |
| **PreCompact** | コンテキスト圧縮直前 | No | - | `manual`, `auto` |

## stdin JSON 共通フィールド

全フックに渡される:

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../session.jsonl",
  "cwd": "/Users/myproject",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse"
}
```

## フックハンドラー3種類

| type | 説明 | async対応 |
|---|---|---|
| `command` | シェルコマンド実行 | Yes |
| `prompt` | LLM に評価させる（`{ "ok": true/false, "reason": "..." }` を返す） | No |
| `agent` | マルチターン検証（最大50ターン） | No |

## Exit Code

| code | 意味 |
|---|---|
| 0 | 成功。stdout の JSON を処理 |
| 2 | ブロッキングエラー。stderr を Claude へのエラーメッセージとして使用 |
| その他 | 非ブロッキングエラー。実行は継続 |

## PreToolUse の新仕様（hookSpecificOutput）

旧形式（deprecated だが互換あり）:

```python
print(json.dumps({
    "decision": "block",
    "reason": "理由"
}))
```

新形式:

```python
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",           # allow | deny | ask
        "permissionDecisionReason": "理由",
        "updatedInput": { "command": "..." },    # ツール入力の書き換え
        "additionalContext": "Claude への追加情報"
    }
}))
```

| permissionDecision | 効果 | reason の送り先 |
|---|---|---|
| `allow` | 権限バイパスして許可 | ユーザーに表示 |
| `deny` | ツール実行をブロック | **Claude に**表示 |
| `ask` | 通常の許可プロンプト表示 | ユーザーに表示 |

旧→新のマッピング: `"block"` → `"deny"`, `"approve"` → `"allow"`

## Stop の stop_hook_active

Stop hook の stdin に `stop_hook_active: true` が含まれる場合、既に Stop hook が
Claude を継続させた状態。チェックしないと**無限ループ**する。

```python
if hook_input.get("stop_hook_active"):
    sys.exit(0)
```

## MCP ツールのフック

MCP ツールも PreToolUse/PostToolUse で捕捉可能。
ツール名は `mcp__<サーバー名>__<ツール名>` 形式。

```json
{ "matcher": "mcp__memory__.*" }
```

PostToolUse の `hookSpecificOutput.updatedMCPToolOutput` で MCP ツールの出力を差し替え可能。

## Transcript JSONL 構造

各行が独立した JSON オブジェクト。

```jsonl
{"type": "user", "message": {"role": "user", "content": "テキスト"}}
{"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "..."}, {"type": "tool_use", "id": "...", "name": "Bash", "input": {...}}]}}
{"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "...", "content": "結果"}]}}
```

- `type == "user"` + content が `tool_result` のみ → ツール結果（実ユーザー入力ではない）
- `type == "assistant"` の content は配列。`{"type": "text"}` を抽出

## Discord API メモ

### メッセージ編集（PATCH）

送信済みメッセージを更新可能。進捗表示に使える。

```python
def edit_message(bot_token, channel_id, message_id, content):
    payload = json.dumps({"content": content}).encode()
    url = f"https://discord.com/api/v10/channels/{channel_id}/messages/{message_id}"
    req = urllib.request.Request(url, data=payload, headers={...}, method="PATCH")
    urllib.request.urlopen(req, timeout=10).close()
```

送信時にレスポンスを読むと `message_id` が取得できる。
編集のレート制限: 5件/15秒（送信の 5件/5秒 より厳しい）。

### ボタン無効化

`btn.update()` で元メッセージのボタンを削除/無効化できる:

```typescript
await btn.update({ content: `✅ 選択済み: ${label}`, components: [] });
```

### Embed（長文対応）

content は 2000文字制限だが、Embed description は **4096文字**。

```python
payload = {
    "embeds": [{
        "description": "長いテキスト（最大4096文字）",
        "color": 0x00FF00
    }]
}
```

### レート制限

| 種別 | 制限値 |
|---|---|
| Global | 50 リクエスト/秒 |
| per-channel 送信 | 約 5件/5秒 |
| per-channel 編集 | 約 5件/15秒 |
| Webhook | 5件/2秒 |

429 レスポンス時は `Retry-After` ヘッダーに従ってリトライ。

## 環境変数

| 変数 | 説明 |
|---|---|
| `$CLAUDE_PROJECT_DIR` | プロジェクトルート |
| `$CLAUDE_CODE_REMOTE` | リモートWeb環境では `"true"` |
| `$CLAUDE_ENV_FILE` | SessionStart のみ。ここに `export VAR=value` を書くと後続 Bash に継承 |

## discord-bridge の改善ポイント

1. **PreToolUse 新仕様対応** — `hookSpecificOutput` 形式に移行
2. **stop_hook_active チェック** — stop.py に無限ループ防止を追加
3. **ボタン無効化** — bot.ts で `btn.update()` を使用
4. ~~**途中経過通知**~~ — `pre_tool_progress.py` で実装済み（v1.7）。メッセージ編集方式への改善は今後検討
5. **Embed 長文対応** — 2000文字超のメッセージは Embed で送信
