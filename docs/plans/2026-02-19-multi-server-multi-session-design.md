# Multi-Server / Multi-Session 対応設計

Date: 2026-02-19

## 概要

現在の discord-bridge は 1 つの tmux セッション・1 つの Discord サーバー（Bot トークン）に固定されている。
本設計では **複数の tmux named session** と **複数の Discord サーバー（別 Bot トークン）** に対応する。

## ユースケース

- 個人用 Discord サーバー + tmux session `personal`
- 仕事用 Discord サーバー + tmux session `work`
- それぞれ別 Bot トークンで分離

---

## 設計方針

**アプローチ A: `servers[]` トップレベル配列** を採用。

各 server エントリが `discord`（Bot トークン）+ `tmux`（セッション名）+ `projects[]` を内包する。
個人・仕事が完全に分離され、設定の見通しが良い。

---

## 変更点

### 1. Config スキーマ (schemaVersion 1 → 2)

**旧 (v1):**
```json
{
  "schemaVersion": 1,
  "tmux": { "session": "discord-bridge" },
  "discord": { "botToken": "...", "ownerUserId": "..." },
  "projects": [...]
}
```

**新 (v2):**
```json
{
  "schemaVersion": 2,
  "servers": [
    {
      "name": "personal",
      "discord": { "botToken": "...", "guildId": "...", "ownerUserId": "..." },
      "tmux": { "session": "personal" },
      "projects": [
        { "name": "discord-bridge", "channelId": "...", "projectPath": "...", "model": "..." }
      ]
    },
    {
      "name": "work",
      "discord": { "botToken": "...", "ownerUserId": "..." },
      "tmux": { "session": "work" },
      "projects": [
        { "name": "freightmax", "channelId": "...", "projectPath": "...", "model": "..." }
      ]
    }
  ]
}
```

- トップレベルの `tmux` / `discord` / `projects` は廃止
- `guildId` は server 配下のオプション
- `ownerUserId` は server ごとに必須（異なる Discord アカウントも可）

### 2. Bot (src/config.ts, src/bot.ts, src/index.ts)

**src/config.ts:**
- `ServerSchema` を新設（name + discord + tmux + projects）
- `ConfigSchema` を `schemaVersion: 2` + `servers: z.array(ServerSchema).min(1)` に変更
- `Server` / `Config` 型を export

**src/bot.ts:**
- `createBot(config: Config)` → `createServerBot(server: Server)` に変更
- tmux target = `${server.tmux.session}:${project.name}`（形式は維持、セッション名が server 固有になる）
- 起動時バリデーション: 全 server の channelId をフラット化し、重複があれば `console.warn` を出力（エラーにはしない）

**src/index.ts:**
```typescript
for (const server of config.servers) {
  await startServerBot(server);
}
```

### 3. フック (hooks/lib/config.py)

`resolve_channel` のシグネチャ変更:

```python
# 旧
def resolve_channel(config, cwd) -> tuple[str, str | None]:
    # returns (channel_id, project_name)

# 新
def resolve_channel(config, cwd) -> tuple[str, str, str | None]:
    # returns (channel_id, bot_token, project_name)
    # config["servers"] をループして projectPath × cwd でマッチ
```

- stop.py / notify.py / pre_tool_use.py は `bot_token` を `resolve_channel` の戻り値から取得するよう変更
- フォールバック（cwd 不一致）は `servers[0].projects[0]` の channel_id + bot_token

### 4. マイグレーション

`migrate_config.py` を同梱:

```python
# v1 → v2 変換スクリプト
# ~/.discord-bridge/config.json を変換し、元ファイルを .bak でバックアップ
```

- schemaVersion 1 の後方互換は持たない（Bot / フックともに v2 のみサポート）
- 変換後は `servers[0]` に全プロジェクトが入った状態（既存動作を維持）
- 追加サーバーは手動で servers[] に追記

---

## バリデーション

| チェック内容 | タイミング | 結果 |
|---|---|---|
| `servers` が空 | 起動時 / フック | エラー終了 |
| 同一 channelId が複数 server に存在 | 起動時 | `console.warn`（警告のみ） |
| `botToken` / `ownerUserId` が空 | 起動時 / フック | エラー終了 |

---

## 影響範囲

| ファイル | 変更種別 |
|---|---|
| `src/config.ts` | スキーマ変更 |
| `src/bot.ts` | `createServerBot()` への変更 |
| `src/index.ts` | servers ループ追加 |
| `hooks/lib/config.py` | `resolve_channel` 戻り値変更 |
| `hooks/stop.py` | bot_token 取得元変更 |
| `hooks/notify.py` | bot_token 取得元変更 |
| `hooks/pre_tool_use.py` | bot_token 取得元変更 |
| `migrate_config.py` | 新規追加 |
| `tests/` | スキーマ・フック関連テスト更新 |
