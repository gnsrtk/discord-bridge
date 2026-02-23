#!/usr/bin/env python3
"""PreToolUse hook: AskUserQuestion を Discord ボタンに変換する / permissionTools の許可確認"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lib.config import load_config, resolve_channel
from lib.thread import resolve_target_channel, clear_thread_tracking
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
    """Allow/Deny/Other の3ボタンメッセージを送信する。"""
    components = [{
        "type": 1,  # ActionRow
        "components": [
            {"type": 2, "style": 3, "label": "Allow", "custom_id": "perm:allow"},
            {"type": 2, "style": 4, "label": "Deny", "custom_id": "perm:deny"},
            {"type": 2, "style": 2, "label": "Other", "custom_id": "perm:other"},
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
    先頭の質問のみ処理（1行目: 選択肢ボタン最大5個、2行目: その他ボタン）。
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
    other_row = {
        "type": 1,
        "components": [{
            "type": 2,   # Button
            "style": 2,  # Secondary (灰)
            "label": "その他（テキスト入力）",
            "custom_id": "__other__",
        }],
    }
    return [{"type": 1, "components": buttons}, other_row]


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


def build_hook_output(
    decision: str,
    reason: str = "",
    additional_context: str = "",
) -> str:
    """hookSpecificOutput.permissionDecision 形式の JSON 文字列を構築する。"""
    output: dict = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
        }
    }
    if reason:
        output["hookSpecificOutput"]["permissionDecisionReason"] = reason
    if additional_context:
        output["hookSpecificOutput"]["additionalContext"] = additional_context
    return json.dumps(output)


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

    target_channel = resolve_target_channel(channel_id)

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

        question_text = questions[0].get("question", "(no question)")
        content = build_content(preceding_text, question_text)
        components = build_components(questions)

        if not components:
            sys.exit(0)

        try:
            post_buttons(bot_token, target_channel, content, components)
        except urllib.error.HTTPError as e:
            if e.code == 404 and target_channel != channel_id:
                clear_thread_tracking(channel_id)
                try:
                    post_buttons(bot_token, channel_id, content, components)
                except urllib.error.URLError as e2:
                    print(f"[pre_tool_use.py] Fallback API request failed: {e2}", file=sys.stderr)
                    sys.exit(1)
            else:
                print(f"[pre_tool_use.py] API request failed: {e}", file=sys.stderr)
                sys.exit(1)
        except urllib.error.URLError as e:
            print(f"[pre_tool_use.py] API request failed: {e}", file=sys.stderr)
            sys.exit(1)

        # ツールをブロックして Claude に Discord 待機を伝える
        print(build_hook_output(
            "deny",
            reason="Question sent to Discord as buttons.",
            additional_context="Please wait for the user's selection via Discord.",
        ))

    # permissionTools 処理
    elif tool_name in permission_tools:
        info = format_tool_info(tool_name, tool_input)
        content = f"\U0001f510 Tool permission\n{info}"

        try:
            post_permission_buttons(bot_token, target_channel, content)
        except urllib.error.HTTPError as e:
            if e.code == 404 and target_channel != channel_id:
                clear_thread_tracking(channel_id)
                try:
                    post_permission_buttons(bot_token, channel_id, content)
                except urllib.error.URLError:
                    sys.exit(0)
            else:
                print(f"[pre_tool_use.py] API request failed: {e}", file=sys.stderr)
                sys.exit(0)
        except urllib.error.URLError as e:
            print(f"[pre_tool_use.py] API request failed: {e}", file=sys.stderr)
            sys.exit(0)  # 送信失敗時は Claude Code デフォルトに委ねる

        # IPC ファイルは親チャンネルIDベース（bot.ts が threadParentMap で親IDに解決するため）
        result = wait_for_permission(channel_id)
        if result is None:
            sys.exit(0)  # タイムアウト → Claude Code デフォルト

        decision = result.get("decision", "allow")
        if decision == "allow":
            print(build_hook_output("allow"))
        elif decision == "deny":
            print(build_hook_output("deny", reason="User denied via Discord"))
        elif decision == "block":
            print(build_hook_output(
                "deny",
                reason="User chose 'Other' via Discord.",
                additional_context="Please wait for their input.",
            ))
        else:
            # 未知の decision は安全側に倒す（権限プロンプト表示）
            print(build_hook_output("ask", reason=f"Unknown decision: {decision}"))

    else:
        sys.exit(0)  # 他のツールは素通り


if __name__ == "__main__":
    main()
