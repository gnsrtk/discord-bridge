# Architecture

## Overview

```text
Discord (Mobile/PC)
       |  Send message
       v
  Discord Bot (discord.js)          <- Spawns a Bot instance per server
       |  Text / file attachments
       v
  TmuxSender
       |  tmux send-keys / load-buffer + paste-buffer
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

## Message Forwarding (Discord -> Claude Code)

1. The `ownerUserId` user posts a message in a mapped channel
2. The Bot receives the message and identifies the project by channel ID
3. Sends the text to the corresponding Claude Code session via `tmux send-keys`
4. If file attachments are present, they are downloaded to `/tmp/discord-uploads/` and paths are appended
   (timeout: 30s, max size: 50MB)

## Replies (Claude Code -> Discord)

1. When Claude Code finishes processing, the Stop hook (`stop.py`) is invoked
2. The last assistant message is extracted from the hook input's `last_assistant_message` field
3. The destination channel and Bot token are determined by longest-prefix matching cwd against each server's `projectPath`
4. Posted to Discord API (supports text + file attachments)

## Sending File Attachments (Claude -> Discord)

Include a `[DISCORD_ATTACH: filename]` marker in Claude's response to upload files
from `/tmp/discord-bridge-outputs/` to Discord.

- Only files under `/tmp/discord-bridge-outputs/` can be uploaded
- Specify a filename or relative path including subdirectories in the marker
- Paths pointing outside the allowed directory are ignored

```text
I've generated the image.

[DISCORD_ATTACH: output.png]
```

## Button Interactions

Discord button interactions are also supported.
The `customId` content is sent directly to the Claude Code session
(useful for Yes/No confirmations, etc.).

### AskUserQuestion (Recommended)

When Claude Code uses the `AskUserQuestion` tool, `pre_tool_use.py` automatically converts it into a Discord message with buttons. This is the recommended approach for all questions, confirmations, and choices presented to the user.

- Plain text questions are not converted to buttons — the user must manually type a response
- `AskUserQuestion` enables one-tap responses with clearly presented options
- Add an instruction to use `AskUserQuestion` in your CLAUDE.md to ensure consistent agent behavior

### Tool Permission Confirmation

When a tool listed in `permissionTools` (e.g., `Bash`) is about to execute, Discord displays **Allow / Deny / Other** buttons.

- **Allow** (green): Permits tool execution
- **Deny** (red): Blocks tool execution
- **Other**: Displays a prompt to enter a reason, and the next message can provide one
- If no response within 120 seconds, Claude Code's default behavior applies

### Thread Support

Messages can be sent and received from threads under monitored channels.

- When you send a message from a thread, a new pane is automatically created in the parent channel's tmux window with an independent Claude Code session
- The pane uses `thread.model` (falls back to `model`) and `thread.permission` to configure the Claude Code session
- Setting `thread.permission` to `bypassPermissions` launches the pane with `--dangerously-skip-permissions`
- Each thread has its own dedicated pane, operating independently from the parent channel's session
- Claude's responses are sent directly to the thread (controlled via the `DISCORD_BRIDGE_THREAD_ID` environment variable)
- Sending a message in the parent channel clears the active thread, and subsequent responses go to the parent channel
- When multiple threads are used in the same channel, each thread gets its own dedicated pane
- When a thread is archived, its corresponding pane is automatically terminated
- If pane communication fails, it automatically falls back to the parent channel's session

### Progress Notifications

`pre_tool_progress.py` (PreToolUse hook / async) retrieves the latest assistant text from the transcript before each tool call and sends it to Discord with a `🔄` prefix.

- Deduplication via MD5 hash of the posted content (identical messages are not resent)
- Skips `AskUserQuestion` tool calls (handled by `pre_tool_use.py`)
- Sends to the active thread if one exists, otherwise to the parent channel

### Context Window Progress Bar + Rate Limits

Displays context window usage and rate limit info at the end of every Discord message.

**Data flow:**

1. `~/.claude/statusline.py` receives context info from Claude Code's statusLine API
2. Same script fetches rate limit data via OAuth API (`/api/oauth/usage`) with 60s cache
3. Caches to `/tmp/discord-bridge-context-{session_id}.json`
4. `hooks/stop.py` reads the cache and appends the footer to the message

**Cache format:**
```json
{
  "used_percentage": 50,
  "rate_limits": {
    "five_hour": {"utilization": 45, "resets_at": "2026-02-21T12:00:00Z"},
    "seven_day": {"utilization": 12, "resets_at": "2026-02-25T12:00:00Z"}
  }
}
```

**Display format:**

`📊 █████░░░░░ 50% │ session:45%(2h30m) │ weekly:12%(5d03h)`

| Range | Progress bar |
|-------|---------|
| 0-69% | `📊` |
| 70-89% | `⚠️` |
| 90-100% | `🚨` |

**Related files:**
- `hooks/lib/context.py` — `format_footer()`, `format_progress_bar()`, `read_full_cache()`
- `~/.claude/statusline.py` — Cache writer (outside project)

## IPC Files

Communication between hooks and the Bot uses file-based IPC.

| File | Purpose |
| --- | --- |
| `/tmp/discord-bridge-thread-{parentChannelId}.json` | Active thread tracking (`{"threadId": "..."}` format) |
| `/tmp/discord-bridge-perm-{channelId}.json` | Tool permission confirmation response (`{"decision": "allow\|deny\|block"}` format) |
| `/tmp/discord-bridge-dedup-{sessionId}.json` | Stop hook duplicate send prevention |
| `/tmp/discord-bridge-progress-{sessionId}.txt` | `pre_tool_progress.py` deduplication (MD5 hash of posted content) |
| `/tmp/discord-bridge-debug.txt` | Debug log (`stop.py` / `pre_tool_progress.py` with `[progress]` prefix) |
| `/tmp/discord-bridge-notify-debug.txt` | Debug log (`notify.py`) |
