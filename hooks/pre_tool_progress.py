#!/usr/bin/env python3
"""PreToolUse hook (async): Claude の途中テキストを Discord に送信する。

ツール実行前に発火し、transcript から最新のアシスタントテキストを読み取って
Discord に進捗通知として送信する。重複送信はハッシュで防止する。
"""

import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lib.config import load_config, resolve_channel
from lib.thread import resolve_target_channel, clear_thread_tracking
from lib.transcript import get_assistant_messages

DEBUG = os.environ.get("DISCORD_BRIDGE_DEBUG") == "1"
MAX_CONTENT = 1900
SENT_HASH_DIR = "/tmp"
_RATE_LIMIT_MAX_RETRIES = 2


def _dbg(msg: str) -> None:
    if DEBUG:
        with open("/tmp/discord-bridge-debug.txt", "a") as f:
            f.write(f"[progress] {msg}\n")


def _sent_hash_path(session_id: str) -> Path:
    return Path(f"{SENT_HASH_DIR}/discord-bridge-progress-{session_id}.txt")


def _get_sent_hash(session_id: str) -> str:
    try:
        return _sent_hash_path(session_id).read_text().strip()
    except OSError:
        return ""


def _save_sent_hash(session_id: str, text_hash: str) -> None:
    _sent_hash_path(session_id).write_text(text_hash)


def _send_message(bot_token: str, channel_id: str, content: str) -> None:
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
                _dbg(f"rate limited, waiting {retry_after}s (attempt {attempt + 1})")
                time.sleep(retry_after)
                continue
            raise
    raise urllib.error.URLError("Rate limit retries exhausted")


def main() -> None:
    try:
        hook_input = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)

    tool_name = hook_input.get("tool_name", "")

    # AskUserQuestion / permissionTools は既存 pre_tool_use.py が処理
    if tool_name == "AskUserQuestion":
        _dbg("skip: AskUserQuestion")
        sys.exit(0)

    transcript_path = hook_input.get("transcript_path", "")
    session_id = hook_input.get("session_id", "unknown")
    cwd = hook_input.get("cwd", "")

    if not transcript_path:
        sys.exit(0)

    # transcript から最新アシスタントテキストを取得
    messages = get_assistant_messages(
        transcript_path, wait_for_content=True, tool_result_as_boundary=True
    )
    if not messages:
        _dbg("skip: no assistant text in transcript")
        sys.exit(0)

    text = "\n\n".join(messages)

    # Discord へ送信するコンテンツを先に組み立てる
    content = text[:MAX_CONTENT]
    if len(text) > MAX_CONTENT:
        content += "…"
    content = f"🔄 {content}"

    # 重複送信防止（送信コンテンツのハッシュで判定）
    content_hash = hashlib.md5(content.encode()).hexdigest()
    if content_hash == _get_sent_hash(session_id):
        _dbg(f"skip: duplicate hash {content_hash[:8]}")
        sys.exit(0)

    # 設定読み込み
    try:
        config = load_config()
        channel_id, bot_token, _, _ = resolve_channel(config, cwd)
    except (OSError, KeyError, ValueError) as e:
        _dbg(f"config error: {e}")
        sys.exit(0)

    target_channel = resolve_target_channel(channel_id)

    _dbg(f"sending: {content[:60]!r} -> {target_channel}")
    try:
        _send_message(bot_token, target_channel, content)
        _save_sent_hash(session_id, content_hash)
        _dbg("sent OK")
    except urllib.error.HTTPError as e:
        if e.code == 404 and target_channel != channel_id:
            _dbg(f"thread 404, fallback to {channel_id}")
            clear_thread_tracking(channel_id)
            try:
                _send_message(bot_token, channel_id, content)
                _save_sent_hash(session_id, content_hash)
            except Exception as e2:
                _dbg(f"fallback failed: {e2}")
        else:
            _dbg(f"send failed: {e}")
    except Exception as e:
        _dbg(f"send failed: {e}")


if __name__ == "__main__":
    main()
