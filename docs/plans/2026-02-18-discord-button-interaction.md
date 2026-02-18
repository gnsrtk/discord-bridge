# Discord Button Interaction for AskUserQuestion

> **For Claude:** REQUIRED SUB-SKILL:
> Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** AskUserQuestion の呼び出しを PreToolUse hook で捕捉し、
Discord にボタン付きメッセージを送信。
ユーザーがボタンをクリックすると Bot が tmux に選択結果を inject する。

**Architecture:**

- `hooks/pre_tool_use.py`: PreToolUse hook で `tool_name == "AskUserQuestion"`
  を検知 → 質問+選択肢を Discord ボタンとして送信 →
  `{"decision": "block"}` でツールをブロック
- `src/bot.ts`: `InteractionCreate` イベントで ButtonInteraction を受け取り
  → 選択肢テキストを tmux inject → Discord に確認返信
- Claude は `reason` を受け取り「Discord ボタン待ち」と理解し、
  次のユーザーメッセージ（ボタン選択結果）で処理を続行

**Tech Stack:** Python 3 (urllib/json),
discord.js v14 (ButtonInteraction, ComponentType), TypeScript ESM, Vitest

---

## Task 1: hooks/pre_tool_use.py を作成

**Files:**

- Create: `hooks/pre_tool_use.py`

### Step 1: ファイルを作成する

```python
#!/usr/bin/env python3
"""PreToolUse hook: AskUserQuestion を Discord ボタンに変換する"""

import json
import sys
import urllib.request
import urllib.error
from pathlib import Path


def load_config() -> dict:
    config_path = Path.home() / ".discord-bridge" / "config.json"
    with open(config_path) as f:
        return json.load(f)


def post_buttons(bot_token: str, channel_id: str, content: str, components: list) -> None:
    payload = json.dumps({"content": content, "components": components}).encode()
    url = f"https://discord.com/api/v10/channels/{channel_id}/messages"
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bot {bot_token}",
            "User-Agent": "DiscordBot (discord-bridge, 1.0.0)",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        if resp.status not in (200, 201):
            print(f"[pre_tool_use.py] API error: {resp.status}", file=sys.stderr)


def build_components(questions: list) -> list:
    """AskUserQuestion の questions 配列から Discord ActionRow 配列を構築する。
    1 質問 = 1 ActionRow、各選択肢をボタンに変換（最大5個/row）。
    先頭の質問のみ対応（Discord API の ActionRow 上限5行 + UX 上の理由）。
    """
    components = []
    # 先頭の質問のみ処理
    q = questions[0]
    options = q.get("options", [])[:5]  # Discord は1行に最大5ボタン
    buttons = []
    for opt in options:
        label = opt.get("label", "")[:80]  # custom_id/label は100文字以内
        buttons.append({
            "type": 2,       # Button
            "style": 1,      # Primary (青)
            "label": label,
            "custom_id": label,
        })
    if buttons:
        components.append({"type": 1, "components": buttons})  # ActionRow
    return components


def main() -> None:
    try:
        hook_input = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(f"[pre_tool_use.py] Failed to parse stdin: {e}", file=sys.stderr)
        sys.exit(1)

    tool_name = hook_input.get("tool_name", "")
    if tool_name != "AskUserQuestion":
        sys.exit(0)  # 他のツールは素通り

    tool_input = hook_input.get("tool_input", {})
    questions = tool_input.get("questions", [])
    if not questions:
        sys.exit(0)

    cwd = hook_input.get("cwd", "")

    try:
        config = load_config()
    except (OSError, KeyError) as e:
        print(f"[pre_tool_use.py] Config error: {e}", file=sys.stderr)
        sys.exit(1)

    bot_token = config["discord"]["botToken"]

    # cwd → projectPath でチャンネルを決定
    channel_id = None
    for project in config.get("projects", []):
        if cwd == project.get("projectPath", ""):
            channel_id = project["channelId"]
            break
    if not channel_id:
        channel_id = config["discord"]["generalChannelId"]

    q = questions[0]
    question_text = q.get("question", "(質問なし)")
    content = f"**❓ {question_text}**"

    components = build_components(questions)

    try:
        post_buttons(bot_token, channel_id, content, components)
    except urllib.error.URLError as e:
        print(f"[pre_tool_use.py] API request failed: {e}", file=sys.stderr)
        sys.exit(1)

    # ツールをブロックして Claude に Discord 待機を伝える
    result = {
        "decision": "block",
        "reason": "Question sent to Discord as buttons. Please wait for the user's selection.",
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
```

### Step 2: 手動テストでブロック動作を確認する

```bash
echo '{"tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"どれにする?","header":"選択","options":[{"label":"A案","description":"Aです"},{"label":"B案","description":"Bです"},{"label":"C案","description":"Cです"}],"multiSelect":false}]},"cwd":"/Users/g_taki/projects/repos/discord-bridge"}' \
  | python3 hooks/pre_tool_use.py
```

期待値: `{"decision": "block", "reason": "Question sent to Discord..."}` が
stdout に出力され、Discord に3択ボタンが届く

### Step 3: 非 AskUserQuestion ツールで素通りを確認する

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"ls"},"cwd":"/tmp"}' \
  | python3 hooks/pre_tool_use.py
echo "exit: $?"
```

期待値: 出力なし、exit 0

### Step 4: コミット

```bash
git add hooks/pre_tool_use.py
git commit -m "feat: add pre_tool_use.py to convert AskUserQuestion to Discord buttons"
```

---

## Task 2: bot.ts に ButtonInteraction ハンドラを追加 (TDD)

**Files:**

- Create: `tests/bot-button.test.ts`
- Modify: `src/bot.ts`

### Step 1: 失敗するテストを書く

`tests/bot-button.test.ts` を作成:

```typescript
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { handleButtonInteraction } from '../src/bot.js';
import { TmuxSender } from '../src/tmux-sender.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';

describe('handleButtonInteraction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('channelSenderMap に一致するチャンネルの TmuxSender でテキストを送る', () => {
    const sender1 = new TmuxSender('0:1');
    const sender2 = new TmuxSender('0:2');
    const map = new Map([
      ['ch-111', sender1],
      ['ch-222', sender2],
    ]);
    const defaultSender = new TmuxSender('0:0');

    handleButtonInteraction('ch-222', '選択肢B', map, defaultSender);

    const calls = vi.mocked(execFileSync).mock.calls;
    // sender2 (0:2) の send-keys が呼ばれること
    expect(calls[0]).toEqual(['tmux', ['send-keys', '-t', '0:2', '-l', '選択肢B'], { stdio: 'inherit' }]);
  });

  test('channelSenderMap に一致しない場合は defaultSender を使う', () => {
    const map = new Map<string, TmuxSender>();
    const defaultSender = new TmuxSender('0:0');

    handleButtonInteraction('unknown-ch', 'Option X', map, defaultSender);

    const calls = vi.mocked(execFileSync).mock.calls;
    expect(calls[0]).toEqual(['tmux', ['send-keys', '-t', '0:0', '-l', 'Option X'], { stdio: 'inherit' }]);
  });
});
```

### Step 2: テストが失敗することを確認する

```bash
npm test tests/bot-button.test.ts
```

期待値: `handleButtonInteraction is not a function` などのエラーで FAIL

### Step 3: src/bot.ts に handleButtonInteraction を実装する

InteractionCreate ハンドラを追加:

```typescript
import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type ButtonInteraction,
  ComponentType,
} from 'discord.js';
import { type Config } from './config.js';
import { TmuxSender } from './tmux-sender.js';

export function handleButtonInteraction(
  channelId: string,
  customId: string,
  channelSenderMap: Map<string, TmuxSender>,
  defaultSender: TmuxSender,
): void {
  const sender = channelSenderMap.get(channelId) ?? defaultSender;
  sender.send(customId);
}

export function createBot(config: Config): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const defaultSender = new TmuxSender(config.tmux.Target);

  const channelSenderMap = new Map<string, TmuxSender>();
  for (const project of config.projects) {
    const target = project.tmuxTarget ?? config.tmux.Target;
    channelSenderMap.set(project.channelId, new TmuxSender(target));
  }

  const listenChannelIds = new Set([
    config.discord.generalChannelId,
    ...config.projects.map((p) => p.channelId),
  ]);

  client.once(Events.ClientReady, (c) => {
    console.log(`[discord-bridge] Bot ready: ${c.user.tag}`);
  });

  client.on(Events.MessageCreate, (msg: Message) => {
    if (msg.author.bot) return;
    if (msg.author.id !== config.discord.ownerUserId) return;
    if (!listenChannelIds.has(msg.channelId)) return;
    const sender = channelSenderMap.get(msg.channelId) ?? defaultSender;
    sender.send(msg.content);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    if (interaction.user.id !== config.discord.ownerUserId) {
      await interaction.reply({ content: 'Unauthorized', ephemeral: true });
      return;
    }
    const btn = interaction as ButtonInteraction;
    handleButtonInteraction(btn.channelId, btn.customId, channelSenderMap, defaultSender);
    await btn.reply({ content: `✅ 選択: ${btn.customId}`, ephemeral: true });
  });

  return client;
}

export async function startBot(config: Config): Promise<Client> {
  const client = createBot(config);
  await client.login(config.discord.botToken);
  return client;
}
```

### Step 4: テストが通ることを確認する

```bash
npm test tests/bot-button.test.ts
```

期待値: 2件 PASS

### Step 5: 全テストが通ることを確認する

```bash
npm test
```

期待値: 全件 PASS（config 3件 + tmux-sender 2件 + bot-button 2件 = 7件）

### Step 6: ビルドが通ることを確認する

```bash
npm run build
```

期待値: エラーなし、`dist/` 更新

### Step 7: コミット

```bash
git add src/bot.ts tests/bot-button.test.ts
git commit -m "feat: add ButtonInteraction handler to bot.ts"
```

---

## Task 3: PreToolUse hook を settings.json に登録する

**Files:**

- Modify: `~/.claude/settings.json`

### Step 1: hooks.PreToolUse セクションを追加する

`~/.claude/settings.json` の `hooks` オブジェクトに以下を追加:

```json
"PreToolUse": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "python3 ~/projects/repos/discord-bridge/hooks/pre_tool_use.py"
      }
    ]
  }
]
```

### Step 2: JSON が valid であることを確認する

```bash
python3 -m json.tool ~/.claude/settings.json > /dev/null && echo "OK"
```

期待値: `OK`

### Step 3: コミット

```bash
git add hooks/pre_tool_use.py  # 念のため最新状態を確認
git status
```

---

## Task 4: Bot 再起動 & E2E テスト

### Step 1: Bot を再起動する

```bash
pkill -f "discord-bridge start" && sleep 1 && discord-bridge start &
sleep 2 && ps aux | grep "discord-bridge start" | grep -v grep
```

期待値: 新しい PID でプロセスが起動していること

### Step 2: AskUserQuestion を手動でトリガーして E2E テストする

Claude Code CLI で以下を実行し、PreToolUse hook が動作することを確認:

```text
AskUserQuestion でテストしてください。「どの方針にしますか？」という質問で
A案/B案/C案 の3択を出してください
```

確認ポイント:

1. Discord の discord-bridge チャンネルに「**❓ どの方針にしますか？**」と
   3つのボタンが届く
2. ターミナル上では AskUserQuestion がブロックされ Claude は待機状態になる
3. Discord でボタンをクリックする → Bot が `✅ 選択: A案` などと ephemeral reply する
4. tmux window 1 に選択テキストが inject される
5. Claude が選択結果を受け取って処理を続行する

---

## 制約・既知の制限

- **多質問対応なし**: `questions[0]` のみ処理。複数質問は将来対応。
- **multiSelect 非対応**: `multiSelect: true` の場合もボタン表示になる
  （将来 StringSelect に対応予定）。
- **"Other" 選択肢なし**: Discord ボタンには "Other" を追加しない。
  自由テキストが必要な場合はユーザーがチャンネルに直接テキストを入力すれば
  tmux inject される。
- **ボタン無効化なし**: クリック後、元のメッセージのボタンは残る
  （将来改善予定）。
