"""Transcript reading utilities shared across hooks."""
from __future__ import annotations

import json
import time
from pathlib import Path


def get_assistant_messages(
    transcript_path: str,
    max_chars: int = 1500,
    wait_for_content: bool = False,
    tool_result_as_boundary: bool = False,
) -> list[str]:
    """最後のユーザーメッセージより後にある、テキストを含む全アシスタントメッセージを取得する。

    Args:
        transcript_path: transcript ファイルのパス
        max_chars: 各メッセージの最大文字数
        wait_for_content: True の場合、内容が見つかるまで最大1秒リトライする
                          （PreToolUse hook 等、transcript 書き込みタイミングが不定な場合に使用）
        tool_result_as_boundary: True の場合、tool_result のみの user エントリも境界として扱う
                                  （同一ターン内で AskUserQuestion が複数回呼ばれる場合に
                                   直前の AQ の回答を境界にして古いテキストの混入を防ぐ）
    """
    attempts = 3 if wait_for_content else 1
    for attempt in range(attempts):
        messages = _read_messages(transcript_path, max_chars, tool_result_as_boundary)
        if messages:
            return messages
        if attempt < attempts - 1:
            time.sleep(0.5)
    return []


def _is_tool_result_only(content: object) -> bool:
    """content が tool_result のみのリストかどうか判定する。"""
    return (
        isinstance(content, list)
        and bool(content)
        and all(isinstance(c, dict) and c.get("type") == "tool_result" for c in content)
    )


def _read_messages(
    transcript_path: str, max_chars: int, tool_result_as_boundary: bool
) -> list[str]:
    entries = []
    try:
        with open(transcript_path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        return []

    last_user_pos = -1
    for i, entry in enumerate(entries):
        entry_type = entry.get("type")
        # compact 後の summary エントリは境界として扱い、古いメッセージを除外する
        if entry_type == "summary":
            last_user_pos = i
            continue
        if entry_type != "user":
            continue
        content = entry.get("message", {}).get("content", "")
        is_tool_result = _is_tool_result_only(content)
        # tool_result_as_boundary=False（Stop hook）: tool_result はスキップして実ユーザー位置を保持
        # tool_result_as_boundary=True（PreToolUse hook）: tool_result も境界として扱い古いテキストを除外
        if is_tool_result and not tool_result_as_boundary:
            continue
        last_user_pos = i

    messages: list[str] = []
    for entry in entries[last_user_pos + 1:]:
        if entry.get("type") != "assistant":
            continue
        content = entry.get("message", {}).get("content", "")
        if isinstance(content, list):
            text = "".join(
                c.get("text", "")
                for c in content
                if isinstance(c, dict) and c.get("type") == "text"
            )
        else:
            text = str(content)
        text = text.strip()
        if text:
            if len(text) > max_chars:
                text = text[:max_chars] + "…"
            messages.append(text)

    return messages
