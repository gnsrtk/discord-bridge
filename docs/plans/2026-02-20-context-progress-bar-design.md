# Context Window Progress Bar

## Goal

Display context window usage as a progress bar in every Discord message footer.

## Architecture

```
Claude Code statusLine.command
  → hooks/statusline.py (receives JSON via stdin)
  → /tmp/discord-bridge-context-{session_id}.json (cache)

stop.py (on response)
  → reads cache file
  → appends progress bar footer to message
  → sends to Discord
```

## Data Source

Claude Code's `statusLine.command` receives:

```json
{
  "context_window": {
    "used_percentage": 62,
    "remaining_percentage": 38,
    "context_window_size": 200000
  },
  "session_id": "..."
}
```

## New File: hooks/statusline.py

- Reads stdin JSON from Claude Code statusLine
- Extracts `context_window.used_percentage` and `session_id`
- Writes to `/tmp/discord-bridge-context-{session_id}.json`
- Outputs statusLine text for CLI display (pass-through or custom)

## Modified: hooks/stop.py

- After composing the message, reads `/tmp/discord-bridge-context-{session_id}.json`
- Appends progress bar footer to message content
- Format: `\n\n📊 ██████░░░░ 62%`

## Display Format

10-block progress bar with severity emoji:

| Range | Emoji | Example |
|-------|-------|---------|
| 0-69% | 📊 | `📊 ██████░░░░ 62%` |
| 70-89% | ⚠️ | `⚠️ ████████░░ 80%` |
| 90-100% | 🚨 | `🚨 █████████░ 95%` |

## Configuration

Add to `.claude/settings.local.json`:

```json
{
  "statusLine": {
    "command": "python3 ~/projects/repos/discord-bridge/hooks/statusline.py"
  }
}
```

## Edge Cases

- Cache file missing (first message): no footer displayed
- Stale cache: statusLine updates frequently, should be fresh by stop.py execution
- Multiple sessions: session_id in filename prevents cross-contamination
