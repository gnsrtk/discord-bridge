[日本語](README.md)

# discord-bridge

A CLI tool that bridges Discord channels with Claude Code sessions running in tmux windows.

Send a message on Discord and it gets forwarded to the corresponding Claude Code session in tmux.
When Claude finishes responding, the result is automatically sent back to Discord.

## Key Features

- **Bidirectional message relay** — Real-time relay between Discord and Claude Code on tmux
- **Multi-server / multi-project** — Isolate Bot tokens and tmux sessions per server
- **File attachments** — Pass images/files from Discord to Claude / Upload Claude's output to Discord
- **Thread support** — Automatically spawn independent Claude Code sessions (tmux panes) per thread
- **Button interactions** — Auto-detect `AskUserQuestion` tool and convert to Discord buttons (recommend enforcing usage in CLAUDE.md)
- **Tool permission confirmation** — Approve/deny execution of tools like `Bash` from Discord
- **Progress notifications** — Forward Claude's in-progress text to Discord in real-time with a `🔄` prefix before each tool call

> For detailed architecture and internals, see [docs/ARCHITECTURE_en.md](docs/ARCHITECTURE_en.md).

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
          "model": "claude-sonnet-4-6",
          "thread": {
            "model": "claude-sonnet-4-6",
            "permission": "bypassPermissions"
          }
        }
      ],
      "permissionTools": ["Bash"]
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
| `servers[].projects[].thread.model` | Model to use for thread panes (inherits `model` if omitted) |
| `servers[].projects[].thread.permission` | Permission mode for thread panes. Set `bypassPermissions` to launch with `--dangerously-skip-permissions` (default permissions if omitted) |
| `servers[].permissionTools` | List of tool names that require Discord permission confirmation before execution (e.g., `["Bash"]`). Defaults to empty |

> **Important**: `servers` requires at least one entry. Each server's `projects` also requires at least one entry. `servers[0].projects[0]` is used as the fallback channel when cwd doesn't match any project.

> **Multiple servers**: Add multiple entries to the `servers` array and each will operate independently with its own Bot token and tmux session. A warning is displayed if the same channel ID is shared across servers.

> **Finding IDs**: Enable **Developer Mode** in Discord's **Settings > Advanced**, then right-click to copy IDs.

## Claude Code Hooks Setup

Hooks are required for Discord integration (3 events / 4 commands). To configure in `.claude/settings.json`:

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

Alternatively, add to your project's `CLAUDE.md` (or `~/.claude/CLAUDE.md`):

```markdown
## Hooks

- Stop: python3 /path/to/discord-bridge/hooks/stop.py
- Notification: python3 /path/to/discord-bridge/hooks/notify.py
- PreToolUse: python3 /path/to/discord-bridge/hooks/pre_tool_use.py
- PreToolUse (async): python3 /path/to/discord-bridge/hooks/pre_tool_progress.py
```

> **Note**: The CLAUDE.md format does not support `async: true`. To enable progress notifications, use the `settings.json` configuration instead.

### Hook Roles

| File | Trigger | Role |
| --- | --- | --- |
| `hooks/stop.py` | Claude finishes responding | Sends Claude's last response (`last_assistant_message`) to Discord |
| `hooks/notify.py` | Claude fires a notification | Forwards important notifications to Discord (`idle_prompt` is excluded) |
| `hooks/pre_tool_use.py` | Before tool execution | Converts AskUserQuestion into a Discord message with buttons. Shows permission confirmation buttons for tools listed in `permissionTools` |
| `hooks/pre_tool_progress.py` | Before tool execution (async) | Sends Claude's in-progress text to Discord with a `🔄` prefix. Deduplication via MD5 hash of posted content |

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
| `/tmp/discord-bridge-debug.txt` | `hooks/stop.py` / `hooks/pre_tool_progress.py` (`[progress]` prefix) |
| `/tmp/discord-bridge-notify-debug.txt` | `hooks/notify.py` |

## License

MIT License - See [LICENSE](LICENSE) for details.
