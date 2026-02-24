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
       |  tmux send-keys -l (bracketed paste)
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
If `cwd` does not match any `projectPath`, hooks exit silently without sending to Discord.

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

- Each option's `description` is displayed as a bullet list below the question text
- Row 1: option buttons (blue, up to 5)
- Row 2: "Other (text input)" button (gray) — for free-form responses
- After pressing a button, it is removed from the message and the selection is displayed
- When "Other" is pressed, the message shows "📝 Please enter your response"
- Plain text questions are not converted to buttons — the user must manually type a response
- Add an instruction to use `AskUserQuestion` in your CLAUDE.md to ensure consistent agent behavior

### Tool Permission Confirmation

When a tool listed in `permissionTools` (e.g., `Bash`) is about to execute, Discord displays **Allow / Deny / Other** buttons.

- **Allow** (green): Permits tool execution
- **Deny** (red): Blocks tool execution
- **Other**: Displays a prompt to enter a reason, and the next message can provide one
- If no response within 120 seconds, Claude Code's default behavior applies

### Plan Mode Approval (ExitPlanMode)

When Claude Code's Plan mode calls `ExitPlanMode`, Discord displays **Approve / Reject** buttons.

**Flow:**
1. `pre_tool_use.py`: Sends buttons to Discord, then denies the tool call (Claude Code enters a waiting state)
2. User presses **Approve** on Discord
3. `bot.ts`: Writes flag file `/tmp/discord-bridge-plan-approved-{channelId}` + sends `approve` via tmux
4. Claude Code receives the tmux input and calls `ExitPlanMode` again
5. `pre_tool_use.py`: Finds the flag file → allows → Claude transitions to implementation phase

- **Reject** (red): Sends `reject` via tmux; Claude stays in plan mode. Feedback can be sent as a regular message
- Button message includes the plan summary extracted from the transcript

### Thread Support

Messages can be sent and received from threads under monitored channels.

- When you send a message from a thread, a new pane is automatically created in the parent channel's tmux window with an independent Claude Code session
- Each thread has its own dedicated pane, operating independently from the parent channel's session
- Claude's responses are sent directly to the thread (controlled via the `DISCORD_BRIDGE_THREAD_ID` environment variable)
- Sending a message in the parent channel clears the active thread, and subsequent responses go to the parent channel
- When multiple threads are used in the same channel, each thread gets its own dedicated pane
- When a thread is archived, its corresponding pane is automatically terminated
- If pane communication fails, it automatically falls back to the parent channel's session

#### Per-Thread Config Template (3-Layer Merge)

Each thread can individually override `model`, `projectPath`, `permission`, and `isolation`. Resolution priority (highest first):

```
threads[i] fields
  → project.thread defaults (if omitted)  ※ projectPath skips this layer
    → project fields (if omitted)
```

> **Note**: `projectPath` is not defined in `project.thread`, so it uses a 2-layer merge (`threads[i].projectPath` → `project.projectPath`). Only `model`, `permission`, and `isolation` use the full 3-layer merge.

- Settings defined in a `threads[]` entry apply only to that thread
- Setting `permission: "bypassPermissions"` launches the pane with `--dangerously-skip-permissions`
- Settings for dynamically created threads (model, projectPath, permission, isolation) are automatically saved to `config.json`'s `threads[]`
- `startup: true` on a thread entry auto-creates its pane on Bot startup

#### Worktree Isolation (opt-in)

Setting `isolation: "worktree"` in config (via `project.thread` or a `threads[]` entry) launches thread panes with Claude Code's `--worktree` (`-w`) flag, providing an isolated working environment via git worktree.

- View each thread's changes from the main channel with `git worktree list` or `git diff`
- Pane and worktree state is persisted in `~/.discord-bridge/thread-state.json`
- Auto-recovery on restart after crash (worktree exists + pane gone → recreate pane)
- Scans `.claude/worktrees/` on startup to detect and warn about orphaned worktrees
- Force-removes worktree on thread archive (warns if uncommitted changes exist)
- Notifies thread to archive when worktree is removed externally

### Control Panel

When `generalChannelId` is configured, a control panel is posted to that channel on Bot startup. It is refreshed by user actions (sending a message or pressing a button).

- Lists each project's status (🟢 running / ⭕ stopped)
- **▶ Start / 🛑 Stop** buttons to create or kill the project's tmux window
- Shows the list of active worktrees

#### Auto-Start (startup)

The `startup` field in `config.json` controls automatic startup on Bot launch.

- `project.startup: true` → automatically creates the project's tmux window on Bot startup
- `project.startup: false` (default) and the window is running → stops the window on Bot startup
- `threads[i].startup: true` → automatically creates that thread's pane on Bot startup

### Progress Notifications

`pre_tool_progress.py` (PreToolUse hook / async) retrieves the latest assistant text from the transcript before each tool call and sends it to Discord with a `🔄` prefix.

- Deduplication via MD5 hash of the posted content (identical messages are not resent)
- Skips `AskUserQuestion` tool calls (handled by `pre_tool_use.py`)
- Sends to the active thread if one exists, otherwise to the parent channel

### Context / Model / Rate Limit Footer

Displays model name, context window usage, and rate limit info at the end of every Discord message.

**Data flow:**

1. `~/.claude/statusline.py` receives context info and model name from Claude Code's statusLine API
2. Same script fetches rate limit data via OAuth API (`/api/oauth/usage`) with 60s cache
3. Caches to `/tmp/discord-bridge-context-{session_id}.json`
4. `hooks/stop.py` reads the cache and appends the footer to the message

**Cache format:**
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

**Display format:**

`📊 Opus 4.6 50% │ session:45%(2h30m) │ weekly:12%(5d03h)`

**Related files:**
- `hooks/lib/context.py` — `format_footer()`, `format_context_status()`, `read_full_cache()`
- `~/.claude/statusline.py` — Cache writer (outside project)

## IPC Files

Communication between hooks and the Bot uses file-based IPC.

| File | Purpose |
| --- | --- |
| `/tmp/discord-bridge-thread-{parentChannelId}.json` | Active thread tracking (`{"threadId": "..."}` format) |
| `/tmp/discord-bridge-perm-{channelId}.json` | Tool permission confirmation response (`{"decision": "allow\|deny\|block"}` format) |
| `/tmp/discord-bridge-plan-approved-{channelId}` | Plan mode pre-approval flag (empty file, deleted immediately after read) |
| `/tmp/discord-bridge-last-sent-{sessionId}.txt` | Stop hook duplicate send prevention (plain text: `{sessionId}:{transcript_mtime}`) |
| `/tmp/discord-bridge-progress-{sessionId}.txt` | `pre_tool_progress.py` deduplication (MD5 hash of posted content) |
| `/tmp/discord-bridge-debug.txt` | Debug log (`stop.py` / `pre_tool_progress.py` with `[progress]` prefix) |
| `/tmp/discord-bridge-notify-debug.txt` | Debug log (`notify.py`) |
| `~/.discord-bridge/thread-state.json` | Persistent thread pane and worktree state |
