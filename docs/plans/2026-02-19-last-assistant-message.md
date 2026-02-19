# Stop hook: last_assistant_message への移行計画

作成日: 2026-02-19

## 背景

Claude Code v2.1.47 で Stop hook の入力 JSON に `last_assistant_message` フィールドが追加された。

> Added `last_assistant_message` field to Stop and SubagentStop hook inputs,
> providing the final assistant response text so hooks can access it without
> parsing transcript files.

現在の `hooks/stop.py` は `transcript_path` の JSONL を自力でパースしてアシスタントメッセージを
収集しているが、このフィールドを利用することで大幅な簡略化が可能。

---

## `last_assistant_message` の仕様

| 項目 | 内容 |
| ---- | ---- |
| 型 | `string` |
| 内容 | 最後のアシスタントターンのテキストのみ（tool_use ブロック除外） |
| メッセージ数 | 最後の1つのみ（複数ターン分は含まない） |
| 空の場合 | tool_use のみで終わったターンなど（稀） |
| タイミング | hook input に直接入るため transcript 書き込みを待つ必要がない |

### hook input 例

```json
{
  "session_id": "abc123",
  "transcript_path": "~/.claude/projects/.../abc123.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "Stop",
  "stop_hook_active": false,
  "last_assistant_message": "再起動完了です（PID 39674）。"
}
```

---

## 現状の問題点と改善効果

### 現在の stop.py（transcript パース方式）

```text
hook 発火
  ↓
transcript_path の JSONL を読み込み
  ↓
アシスタントメッセージが見つからなければ 1 秒待機 × 最大 6 回（5 秒）
  ↓
全アシスタントメッセージを収集（複数の場合あり）
  ↓
メッセージ間に 1 秒待機しながら順次 Discord 送信
```

問題点:

- transcript 書き込みとの競合（race condition）→ 最大5秒のポーリングで対処
- 複数メッセージ送信 → Discord per-channel レート制限リスク（5件/5秒）
- transcript.py の複雑なパース処理が必要

### 移行後（last_assistant_message 方式）

```text
hook 発火
  ↓
hook_input["last_assistant_message"] を参照（即時）
  ↓
Discord に 1 件送信
```

### 改善比較

| 項目 | 現在 | 移行後 |
| ---- | ---- | ------ |
| transcript パース | 必要（lib/transcript.py） | 不要 |
| 最大待機時間 | 5 秒（6 リトライ） | 0 秒 |
| race condition リスク | あり | なし |
| Discord API 呼び出し数 | N 回（メッセージ数分） | 常に 1 回 |
| レート制限リスク | あり | ほぼゼロ |
| メッセージ間 delay | 1 秒 × (N-1) | 不要 |

---

## 移行方針

### 方針 A（採用）: 完全移行

`last_assistant_message` のみ使用。空の場合は送信しない。

採用理由:

- 上記の問題点がすべて解決する
- フォールバックに transcript パースを残す B 案は複雑さが増す割にメリットが小さい
- Claude は通常テキストでセッションを締めるため、空になるケースは稀

---

## 実装計画

### 変更対象ファイル

#### `hooks/stop.py`

- `get_assistant_messages()` 呼び出しを削除
- `hook_input["last_assistant_message"]` から直接テキスト取得
- 5秒待機ループを削除
- メッセージ間 1秒 delay を削除（1件のみになるため）
- `_send_request()` の 429 retry ロジックは残す（安全弁として）

#### `tests/test_hooks.py`

- `stop.py` の `get_assistant_messages` 依存テストを更新
- `last_assistant_message` を使った新テストケースを追加

### 変更しないもの

- `pre_tool_use.py` — AskUserQuestion 前テキストの取得には transcript.py が必要
- `hooks/lib/transcript.py` — pre_tool_use.py が依存しているため維持

### 変更しない理由（transcript.py）

Stop hook は `last_assistant_message` で代替できるが、PreToolUse hook は
hook input にアシスタントテキストが含まれないため、引き続き transcript パースが必要。

---

## 注意点

- `last_assistant_message` が `""` か `None` かは未確認
  → `if not hook_input.get("last_assistant_message"):` でどちらも対応可能
- 複数アシスタントメッセージをすべて Discord に送る挙動は失われる
  → 実運用上は「最後の完了メッセージ」1件で十分と判断
- mtime 重複防止ロジックは引き続き必要（Stop hook 2重発火対策）

---

## 関連 ISSUES

- #38: Discord レート制限（HTTP 429）→ 本移行で根本解決
- #39: Bot 再起動直後のメッセージ欠落 → race condition 解消で根本解決
