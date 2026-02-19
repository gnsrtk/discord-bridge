# Multi-Server / Multi-Session 実装プラン

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `servers[]` トップレベル配列を導入し、複数 Discord サーバー（別 Bot トークン）+ 複数 tmux named session に対応する。

**Architecture:** schemaVersion を 1→2 に上げ、既存の `discord` / `tmux` / `projects` をすべて `servers[]` の下に移動。TS 側は `createServerBot(server)` をサーバーごとに呼び出し、Python フック側は `resolve_channel` の戻り値に `bot_token` を追加する。

**Tech Stack:** TypeScript / Node.js (ESM), Zod, discord.js v14, Python 3, pytest, Vitest

---

## Task 1: config.ts — schemaVersion 2 スキーマ実装

**Files:**
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`

### Step 1: テストを書く（失敗確認用）

`tests/config.test.ts` の `validConfig` を v2 形式に書き換え、v1 は reject されることも確認する。

```typescript
// tests/config.test.ts の validConfig を以下に差し替え
const validConfig = {
  schemaVersion: 2,
  servers: [
    {
      name: 'personal',
      discord: {
        botToken: 'Bot.token.here',
        guildId: '111111111111111111',
        ownerUserId: '222222222222222222',
      },
      tmux: { session: 'personal' },
      projects: [
        {
          name: 'test-project',
          channelId: '444444444444444444',
          projectPath: '/Users/test/projects/test-project',
          model: 'claude-sonnet-4-6',
        },
      ],
    },
  ],
};

// 追加テスト
test('v1 形式は reject される', () => {
  const v1 = {
    schemaVersion: 1,
    tmux: { session: 's' },
    discord: { botToken: 't', ownerUserId: 'o' },
    projects: [{ name: 'p', channelId: 'c', projectPath: '/p', model: 'm' }],
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(v1));
  expect(() => loadConfig(CONFIG_PATH)).toThrow();
});

test('servers が空配列は reject される', () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ schemaVersion: 2, servers: [] }));
  expect(() => loadConfig(CONFIG_PATH)).toThrow();
});

test('server.projects が空配列は reject される', () => {
  const cfg = { schemaVersion: 2, servers: [{ name: 's', discord: { botToken: 't', ownerUserId: 'o' }, tmux: { session: 's' }, projects: [] }] };
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
  expect(() => loadConfig(CONFIG_PATH)).toThrow();
});
```

### Step 2: テスト失敗を確認

```bash
npx vitest run tests/config.test.ts
```
Expected: FAIL（スキーマが v1 のまま）

### Step 3: src/config.ts を v2 に書き換える

```typescript
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ProjectSchema = z.object({
  name: z.string().min(1),
  channelId: z.string().min(1),
  projectPath: z.string().min(1),
  model: z.string().min(1),
});

const ServerSchema = z.object({
  name: z.string().min(1),
  discord: z.object({
    botToken: z.string().min(1),
    guildId: z.string().optional(),
    ownerUserId: z.string().min(1),
  }),
  tmux: z.object({
    session: z.string().min(1),
  }),
  projects: z.array(ProjectSchema).min(1),
});

const ConfigSchema = z.object({
  schemaVersion: z.literal(2),
  servers: z.array(ServerSchema).min(1),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Server = z.infer<typeof ServerSchema>;
export type Project = z.infer<typeof ProjectSchema>;

const DEFAULT_CONFIG_PATH = join(homedir(), '.discord-bridge', 'config.json');

export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): Config {
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  return ConfigSchema.parse(raw);
}
```

### Step 4: テスト通過を確認

```bash
npx vitest run tests/config.test.ts
```
Expected: PASS

### Step 5: ビルド確認

```bash
npm run build
```
Expected: 他ファイルで型エラーが出る（次 Task で修正）

### Step 6: コミット

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: config schema v2 - servers[] array"
```

---

## Task 2: hooks/lib/config.py — resolve_channel を v2 対応に変更

**Files:**
- Modify: `hooks/lib/config.py`
- Modify: `tests/test_hooks.py`

### Step 1: テストを書く

`tests/test_hooks.py` に `TestResolveChannel` クラスを追加（現在なければ）、v2 形式で動作確認。

```python
# tests/test_hooks.py に追加
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "hooks"))
from lib.config import resolve_channel

class TestResolveChannel:
    """hooks/lib/config.py の resolve_channel (v2) のテスト"""

    def _make_config(self, servers: list) -> dict:
        return {"schemaVersion": 2, "servers": servers}

    def _make_server(self, name: str, token: str, session: str, projects: list) -> dict:
        return {
            "name": name,
            "discord": {"botToken": token, "ownerUserId": "owner"},
            "tmux": {"session": session},
            "projects": projects,
        }

    def _make_project(self, name: str, channel: str, path: str) -> dict:
        return {"name": name, "channelId": channel, "projectPath": path, "model": "m"}

    def test_exact_match_returns_correct_server(self):
        """cwd が projectPath と完全一致する場合、正しいサーバーの情報を返す"""
        config = self._make_config([
            self._make_server("personal", "token-personal", "personal", [
                self._make_project("proj-a", "ch-a", "/home/user/proj-a"),
            ]),
            self._make_server("work", "token-work", "work", [
                self._make_project("proj-b", "ch-b", "/home/user/proj-b"),
            ]),
        ])
        channel_id, bot_token, project_name = resolve_channel(config, "/home/user/proj-b")
        assert channel_id == "ch-b"
        assert bot_token == "token-work"
        assert project_name == "proj-b"

    def test_prefix_match(self):
        """cwd がサブディレクトリの場合も一致する"""
        config = self._make_config([
            self._make_server("personal", "token-personal", "personal", [
                self._make_project("proj-a", "ch-a", "/home/user/proj-a"),
            ]),
        ])
        channel_id, bot_token, _ = resolve_channel(config, "/home/user/proj-a/src/components")
        assert channel_id == "ch-a"
        assert bot_token == "token-personal"

    def test_fallback_returns_first_server_first_project(self):
        """不一致時は servers[0].projects[0] にフォールバック"""
        config = self._make_config([
            self._make_server("personal", "token-personal", "personal", [
                self._make_project("proj-a", "ch-a", "/home/user/proj-a"),
            ]),
        ])
        channel_id, bot_token, project_name = resolve_channel(config, "/home/user/unknown")
        assert channel_id == "ch-a"
        assert bot_token == "token-personal"
        assert project_name is None

    def test_longest_prefix_wins(self):
        """より長いプレフィックスにマッチした project が優先される"""
        config = self._make_config([
            self._make_server("personal", "token-personal", "personal", [
                self._make_project("root", "ch-root", "/home/user"),
                self._make_project("nested", "ch-nested", "/home/user/nested"),
            ]),
        ])
        channel_id, _, project_name = resolve_channel(config, "/home/user/nested/src")
        assert channel_id == "ch-nested"
        assert project_name == "nested"

    def test_empty_servers_raises(self):
        """servers が空の場合は ValueError"""
        with pytest.raises(ValueError):
            resolve_channel({"servers": []}, "/some/path")
```

### Step 2: テスト失敗を確認

```bash
python -m pytest tests/test_hooks.py::TestResolveChannel -v
```
Expected: FAIL（関数が v1 形式のまま）

### Step 3: hooks/lib/config.py を実装

```python
import json
from pathlib import Path


def load_config() -> dict:
    config_path = Path.home() / ".discord-bridge" / "config.json"
    with open(config_path) as f:
        return json.load(f)


def resolve_channel(config: dict, cwd: str) -> tuple[str, str, str | None]:
    """cwd から (channel_id, bot_token, project_name) を解決する。
    servers[] をループし、projectPath × cwd で最長一致を選択。
    不一致時は servers[0].projects[0] にフォールバック。
    """
    best_channel_id: str | None = None
    best_bot_token: str | None = None
    best_project_name: str | None = None
    best_match_len = 0

    for server in config.get("servers", []):
        bot_token = server.get("discord", {}).get("botToken", "")
        for project in server.get("projects", []):
            pp = project.get("projectPath", "").rstrip("/")
            if pp and (cwd == pp or cwd.startswith(pp + "/")) and len(pp) > best_match_len:
                best_channel_id = project["channelId"]
                best_bot_token = bot_token
                best_project_name = project.get("name")
                best_match_len = len(pp)

    if best_channel_id and best_bot_token:
        return best_channel_id, best_bot_token, best_project_name

    # フォールバック
    servers = config.get("servers", [])
    if not servers or not servers[0].get("projects"):
        raise ValueError("servers is empty in config.json")
    first_server = servers[0]
    first_project = first_server["projects"][0]
    return (
        first_project["channelId"],
        first_server["discord"]["botToken"],
        None,
    )
```

### Step 4: テスト通過を確認

```bash
python -m pytest tests/test_hooks.py::TestResolveChannel -v
```
Expected: PASS（5件）

### Step 5: コミット

```bash
git add hooks/lib/config.py tests/test_hooks.py
git commit -m "feat: resolve_channel returns bot_token for multi-server support"
```

---

## Task 3: hooks — stop.py / notify.py / pre_tool_use.py の bot_token 取得変更

**Files:**
- Modify: `hooks/stop.py`
- Modify: `hooks/notify.py`
- Modify: `hooks/pre_tool_use.py`

### Step 1: stop.py の変更

`stop.py` の `main()` 内、bot_token 取得部分を変更:

```python
# 変更前
bot_token = config["discord"]["botToken"]
try:
    channel_id, project_name = resolve_channel(config, cwd)

# 変更後
try:
    channel_id, bot_token, project_name = resolve_channel(config, cwd)
```

`config["discord"]["botToken"]` の行を削除し、`resolve_channel` の戻り値から取得するように変更する。

### Step 2: notify.py の変更

```python
# 変更前
bot_token = config["discord"]["botToken"]
try:
    channel_id, project_name = resolve_channel(config, cwd)

# 変更後
try:
    channel_id, bot_token, project_name = resolve_channel(config, cwd)
```

`bot_token = config["discord"]["botToken"]` の行を削除。

### Step 3: pre_tool_use.py の変更

```python
# 変更前
bot_token = config["discord"]["botToken"]
try:
    channel_id, _ = resolve_channel(config, cwd)

# 変更後
try:
    channel_id, bot_token, _ = resolve_channel(config, cwd)
```

### Step 4: テスト通過を確認

```bash
python -m pytest tests/test_hooks.py -v
```
Expected: 既存テストすべて PASS

### Step 5: コミット

```bash
git add hooks/stop.py hooks/notify.py hooks/pre_tool_use.py
git commit -m "feat: hooks use bot_token from resolve_channel for multi-server"
```

---

## Task 4: src/bot.ts — createServerBot() に変更 + 重複 channelId 警告

**Files:**
- Modify: `src/bot.ts`
- Modify: `tests/bot-button.test.ts`（型更新）

### Step 1: bot.ts の変更

`createBot(config: Config)` を `createServerBot(server: Server)` に rename し、型参照を `Config` から `Server` に変更:

```typescript
// 変更前
export function createBot(config: Config): Client {
  const session = config.tmux.session;
  const defaultSender = new TmuxSender(`${session}:0`);
  const channelSenderMap = new Map<string, TmuxSender>();
  for (const project of config.projects) { ... }
  const listenChannelIds = new Set(config.projects.map((p) => p.channelId));
  // client.once(Events.ClientReady) 内: config.projects ...
  // config.discord.ownerUserId ...
}

// 変更後
import { type Config, type Server } from './config.js';

export function createServerBot(server: Server): Client {
  const session = server.tmux.session;
  const defaultSender = new TmuxSender(`${session}:0`);
  const channelSenderMap = new Map<string, TmuxSender>();
  for (const project of server.projects) {
    const target = `${session}:${project.name}`;
    channelSenderMap.set(project.channelId, new TmuxSender(target));
  }
  const listenChannelIds = new Set(server.projects.map((p) => p.channelId));
  // ClientReady 内: server.projects ...
  // server.discord.ownerUserId ...
}

export async function startServerBot(server: Server): Promise<Client> {
  const client = createServerBot(server);
  await client.login(server.discord.botToken);
  return client;
}

// 重複 channelId 警告（Config レベルで呼ぶ）
export function warnDuplicateChannels(config: Config): void {
  const seen = new Map<string, string>();
  for (const server of config.servers) {
    for (const project of server.projects) {
      const existing = seen.get(project.channelId);
      if (existing) {
        console.warn(
          `[discord-bridge] Warning: channelId "${project.channelId}" shared between "${existing}" and "${server.name}/${project.name}"`
        );
      } else {
        seen.set(project.channelId, `${server.name}/${project.name}`);
      }
    }
  }
}

// 後方互換のため旧名を残す（cli/index.ts が直接 startBot を呼んでいる場合）
// → Task 5 で cli/index.ts を修正するので不要
```

`createBot` / `startBot` は削除（cli/index.ts も同時に修正するので不整合にならない）。

### Step 2: テスト確認

```bash
npx vitest run tests/bot-button.test.ts tests/bot-attachment.test.ts
```
Expected: 型エラーがあれば修正後 PASS（テスト内の `createBot` 呼び出しを `createServerBot` に更新）

### Step 3: コミット

```bash
git add src/bot.ts tests/bot-button.test.ts tests/bot-attachment.test.ts
git commit -m "feat: createServerBot() for per-server bot instances"
```

---

## Task 5: cli/index.ts — servers ループに対応

**Files:**
- Modify: `cli/index.ts`
- Modify: `tests/cli-setup.test.ts`

### Step 1: setupTmuxWindows を servers ループに変更

```typescript
// 変更前
export function setupTmuxWindows(config: Config): void {
  const session = config.tmux.session;
  if (!tmuxSessionExists(session)) { ... }
  for (const project of config.projects) { ... }
}

// 変更後
export function setupTmuxWindowsForServer(server: Server): void {
  const session = server.tmux.session;
  if (!tmuxSessionExists(session)) {
    execFileSync('tmux', ['new-session', '-d', '-s', session]);
    console.log(`[discord-bridge] Session "${session}" created`);
  }
  for (const project of server.projects) {
    if (tmuxWindowExists(session, project.name)) continue;
    execFileSync('tmux', ['new-window', '-t', `${session}:`, '-n', project.name, '-d']);
    execFileSync('tmux', [
      'send-keys', '-t', `${session}:${project.name}`,
      `cd "${escapeTmuxShellArg(project.projectPath)}" && claude --model "${escapeTmuxShellArg(project.model)}"`,
      'Enter',
    ]);
    console.log(`[discord-bridge] Window "${project.name}" created → ${project.projectPath}`);
  }
}

export function setupTmuxWindows(config: Config): void {
  for (const server of config.servers) {
    setupTmuxWindowsForServer(server);
  }
}
```

### Step 2: runDaemon() を複数 Client 対応に変更

```typescript
async function runDaemon(): Promise<void> {
  const config = loadConfig();
  warnDuplicateChannels(config);
  setupTmuxWindows(config);

  const clients: Client[] = [];
  for (const server of config.servers) {
    const client = await startServerBot(server);
    clients.push(client);
  }

  const shutdown = () => {
    for (const client of clients) client.destroy();
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
```

import 文も更新:
```typescript
import { loadConfig, type Config, type Server } from '../src/config.js';
import { startServerBot, warnDuplicateChannels } from '../src/bot.js';
```

### Step 3: テスト確認と更新

```bash
npx vitest run tests/cli-setup.test.ts
```
`setupTmuxWindows` のテストが `setupTmuxWindowsForServer` を直接テストするよう更新が必要な場合は修正。

### Step 4: フルテスト実行

```bash
npm run build && npm test
```
Expected: すべて PASS

### Step 5: コミット

```bash
git add cli/index.ts tests/cli-setup.test.ts
git commit -m "feat: cli loops over servers[] for multi-session support"
```

---

## Task 6: migrate_config.py — v1→v2 移行スクリプト作成

**Files:**
- Create: `migrate_config.py`（プロジェクトルート）

### Step 1: スクリプトを作成

```python
#!/usr/bin/env python3
"""migrate_config.py — ~/.discord-bridge/config.json を schemaVersion 1 → 2 に変換する"""
import json
import shutil
import sys
from pathlib import Path

CONFIG_PATH = Path.home() / ".discord-bridge" / "config.json"
BACKUP_PATH = CONFIG_PATH.with_suffix(".json.bak")


def migrate(v1: dict) -> dict:
    if v1.get("schemaVersion") != 1:
        print(f"[migrate] schemaVersion が 1 ではありません ({v1.get('schemaVersion')}). スキップします。")
        sys.exit(0)

    return {
        "schemaVersion": 2,
        "servers": [
            {
                "name": "personal",
                "discord": v1["discord"],
                "tmux": v1["tmux"],
                "projects": v1["projects"],
            }
        ],
    }


def main() -> None:
    if not CONFIG_PATH.exists():
        print(f"[migrate] 設定ファイルが見つかりません: {CONFIG_PATH}")
        sys.exit(1)

    with open(CONFIG_PATH) as f:
        v1 = json.load(f)

    v2 = migrate(v1)

    shutil.copy2(CONFIG_PATH, BACKUP_PATH)
    print(f"[migrate] バックアップ作成: {BACKUP_PATH}")

    with open(CONFIG_PATH, "w") as f:
        json.dump(v2, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"[migrate] 変換完了: {CONFIG_PATH}")
    print("[migrate] servers[0].name は 'personal' に設定されました。必要に応じて編集してください。")


if __name__ == "__main__":
    main()
```

### Step 2: 動作確認（実行しない — ドライラン）

```bash
# 実際に実行する前に内容を確認
python3 -c "
import json
v1 = json.load(open('$HOME/.discord-bridge/config.json'))
print('schemaVersion:', v1.get('schemaVersion'))
print('projects count:', len(v1.get('projects', [])))
"
```

### Step 3: コミット

```bash
git add migrate_config.py
git commit -m "feat: migrate_config.py for v1 to v2 config migration"
```

---

## Task 7: 実際の config.json を v2 に移行する

**実行前確認:**
```bash
cat ~/.discord-bridge/config.json | python3 -c "import json,sys; d=json.load(sys.stdin); print('version:', d.get('schemaVersion'))"
```

**移行実行:**
```bash
python3 migrate_config.py
```

Expected:
```
[migrate] バックアップ作成: /Users/g_taki/.discord-bridge/config.json.bak
[migrate] 変換完了: /Users/g_taki/.discord-bridge/config.json
[migrate] servers[0].name は 'personal' に設定されました。必要に応じて編集してください。
```

**移行後の config を確認・編集:**
```bash
cat ~/.discord-bridge/config.json
# servers[0].name を適切な名前に編集（"personal" など）
```

---

## Task 8: 全テスト最終確認

### Step 1: Python テスト

```bash
python -m pytest tests/test_hooks.py -v
```
Expected: 全件 PASS

### Step 2: TypeScript テスト + ビルド

```bash
npm run build && npm test
```
Expected: 全件 PASS

### Step 3: 動作確認（Bot 再起動）

```bash
discord-bridge stop
discord-bridge start
discord-bridge status
```

Expected: `Running (PID xxxxx)`

### Step 4: 最終コミット

```bash
git add -p  # 残りの差分があれば
git commit -m "feat: v1.2 - multi-server and multi-session support"
```

---

## テスト実行コマンド早見表

| テスト対象 | コマンド |
|---|---|
| config.ts のみ | `npx vitest run tests/config.test.ts` |
| bot.ts のみ | `npx vitest run tests/bot-button.test.ts tests/bot-attachment.test.ts` |
| cli のみ | `npx vitest run tests/cli-setup.test.ts` |
| Python フック全件 | `python -m pytest tests/test_hooks.py -v` |
| 全 TS テスト | `npm test` |
| ビルド確認 | `npm run build` |
