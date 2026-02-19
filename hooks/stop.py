#!/usr/bin/env python3
"""Stop hook: last_assistant_messageをDiscordに送信する"""

import json
import os
import re
import sys
import time
import uuid
import urllib.request
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lib.config import load_config, resolve_channel
from lib.transcript import get_assistant_messages

DEBUG = os.environ.get("DISCORD_BRIDGE_DEBUG") == "1"
_DEBUG_FILE = "/tmp/discord-bridge-debug.txt"
_dbg_initialized = False


def _dbg(msg: str) -> None:
    global _dbg_initialized
    if DEBUG:
        mode = "w" if not _dbg_initialized else "a"
        _dbg_initialized = True
        with open(_DEBUG_FILE, mode) as f:
            f.write(msg + "\n")

ATTACH_PATTERN = re.compile(r'\[DISCORD_ATTACH:\s*([^\]]+)\]')
QUESTION_PATTERN = re.compile(r'(ます|でしょう|しょう|です)か[？?]\s*$')
ATTACH_ALLOWED_DIR = "/tmp/discord-bridge-outputs"
DISCORD_MAX_FILE_BYTES = 25 * 1024 * 1024  # 25 MB


def is_question(text: str) -> bool:
    """テキスト末尾が日本語の質問パターンかどうかを判定する。"""
    return bool(QUESTION_PATTERN.search(text))


def extract_attachments(message: str) -> tuple[str, list[str]]:
    """[DISCORD_ATTACH: path] マーカーを抽出し、除去後テキストとパスリストを返す。"""
    paths: list[str] = []

    def _replace(m: re.Match) -> str:
        paths.append(m.group(1).strip())
        return ''

    clean = ATTACH_PATTERN.sub(_replace, message).strip()
    return clean, paths


def build_multipart(boundary: str, content: str, files: list[tuple[str, bytes]]) -> bytes:
    """multipart/form-data ボディを構築する。"""
    sep = f'--{boundary}\r\n'.encode()
    parts: list[bytes] = []

    parts.append(
        sep
        + b'Content-Disposition: form-data; name="payload_json"\r\n'
        + b'Content-Type: application/json\r\n'
        + b'\r\n'
        + json.dumps({"content": content} if content else {}).encode()
        + b'\r\n'
    )

    for i, (filename, data) in enumerate(files):
        parts.append(
            sep
            + f'Content-Disposition: form-data; name="files[{i}]"; filename="{filename}"\r\n'.encode()
            + b'Content-Type: application/octet-stream\r\n'
            + b'\r\n'
            + data
            + b'\r\n'
        )

    return b''.join(parts) + f'--{boundary}--\r\n'.encode()


def _sanitize_attach_path(path: str) -> str | None:
    """パスを正規化し、許可ディレクトリ配下であることを検証する。"""
    raw = path.strip()
    # 相対パスは許可ディレクトリからの相対として解釈
    if not os.path.isabs(raw):
        raw = os.path.join(ATTACH_ALLOWED_DIR, raw)
    resolved = os.path.realpath(raw)
    allowed = os.path.realpath(ATTACH_ALLOWED_DIR)
    if not resolved.startswith(allowed + os.sep):
        print(f"[stop.py] Rejected attachment outside allowed dir: {path!r} -> {resolved!r}", file=sys.stderr)
        return None
    if not os.path.isfile(resolved):
        print(f"[stop.py] Rejected non-file attachment: {resolved!r}", file=sys.stderr)
        return None
    return resolved


_RATE_LIMIT_MAX_RETRIES = 3


def _send_request(req: urllib.request.Request, timeout: int) -> None:
    """リクエストを送信する。429 の場合は Retry-After に従ってリトライする。"""
    for attempt in range(_RATE_LIMIT_MAX_RETRIES):
        try:
            urllib.request.urlopen(req, timeout=timeout).close()
            return
        except urllib.error.HTTPError as e:
            if e.code == 429:
                retry_after = float(e.headers.get("Retry-After", "1"))
                print(f"[stop.py] Rate limited (429). Waiting {retry_after}s (attempt {attempt + 1}/{_RATE_LIMIT_MAX_RETRIES})", file=sys.stderr)
                time.sleep(retry_after)
                continue
            print(f"[stop.py] API error: {e.code} {e.reason}", file=sys.stderr)
            raise
    raise urllib.error.URLError(f"Rate limit retries exhausted after {_RATE_LIMIT_MAX_RETRIES} attempts")


def post_message_with_files(
    bot_token: str, channel_id: str, content: str, file_paths: list[str]
) -> None:
    """テキスト + ファイル添付でメッセージを送信する。"""
    files: list[tuple[str, bytes]] = []
    for path in file_paths:
        safe_path = _sanitize_attach_path(path)
        if safe_path is None:
            print(f"[stop.py] Rejected invalid attachment path: {path!r}", file=sys.stderr)
            continue
        try:
            file_size = os.path.getsize(safe_path)
            if file_size > DISCORD_MAX_FILE_BYTES:
                print(
                    f"[stop.py] Skipping attachment exceeding 25 MB limit: {safe_path!r} ({file_size} bytes)",
                    file=sys.stderr,
                )
                continue
            with open(safe_path, 'rb') as f:
                files.append((Path(safe_path).name, f.read()))
        except OSError as e:
            print(f"[stop.py] Cannot read attachment {safe_path}: {e}", file=sys.stderr)

    if not files:
        post_message(bot_token, channel_id, content)
        return

    boundary = uuid.uuid4().hex
    body = build_multipart(boundary, content, files)
    url = f"https://discord.com/api/v10/channels/{channel_id}/messages"
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Authorization": f"Bot {bot_token}",
            "User-Agent": "DiscordBot (discord-bridge, 1.0.0)",
        },
        method="POST",
    )
    _send_request(req, timeout=30)


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
    _send_request(req, timeout=10)


def post_message_with_buttons(bot_token: str, channel_id: str, content: str) -> None:
    """テキスト + はい/いいえ/それ以外の3ボタン付きメッセージを送信する。"""
    components = [{
        "type": 1,  # ActionRow
        "components": [
            {"type": 2, "style": 1, "label": "はい", "custom_id": "0:はい"},
            {"type": 2, "style": 1, "label": "いいえ", "custom_id": "1:いいえ"},
            {"type": 2, "style": 2, "label": "それ以外", "custom_id": "__other__"},
        ],
    }]
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
    _send_request(req, timeout=10)


def main() -> None:
    try:
        hook_input = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(f"[stop.py] Failed to parse stdin: {e}", file=sys.stderr)
        sys.exit(1)

    transcript_path = hook_input.get("transcript_path", "")
    cwd = hook_input.get("cwd", "")
    session_id = hook_input.get("session_id", "")
    message = (hook_input.get("last_assistant_message") or "").strip()

    if DEBUG:
        _dbg(f"hook_input keys: {list(hook_input.keys())}")
        _dbg(f"last_assistant_message: {message[:100]!r}")

    # last_assistant_message が空の場合は transcript フォールバック（v2.1.47 未満の互換）
    if not message and transcript_path:
        _dbg("last_assistant_message empty, falling back to transcript")
        for attempt in range(6):
            msgs = get_assistant_messages(transcript_path)
            if msgs:
                message = msgs[-1]
                break
            if attempt < 5:
                time.sleep(1)

    if not message:
        _dbg("skipped: no assistant message")
        sys.exit(0)

    # transcript の mtime で重複判定（Interrupted時のStop再発火対策）
    # セッション単位でファイルを分離することで並行セッションの競合を防ぐ
    last_sent_file = Path(f"/tmp/discord-bridge-last-sent-{session_id}.txt")
    try:
        transcript_mtime = f"{Path(transcript_path).stat().st_mtime:.3f}" if transcript_path else "0"
    except OSError:
        transcript_mtime = "0"
    sent_key = f"{session_id}:{transcript_mtime}"
    try:
        if last_sent_file.read_text() == sent_key:
            _dbg(f"skipped: duplicate (mtime={transcript_mtime})")
            sys.exit(0)
    except OSError:
        pass
    last_sent_file.write_text(sent_key)

    try:
        config = load_config()
    except (OSError, KeyError, ValueError) as e:
        print(f"[stop.py] Config error: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        channel_id, bot_token, project_name, _ = resolve_channel(config, cwd)
    except ValueError as e:
        print(f"[stop.py] Error: {e}", file=sys.stderr)
        sys.exit(1)

    _dbg(f"cwd: {cwd!r} -> channel_id: {channel_id} project: {project_name!r}")

    # タイトル: プロジェクト一致なら "✅ Claude 完了"、general フォールバックなら cwd を付記
    if project_name:
        title = "✅ Claude 完了"
    else:
        cwd_label = Path(cwd).name if cwd else "unknown"
        title = f"✅ Claude 完了 [{cwd_label}]"

    clean_message, attach_paths = extract_attachments(message)
    display_text = f"{title}\n{clean_message}" if clean_message else title
    _dbg(f"sending: text={display_text[:40]!r} attach={len(attach_paths)}")
    try:
        if attach_paths:
            post_message_with_files(bot_token, channel_id, display_text, attach_paths)
        elif is_question(clean_message):
            post_message_with_buttons(bot_token, channel_id, display_text)
        else:
            post_message(bot_token, channel_id, display_text)
        _dbg("sent OK")
    except urllib.error.URLError as e:
        print(f"[stop.py] API request failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
