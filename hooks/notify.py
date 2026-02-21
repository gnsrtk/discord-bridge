#!/usr/bin/env python3
"""Notification hook: Claude確認待ちメッセージをDiscordに送信する"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lib.config import load_config, resolve_channel
from lib.thread import resolve_target_channel

DEBUG = os.environ.get("DISCORD_BRIDGE_DEBUG") == "1"


_RATE_LIMIT_MAX_RETRIES = 3


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
    for attempt in range(_RATE_LIMIT_MAX_RETRIES):
        try:
            urllib.request.urlopen(req, timeout=10).close()
            return
        except urllib.error.HTTPError as e:
            if e.code == 429:
                retry_after = float(e.headers.get("Retry-After", "1"))
                print(f"[notify.py] Rate limited (429). Waiting {retry_after}s (attempt {attempt + 1}/{_RATE_LIMIT_MAX_RETRIES})", file=sys.stderr)
                time.sleep(retry_after)
                continue
            print(f"[notify.py] API error: {e.code} {e.reason}", file=sys.stderr)
            raise
    raise urllib.error.URLError(f"Rate limit retries exhausted after {_RATE_LIMIT_MAX_RETRIES} attempts")


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
        channel_id, bot_token, _, _ = resolve_channel(config, cwd)
    except ValueError as e:
        print(f"[notify.py] Error: {e}", file=sys.stderr)
        sys.exit(1)

    target_channel = resolve_target_channel(channel_id)
    content = message or "(no message)"

    try:
        post_message(bot_token, target_channel, content)
    except urllib.error.URLError as e:
        print(f"[notify.py] API request failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
