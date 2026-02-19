#!/usr/bin/env python3
"""PreToolUse hook: AskUserQuestion を Discord ボタンに変換する / permissionTools の許可確認"""

import json
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lib.config import load_config, resolve_channel
from lib.transcript import get_assistant_messages

DISCORD_MAX_CONTENT = 1900  # Discord の 2000 文字制限に余裕をもたせた上限

PERM_RESPONSE_DIR = "/tmp"
PERM_POLL_INTERVAL = 1.0  # 秒
PERM_TIMEOUT = 120  # 秒


def format_tool_info(tool_name: str, tool_input: dict) -> str:
    """ツール名と入力を人間が読めるサマリーにする。"""
    if tool_name == "Bash":
        return f"Bash: {tool_input.get('command', '(no command)')}"
    if tool_name == "Write":
        return f"Write: {tool_input.get('file_path', '(no path)')}"
    if tool_name == "Edit":
        return f"Edit: {tool_input.get('file_path', '(no path)')}"
    summary = json.dumps(tool_input, ensure_ascii=False)
    if len(summary) > 200:
        summary = summary[:200] + "…"
    return f"{tool_name}: {summary}"


def post_permission_buttons(bot_token: str, channel_id: str, content: str) -> None:
    """許可/拒否/それ以外の3ボタンメッセージを送信する。"""
    components = [{
        "type": 1,  # ActionRow
        "components": [
            {"type": 2, "style": 3, "label": "許可", "custom_id": "perm:allow"},
            {"type": 2, "style": 4, "label": "拒否", "custom_id": "perm:deny"},
            {"type": 2, "style": 2, "label": "それ以外", "custom_id": "perm:other"},
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
    try:
        urllib.request.urlopen(req, timeout=10).close()
    except urllib.error.HTTPError as e:
        print(f"[pre_tool_use.py] API error: {e.code} {e.reason}", file=sys.stderr)
        raise


def wait_for_permission(channel_id: str) -> dict | None:
    """応答ファイルをポーリングし、結果を返す。タイムアウトで None。"""
    resp_file = Path(f"{PERM_RESPONSE_DIR}/discord-bridge-perm-{channel_id}.json")
    resp_file.unlink(missing_ok=True)  # 古い応答をクリア
    for _ in range(int(PERM_TIMEOUT / PERM_POLL_INTERVAL)):
        time.sleep(PERM_POLL_INTERVAL)
        if resp_file.exists():
            try:
                data = json.loads(resp_file.read_text())
            except (json.JSONDecodeError, OSError):
                continue
            resp_file.unlink(missing_ok=True)
            return data
    return None


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
    tool_input = hook_input.get("tool_input", {})
    cwd = hook_input.get("cwd", "")
    transcript_path = hook_input.get("transcript_path", "")

    try:
        config = load_config()
    except (OSError, KeyError, ValueError) as e:
        print(f"[pre_tool_use.py] Config error: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        channel_id, bot_token, _, permission_tools = resolve_channel(config, cwd)
    except ValueError as e:
        print(f"[pre_tool_use.py] Error: {e}", file=sys.stderr)
        sys.exit(1)

    # AskUserQuestion 処理
    if tool_name == "AskUserQuestion":
        questions = tool_input.get("questions", [])
        if not questions:
            sys.exit(0)

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

    # permissionTools 処理
    elif tool_name in permission_tools:
        info = format_tool_info(tool_name, tool_input)
        content = f"\U0001f510 ツール許可確認\n{info}"

        try:
            post_permission_buttons(bot_token, channel_id, content)
        except urllib.error.URLError as e:
            print(f"[pre_tool_use.py] API request failed: {e}", file=sys.stderr)
            sys.exit(0)  # 送信失敗時は Claude Code デフォルトに委ねる

        result = wait_for_permission(channel_id)
        if result is None:
            sys.exit(0)  # タイムアウト → Claude Code デフォルト

        decision = result.get("decision", "allow")
        if decision == "deny":
            print(json.dumps({"decision": "deny", "reason": "User denied via Discord"}))
        elif decision == "block":
            print(json.dumps({
                "decision": "block",
                "reason": "User chose 'Other' via Discord. Please wait for their input.",
            }))
        else:
            print(json.dumps({"decision": decision}))

    else:
        sys.exit(0)  # 他のツールは素通り


if __name__ == "__main__":
    main()
