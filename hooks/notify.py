#!/usr/bin/env python3
"""Notification hook: Claude確認待ちメッセージをDiscordに送信する"""

import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lib.config import load_config, resolve_channel
from lib.thread import resolve_target_channel

DEBUG = os.environ.get("DISCORD_BRIDGE_DEBUG") == "1"


def post_message(bot_token: str, channel_id: str, content: str) -> None:
    payload = json.dumps({"content": content}).encode()
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
    try:
        urllib.request.urlopen(req, timeout=10).close()
    except urllib.error.HTTPError as e:
        print(f"[notify.py] API error: {e.code} {e.reason}", file=sys.stderr)
        raise


def main() -> None:
    try:
        hook_input = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(f"[notify.py] Failed to parse stdin: {e}", file=sys.stderr)
        sys.exit(1)

    if DEBUG:
        with open("/tmp/discord-bridge-notify-debug.txt", "w") as dbg:
            dbg.write(f"hook_input keys: {list(hook_input.keys())}\n")

    message = hook_input.get("message", "")
    notification_type = hook_input.get("notification_type", "")

    # idle_prompt は通知不要（ただの待機状態）
    if notification_type == "idle_prompt":
        sys.exit(0)

    try:
        config = load_config()
    except (OSError, KeyError, ValueError) as e:
        print(f"[notify.py] Config error: {e}", file=sys.stderr)
        sys.exit(1)

    cwd = hook_input.get("cwd", "")

    try:
        channel_id, bot_token, project_name, _ = resolve_channel(config, cwd)
    except ValueError as e:
        print(f"[notify.py] Error: {e}", file=sys.stderr)
        sys.exit(1)

    if project_name:
        title = "⚠️ Claude 確認待ち"
    else:
        cwd_label = Path(cwd).name if cwd else "unknown"
        title = f"⚠️ Claude 確認待ち [{cwd_label}]"

    if notification_type:
        title += f" [{notification_type}]"

    target_channel = resolve_target_channel(channel_id)

    try:
        post_message(bot_token, target_channel, f"{title}\n{message or '(no message)'}")
    except urllib.error.URLError as e:
        print(f"[notify.py] API request failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
