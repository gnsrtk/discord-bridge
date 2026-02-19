# discord-bridge

A CLI tool that bridges Discord channels with Claude Code sessions running in tmux windows.

Send a message on Discord and it gets forwarded to the corresponding Claude Code session in tmux.
When Claude finishes responding, the result is automatically sent back to Discord.

## Architecture

```text
Discord (Mobile/PC)
       |  Send message
       v
  Discord Bot (discord.js)          <- Spawns a Bot instance per server
       |  Text / file attachments
       v
  TmuxSender
       |  tmux send-keys
       v
  tmux session:window               <- Isolated tmux session per server
       |  Claude Code processes
       v
  Claude Code Hooks (stop.py)       <- Auto-resolves Bot token & channel from cwd
       |  Discord API POST
       v
Discord channel reply
```

Supports multiple servers and projects. Each server has its own Bot token and tmux session.
Channels are mapped 1:1 to project directories and auto-resolved via longest-prefix match on cwd.

## Prerequisites

- **Node.js** 18+
- **tmux** 3.0+
- **Claude Code** 2.1.47+ (requires `last_assistant_message` field support)
- **Python** 3.10+ (for hooks)
- **Discord Bot token** (see below)

## Installation

```bash
git clone https://github.com/YOUR_USERNAME/discord-bridge.git
cd discord-bridge
bash install.sh
```

`install.sh` handles: prerequisite checks, build, `npm link`,
and `~/.discord-bridge/config.json` template generation.

## Setting Up the Discord Bot

1. Create an application on the [Discord Developer Portal](https://discord.com/developers/applications)
2. Go to **Bot** tab and generate a token
3. Enable **Message Content Intent** under **Privileged Gateway Intents**
4. Under **OAuth2 > URL Generator**, select scope `bot` with permissions
   `Send Messages / Read Message History / Attach Files`, then invite to your server
5. In the server's **Channel Settings > Permissions**, grant the Bot access to the channels

## Configuration

Create `~/.discord-bridge/config.json` (schemaVersion 2):

```json
{
  "schemaVersion": 2,
  "servers": [
    {
      "name": "personal",
      "discord": {
        "botToken": "YOUR_BOT_TOKEN_HERE",
        "guildId": "YOUR_GUILD_ID",
        "ownerUserId": "YOUR_DISCORD_USER_ID"
      },
      "tmux": {
        "session": "discord-bridge"
      },
      "projects": [
        {
          "name": "my-project",
          "channelId": "CHANNEL_ID_FOR_THIS_PROJECT",
          "projectPath": "/path/to/my-project",
          "model": "claude-sonnet-4-6"
        }
      ]
    }
  ]
}
```

### Configuration Fields

| Field | Description |
| --- | --- |
| `servers[].name` | Server identifier (used in log output) |
| `servers[].discord.botToken` | Discord Bot token |
| `servers[].discord.guildId` | Guild (server) ID where the Bot is invited (optional) |
| `servers[].discord.ownerUserId` | User ID allowed to send commands (recommended to restrict to one user for security) |
| `servers[].tmux.session` | tmux session name for this server (`discord-bridge start` creates it automatically) |
| `servers[].projects[].name` | tmux window name / identifier |
| `servers[].projects[].channelId` | Discord channel ID mapped to this project |
| `servers[].projects[].projectPath` | Absolute path to the directory where Claude Code is launched |
| `servers[].projects[].model` | Claude model to use (e.g., `claude-sonnet-4-6`) |

> **Important**: `servers` requires at least one entry. Each server's `projects` also requires at least one entry. `servers[0].projects[0]` is used as the fallback channel when cwd doesn't match any project.

> **Multiple servers**: Add multiple entries to the `servers` array and each will operate independently with its own Bot token and tmux session. A warning is displayed if the same channel ID is shared across servers.

> **Finding IDs**: Enable **Developer Mode** in Discord's **Settings > Advanced**, then right-click to copy IDs.

### Migrating from v1

Config files using schemaVersion 1 can be converted to v2 with `migrate_config.py`:

```bash
python3 migrate_config.py
```

The original file is backed up to `~/.discord-bridge/config.json.bak`.

## Claude Code Hooks Setup

Three hooks are required for Discord integration. To configure in `.claude/settings.json`:

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

Alternatively, add to your project's `CLAUDE.md` (or `~/.claude/CLAUDE.md`):

```markdown
## Hooks

- Stop: python3 /path/to/discord-bridge/hooks/stop.py
- Notification: python3 /path/to/discord-bridge/hooks/notify.py
- PreToolUse[AskUserQuestion]: python3 /path/to/discord-bridge/hooks/pre_tool_use.py
```

### Hook Roles

| File | Trigger | Role |
| --- | --- | --- |
| `hooks/stop.py` | Claude finishes responding | Sends Claude's last response (`last_assistant_message`) to Discord |
| `hooks/notify.py` | Claude fires a notification | Forwards important notifications to Discord (`idle_prompt` is excluded) |
| `hooks/pre_tool_use.py` | Before tool execution | Converts AskUserQuestion into a Discord message with buttons, blocking tool execution until the user responds |

## Usage

```bash
discord-bridge start   # Start in background
discord-bridge status  # Check status (shows PID)
discord-bridge stop    # Stop
```

Running `start` automatically:

1. Creates a tmux session for each server (if not already existing)
2. Creates a tmux window for each project and runs
   `cd <projectPath> && claude --model <model>` (skips if window already exists)
3. Starts a Discord Bot for each server and sends a startup notification to each project's channel
4. Saves PID to `~/.discord-bridge/discord-bridge.pid` and
   logs to `~/.discord-bridge/discord-bridge.log`

## How It Works

### Message Forwarding (Discord -> Claude Code)

1. The `ownerUserId` user posts a message in a mapped channel
2. The Bot receives the message and identifies the project by channel ID
3. Sends the text to the corresponding Claude Code session via `tmux send-keys`
4. If file attachments are present, they are downloaded to `/tmp/discord-uploads/` and paths are appended
   (timeout: 30s, max size: 50MB)

### Replies (Claude Code -> Discord)

1. When Claude Code finishes processing, the Stop hook (`stop.py`) is invoked
2. The last assistant message is extracted from the hook input's `last_assistant_message` field
3. The destination channel and Bot token are determined by longest-prefix matching cwd against each server's `projectPath`
4. Posted to Discord API (supports text + file attachments)

### Sending File Attachments (Claude -> Discord)

Include a `[DISCORD_ATTACH: filename]` marker in Claude's response to upload files
from `/tmp/discord-bridge-outputs/` to Discord.

- Only files under `/tmp/discord-bridge-outputs/` can be uploaded
- Specify a filename or relative path including subdirectories in the marker
- Paths pointing outside the allowed directory are ignored

```text
I've generated the image.

[DISCORD_ATTACH: output.png]
```

### Button Interactions

Discord button interactions are also supported.
The `customId` content is sent directly to the Claude Code session
(useful for Yes/No confirmations, etc.).

## Debugging

Set `DISCORD_BRIDGE_DEBUG=1` to enable debug log output to the following files.

This variable must be set in the environment where hooks (`stop.py` / `notify.py`) are executed by Claude Code.
Add it to `~/.zshrc` (or `~/.zprofile`) since `~/.claude/.env` is not inherited by hooks.

```bash
# Add to ~/.zshrc
export DISCORD_BRIDGE_DEBUG=1
```

| File | Source |
| --- | --- |
| `/tmp/discord-bridge-debug.txt` | `hooks/stop.py` |
| `/tmp/discord-bridge-notify-debug.txt` | `hooks/notify.py` |

## License

MIT License - See [LICENSE](LICENSE) for details.
