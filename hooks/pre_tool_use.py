#!/usr/bin/env python3
"""PreToolUse hook: AskUserQuestion を Discord ボタンに変換する"""

import json
import sys
import urllib.request
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lib.config import load_config, resolve_channel
from lib.transcript import get_assistant_messages

DISCORD_MAX_CONTENT = 1900  # Discord の 2000 文字制限に余裕をもたせた上限


def post_buttons(bot_token: str, channel_id: str, content: str, components: list) -> None:
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
    try:
        urllib.request.urlopen(req, timeout=10).close()
    except urllib.error.HTTPError as e:
        print(f"[pre_tool_use.py] API error: {e.code} {e.reason}", file=sys.stderr)
        raise


def build_components(questions: list) -> list:
    """AskUserQuestion の questions 配列から Discord ActionRow 配列を構築する。
    先頭の質問のみ処理（1 質問 = 1 ActionRow、各選択肢をボタンに変換、最大5個）。
    """
    q = questions[0]
    options = q.get("options", [])[:5]  # Discord は1行に最大5ボタン
    buttons = []
    for i, opt in enumerate(options):
        label = opt.get("label", "")[:80]  # label は100文字以内
        buttons.append({
            "type": 2,   # Button
            "style": 1,  # Primary (青)
            "label": label,
            "custom_id": f"{i}:{label}",
        })
    if not buttons:
        return []
    return [{"type": 1, "components": buttons}]  # ActionRow


def build_content(preceding_text: str, question_text: str) -> str:
    """直前テキストと質問文を結合して Discord メッセージ本文を作る。"""
    question_part = f"**❓ {question_text}**"
    if not preceding_text:
        return question_part
    # 合計が上限を超える場合は直前テキストを切り詰める
    max_preceding = DISCORD_MAX_CONTENT - len(question_part) - 2  # "\n\n" 分
    if max_preceding <= 0:
        # question 自体が長すぎる場合は preceding_text を省略
        return question_part
    if len(preceding_text) > max_preceding:
        preceding_text = preceding_text[:max_preceding] + "…"
    return f"{preceding_text}\n\n{question_part}"


def main() -> None:
    try:
        hook_input = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(f"[pre_tool_use.py] Failed to parse stdin: {e}", file=sys.stderr)
        sys.exit(1)

    tool_name = hook_input.get("tool_name", "")
    if tool_name != "AskUserQuestion":
        sys.exit(0)  # 他のツールは素通り

    tool_input = hook_input.get("tool_input", {})
    questions = tool_input.get("questions", [])
    if not questions:
        sys.exit(0)

    cwd = hook_input.get("cwd", "")
    transcript_path = hook_input.get("transcript_path", "")

    try:
        config = load_config()
    except (OSError, KeyError, ValueError) as e:
        print(f"[pre_tool_use.py] Config error: {e}", file=sys.stderr)
        sys.exit(1)

    bot_token = config["discord"]["botToken"]

    try:
        channel_id, _ = resolve_channel(config, cwd)
    except ValueError as e:
        print(f"[pre_tool_use.py] Error: {e}", file=sys.stderr)
        sys.exit(1)

    if len(questions) > 1:
        print(f"[pre_tool_use.py] Warning: {len(questions) - 1} question(s) ignored (only first is supported)", file=sys.stderr)

    # transcript から直前のアシスタントテキストを取得（AskUserQuestion 呼び出し前の説明文など）
    preceding_text = ""
    if transcript_path:
        messages = get_assistant_messages(transcript_path, wait_for_content=True, tool_result_as_boundary=True)
        if messages:
            preceding_text = "\n\n".join(messages)

    question_text = questions[0].get("question", "(質問なし)")
    content = build_content(preceding_text, question_text)
    components = build_components(questions)

    if not components:
        sys.exit(0)

    try:
        post_buttons(bot_token, channel_id, content, components)
    except urllib.error.URLError as e:
        print(f"[pre_tool_use.py] API request failed: {e}", file=sys.stderr)
        sys.exit(1)

    # ツールをブロックして Claude に Discord 待機を伝える
    print(json.dumps({
        "decision": "block",
        "reason": "Question sent to Discord as buttons. Please wait for the user's selection via Discord.",
    }))


if __name__ == "__main__":
    main()
