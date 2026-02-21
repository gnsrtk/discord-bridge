"""tests/test_hooks.py — hooks のユニットテスト"""

import io
import json
import os
import sys
import tempfile
import time
import unittest.mock as mock
import urllib.error
import uuid
from pathlib import Path

import pytest

# hooks ディレクトリをパスに追加
sys.path.insert(0, str(Path(__file__).parent.parent / "hooks"))

import stop  # noqa: E402  (パス追加後のインポートのため)
import pre_tool_use  # noqa: E402
from lib.config import resolve_channel  # noqa: E402
from lib.thread import get_thread_id, resolve_target_channel, clear_thread_tracking  # noqa: E402
from lib.transcript import get_assistant_messages  # noqa: E402


# ---------------------------------------------------------------------------
# extract_attachments
# ---------------------------------------------------------------------------

class TestExtractAttachments:
    def test_single_marker_extracted(self):
        """単一マーカーを正しく抽出し、パスリストに格納する。"""
        text = "結果です [DISCORD_ATTACH: /tmp/result.png] ご確認ください"
        clean, paths = stop.extract_attachments(text)
        assert paths == ["/tmp/result.png"]
        assert "[DISCORD_ATTACH:" not in clean
        assert "結果です" in clean

    def test_no_marker_returns_original(self):
        """マーカーなしの場合、テキストはそのまま、パスリストは空。"""
        text = "添付ファイルなしのメッセージ"
        clean, paths = stop.extract_attachments(text)
        assert clean == text
        assert paths == []

    def test_multiple_markers_extracted(self):
        """複数マーカーをすべて抽出し順序を保つ。"""
        text = (
            "A [DISCORD_ATTACH: /tmp/a.png] B [DISCORD_ATTACH: /tmp/b.pdf] C"
        )
        clean, paths = stop.extract_attachments(text)
        assert paths == ["/tmp/a.png", "/tmp/b.pdf"]
        assert "[DISCORD_ATTACH:" not in clean
        assert "A" in clean
        assert "B" in clean

    def test_marker_with_extra_spaces(self):
        """マーカー内のスペースを strip して正しいパスを返す。"""
        text = "[DISCORD_ATTACH:   /tmp/spaced.txt   ]"
        clean, paths = stop.extract_attachments(text)
        assert paths == ["/tmp/spaced.txt"]
        assert clean == ""

    def test_empty_string(self):
        """空文字列でも例外が発生しない。"""
        clean, paths = stop.extract_attachments("")
        assert clean == ""
        assert paths == []


# ---------------------------------------------------------------------------
# get_assistant_messages (lib.transcript)
# ---------------------------------------------------------------------------

class TestGetAssistantMessages:
    def _write_jsonl(self, tmp_path: Path, entries: list[dict]) -> str:
        jsonl = tmp_path / "transcript.jsonl"
        jsonl.write_text("\n".join(json.dumps(e) for e in entries) + "\n")
        return str(jsonl)

    def test_normal_jsonl_returns_assistant_text(self, tmp_path):
        """正常な JSONL から最後のアシスタントメッセージを取得できる。"""
        entries = [
            {"type": "user", "message": {"content": "こんにちは"}},
            {"type": "assistant", "message": {"content": "お手伝いします"}},
        ]
        path = self._write_jsonl(tmp_path, entries)
        result = get_assistant_messages(path)
        assert result == ["お手伝いします"]

    def test_nonexistent_file_returns_empty(self):
        """存在しないファイルは空リストを返す（例外を出さない）。"""
        result = get_assistant_messages("/nonexistent/path/transcript.jsonl")
        assert result == []

    def test_assistant_before_user_returns_empty(self, tmp_path):
        """アシスタント応答がユーザーメッセージより前にある場合は空リストを返す。"""
        entries = [
            {"type": "assistant", "message": {"content": "古い応答"}},
            {"type": "user", "message": {"content": "新しい質問"}},
        ]
        path = self._write_jsonl(tmp_path, entries)
        result = get_assistant_messages(path)
        assert result == []

    def test_content_truncated_to_max_chars(self, tmp_path):
        """max_chars を超えるコンテンツは省略記号付きで切り詰められる。"""
        long_text = "あ" * 2000
        entries = [
            {"type": "user", "message": {"content": "質問"}},
            {"type": "assistant", "message": {"content": long_text}},
        ]
        path = self._write_jsonl(tmp_path, entries)
        result = get_assistant_messages(path, max_chars=100)
        assert len(result) == 1
        assert len(result[0]) == 101  # 100文字 + "…"
        assert result[0].endswith("…")

    def test_list_content_joined(self, tmp_path):
        """content がリスト形式（text ブロック）の場合にテキストを結合する。"""
        entries = [
            {"type": "user", "message": {"content": "質問"}},
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {"type": "text", "text": "Part1 "},
                        {"type": "text", "text": "Part2"},
                        {"type": "tool_use", "id": "xyz"},  # text 以外は無視
                    ]
                },
            },
        ]
        path = self._write_jsonl(tmp_path, entries)
        result = get_assistant_messages(path)
        assert result == ["Part1 Part2"]

    def test_empty_file_returns_empty(self, tmp_path):
        """空ファイルは空リストを返す。"""
        jsonl = tmp_path / "empty.jsonl"
        jsonl.write_text("")
        result = get_assistant_messages(str(jsonl))
        assert result == []

    def test_multiple_assistant_messages(self, tmp_path):
        """複数のアシスタントメッセージをすべて返す。"""
        entries = [
            {"type": "user", "message": {"content": "質問"}},
            {"type": "assistant", "message": {"content": "回答1"}},
            {"type": "assistant", "message": {"content": "回答2"}},
        ]
        path = self._write_jsonl(tmp_path, entries)
        result = get_assistant_messages(path)
        assert result == ["回答1", "回答2"]

    def test_tool_result_user_entry_skipped(self, tmp_path):
        """tool_result のみの user エントリは last_user_pos に含めない（Stop hook 動作）。"""
        entries = [
            {"type": "user", "message": {"content": "質問"}},
            {"type": "assistant", "message": {"content": "考え中"}},
            {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "x"}]}},
            {"type": "assistant", "message": {"content": "回答"}},
        ]
        path = self._write_jsonl(tmp_path, entries)
        result = get_assistant_messages(path)
        assert result == ["考え中", "回答"]

    def test_tool_result_as_boundary(self, tmp_path):
        """tool_result_as_boundary=True の場合、tool_result も境界として扱う（PreToolUse hook 動作）。"""
        entries = [
            {"type": "user", "message": {"content": "質問"}},
            {"type": "assistant", "message": {"content": "説明1"}},
            {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "aq1"}]}},
            {"type": "assistant", "message": {"content": "説明2"}},
        ]
        path = self._write_jsonl(tmp_path, entries)
        result = get_assistant_messages(path, tool_result_as_boundary=True)
        # 説明1 は前回の AQ より前なので除外され、説明2 のみ返る
        assert result == ["説明2"]

    def test_summary_entry_acts_as_boundary(self, tmp_path):
        """compact 後の summary エントリは境界として扱い、古いメッセージを除外する。"""
        entries = [
            {"type": "assistant", "message": {"content": "古い回答"}},
            {"type": "summary", "summary": "会話の要約..."},
            {"type": "assistant", "message": {"content": "新しい回答"}},
        ]
        path = self._write_jsonl(tmp_path, entries)
        result = get_assistant_messages(path)
        assert result == ["新しい回答"]


# ---------------------------------------------------------------------------
# _dbg
# ---------------------------------------------------------------------------

class TestDbg:
    def test_dbg_writes_when_debug_enabled(self, tmp_path):
        """DISCORD_BRIDGE_DEBUG=1 の場合、メッセージがファイルに書き込まれる。"""
        debug_file = str(tmp_path / "debug.txt")
        original_debug = stop.DEBUG
        original_file = stop._DEBUG_FILE
        original_initialized = stop._dbg_initialized
        try:
            stop.DEBUG = True
            stop._DEBUG_FILE = debug_file
            stop._dbg_initialized = False
            stop._dbg("hello debug")
        finally:
            stop.DEBUG = original_debug
            stop._DEBUG_FILE = original_file
            stop._dbg_initialized = original_initialized

        assert os.path.exists(debug_file)
        content = open(debug_file).read()
        assert "hello debug" in content

    def test_dbg_does_not_write_when_debug_disabled(self, tmp_path):
        """DISCORD_BRIDGE_DEBUG が未設定（False）の場合、ファイルが作成されない。"""
        debug_file = str(tmp_path / "debug.txt")
        original_debug = stop.DEBUG
        original_file = stop._DEBUG_FILE
        original_initialized = stop._dbg_initialized
        try:
            stop.DEBUG = False
            stop._DEBUG_FILE = debug_file
            stop._dbg_initialized = False
            stop._dbg("should not appear")
        finally:
            stop.DEBUG = original_debug
            stop._DEBUG_FILE = original_file
            stop._dbg_initialized = original_initialized

        assert not os.path.exists(debug_file)


# ---------------------------------------------------------------------------
# stop.main (last_assistant_message 方式)
# ---------------------------------------------------------------------------

class TestStopMain:
    def test_empty_message_exits_without_sending(self):
        """last_assistant_message が空の場合、送信せずに exit(0) する。"""
        hook_input = {
            "session_id": str(uuid.uuid4()),
            "transcript_path": "",
            "cwd": "/tmp/test",
            "last_assistant_message": "",
        }
        with mock.patch("sys.stdin", io.StringIO(json.dumps(hook_input))), \
             mock.patch("stop.post_message") as mock_post:
            with pytest.raises(SystemExit) as exc_info:
                stop.main()
        assert exc_info.value.code == 0
        mock_post.assert_not_called()

    def test_message_sent(self):
        """有効な last_assistant_message は Discord に送信される。"""
        hook_input = {
            "session_id": str(uuid.uuid4()),
            "transcript_path": "",
            "cwd": "/tmp/test-project",
            "last_assistant_message": "実装完了しました。",
        }
        mock_config = {"schemaVersion": 2, "servers": []}
        with mock.patch("sys.stdin", io.StringIO(json.dumps(hook_input))), \
             mock.patch("stop.load_config", return_value=mock_config), \
             mock.patch("stop.resolve_channel", return_value=("chan-001", "token-xxx", "test-project", [])), \
             mock.patch("stop.post_message") as mock_post:
            stop.main()
        mock_post.assert_called_once()
        content = mock_post.call_args[0][2]
        assert "実装完了しました。" in content

    def test_dedup_prevents_second_send(self, tmp_path):
        """同一 session_id + transcript_mtime での2回目呼び出しは送信しない（Stop 2重発火対策）。"""
        session_id = str(uuid.uuid4())
        # transcript_path なし → mtime = "0"、sentinel key = "{session_id}:0"
        hook_input = {
            "session_id": session_id,
            "transcript_path": "",
            "cwd": "/tmp/test-project",
            "last_assistant_message": "完了しました。",
        }
        mock_config = {"schemaVersion": 2, "servers": []}
        sentinel = tmp_path / f"discord-bridge-last-sent-{session_id}.txt"
        mock_post = mock.MagicMock()

        def run_main():
            with mock.patch("sys.stdin", io.StringIO(json.dumps(hook_input))), \
                 mock.patch("stop.load_config", return_value=mock_config), \
                 mock.patch("stop.resolve_channel", return_value=("chan-001", "token-xxx", "test-project", [])), \
                 mock.patch("stop.Path", side_effect=lambda p: sentinel if "last-sent" in str(p) else Path(p)), \
                 mock.patch("stop.post_message", mock_post):
                stop.main()

        # 1回目: 送信される
        run_main()
        assert mock_post.call_count == 1

        # 2回目: mtime 同一のためスキップ
        with pytest.raises(SystemExit) as exc_info:
            run_main()
        assert exc_info.value.code == 0
        assert mock_post.call_count == 1  # 追加呼び出しなし


# ---------------------------------------------------------------------------
# resolve_channel (v2)
# ---------------------------------------------------------------------------

class TestResolveChannel:
    """hooks/lib/config.py の resolve_channel (v2) のテスト"""

    def _make_config(self, servers: list) -> dict:
        return {"schemaVersion": 2, "servers": servers}

    def _make_server(self, name: str, token: str, session: str, projects: list) -> dict:
        return {
            "name": name,
            "discord": {"botToken": token, "ownerUserId": "owner"},
            "tmux": {"session": session},
            "projects": projects,
        }

    def _make_project(self, name: str, channel: str, path: str) -> dict:
        return {"name": name, "channelId": channel, "projectPath": path, "model": "m"}

    def test_exact_match_returns_correct_server(self):
        """cwd が projectPath と完全一致する場合、正しいサーバーの情報を返す"""
        config = self._make_config([
            self._make_server("personal", "token-personal", "personal", [
                self._make_project("proj-a", "ch-a", "/home/user/proj-a"),
            ]),
            self._make_server("work", "token-work", "work", [
                self._make_project("proj-b", "ch-b", "/home/user/proj-b"),
            ]),
        ])
        channel_id, bot_token, project_name, _ = resolve_channel(config, "/home/user/proj-b")
        assert channel_id == "ch-b"
        assert bot_token == "token-work"
        assert project_name == "proj-b"

    def test_prefix_match(self):
        """cwd がサブディレクトリの場合も一致する"""
        config = self._make_config([
            self._make_server("personal", "token-personal", "personal", [
                self._make_project("proj-a", "ch-a", "/home/user/proj-a"),
            ]),
        ])
        channel_id, bot_token, _, _ = resolve_channel(config, "/home/user/proj-a/src/components")
        assert channel_id == "ch-a"
        assert bot_token == "token-personal"

    def test_fallback_returns_first_server_first_project(self):
        """不一致時は servers[0].projects[0] にフォールバック"""
        config = self._make_config([
            self._make_server("personal", "token-personal", "personal", [
                self._make_project("proj-a", "ch-a", "/home/user/proj-a"),
            ]),
        ])
        channel_id, bot_token, project_name, _ = resolve_channel(config, "/home/user/unknown")
        assert channel_id == "ch-a"
        assert bot_token == "token-personal"
        assert project_name is None

    def test_longest_prefix_wins(self):
        """より長いプレフィックスにマッチした project が優先される"""
        config = self._make_config([
            self._make_server("personal", "token-personal", "personal", [
                self._make_project("root", "ch-root", "/home/user"),
                self._make_project("nested", "ch-nested", "/home/user/nested"),
            ]),
        ])
        channel_id, _, project_name, _ = resolve_channel(config, "/home/user/nested/src")
        assert channel_id == "ch-nested"
        assert project_name == "nested"

    def test_longest_prefix_wins_cross_server(self):
        """異なる server 間でも最長プレフィックスが優先される"""
        config = self._make_config([
            self._make_server("personal", "token-personal", "personal", [
                self._make_project("root", "ch-root", "/home/user"),
            ]),
            self._make_server("work", "token-work", "work", [
                self._make_project("nested", "ch-nested", "/home/user/nested"),
            ]),
        ])
        channel_id, bot_token, project_name, _ = resolve_channel(config, "/home/user/nested/src")
        assert channel_id == "ch-nested"
        assert bot_token == "token-work"
        assert project_name == "nested"

    def test_empty_servers_raises(self):
        """servers が空の場合は ValueError"""
        with pytest.raises(ValueError):
            resolve_channel({"servers": []}, "/some/path")

    def test_permission_tools_returned(self):
        """permissionTools がサーバーに設定されている場合、4番目の要素として返される"""
        config = self._make_config([{
            **self._make_server("personal", "token-personal", "personal", [
                self._make_project("proj-a", "ch-a", "/home/user/proj-a"),
            ]),
            "permissionTools": ["Bash", "Write"],
        }])
        _, _, _, permission_tools = resolve_channel(config, "/home/user/proj-a")
        assert permission_tools == ["Bash", "Write"]

    def test_permission_tools_default_empty(self):
        """permissionTools 未設定の場合は空リストが返される"""
        config = self._make_config([
            self._make_server("personal", "token-personal", "personal", [
                self._make_project("proj-a", "ch-a", "/home/user/proj-a"),
            ]),
        ])
        _, _, _, permission_tools = resolve_channel(config, "/home/user/proj-a")
        assert permission_tools == []




# ---------------------------------------------------------------------------
# format_tool_info
# ---------------------------------------------------------------------------

class TestFormatToolInfo:
    def test_bash_command(self):
        """Bash ツールはコマンドを表示する。"""
        result = pre_tool_use.format_tool_info("Bash", {"command": "ls -la"})
        assert result == "Bash: ls -la"

    def test_write_file_path(self):
        """Write ツールはファイルパスを表示する。"""
        result = pre_tool_use.format_tool_info("Write", {"file_path": "/tmp/test.txt"})
        assert result == "Write: /tmp/test.txt"

    def test_edit_file_path(self):
        """Edit ツールはファイルパスを表示する。"""
        result = pre_tool_use.format_tool_info("Edit", {"file_path": "/src/app.ts"})
        assert result == "Edit: /src/app.ts"

    def test_unknown_tool_json(self):
        """不明なツールは JSON 表示する。"""
        result = pre_tool_use.format_tool_info("CustomTool", {"key": "value"})
        assert result.startswith("CustomTool: ")
        assert '"key"' in result

    def test_long_input_truncated(self):
        """長い入力は 200 文字 + 省略記号で切り詰められる。"""
        long_value = "x" * 500
        result = pre_tool_use.format_tool_info("SomeTool", {"data": long_value})
        # "SomeTool: " + 200 chars + "…"
        json_part = result[len("SomeTool: "):]
        assert json_part.endswith("…")
        assert len(json_part) == 201  # 200 + "…"

    def test_bash_no_command(self):
        """Bash で command がない場合のフォールバック。"""
        result = pre_tool_use.format_tool_info("Bash", {})
        assert result == "Bash: (no command)"


# ---------------------------------------------------------------------------
# wait_for_permission
# ---------------------------------------------------------------------------

class TestWaitForPermission:
    def test_response_file_found(self, tmp_path):
        """応答ファイルがある場合、結果を返す。"""
        import threading

        channel_id = "test-channel-123"
        resp_file = Path(f"/tmp/discord-bridge-perm-{channel_id}.json")
        resp_file.unlink(missing_ok=True)

        def write_response():
            time.sleep(0.3)
            resp_file.write_text(json.dumps({"decision": "allow"}))

        with mock.patch.object(pre_tool_use, "PERM_POLL_INTERVAL", 0.1), \
             mock.patch.object(pre_tool_use, "PERM_TIMEOUT", 3):
            t = threading.Thread(target=write_response)
            t.start()
            result = pre_tool_use.wait_for_permission(channel_id)
            t.join()

        assert result == {"decision": "allow"}

    def test_timeout_returns_none(self):
        """タイムアウトの場合、None を返す。"""
        channel_id = "test-timeout-456"
        resp_file = Path(f"/tmp/discord-bridge-perm-{channel_id}.json")
        resp_file.unlink(missing_ok=True)

        with mock.patch.object(pre_tool_use, "PERM_POLL_INTERVAL", 0.05), \
             mock.patch.object(pre_tool_use, "PERM_TIMEOUT", 0.1):
            result = pre_tool_use.wait_for_permission(channel_id)

        assert result is None

    def test_old_response_cleared(self, tmp_path):
        """古い応答ファイルがクリアされる。"""
        channel_id = "test-clear-789"
        resp_file = Path(f"/tmp/discord-bridge-perm-{channel_id}.json")
        resp_file.write_text(json.dumps({"decision": "old"}))

        import threading

        def write_new_response():
            time.sleep(0.3)
            resp_file.write_text(json.dumps({"decision": "deny"}))

        with mock.patch.object(pre_tool_use, "PERM_POLL_INTERVAL", 0.1), \
             mock.patch.object(pre_tool_use, "PERM_TIMEOUT", 3):
            t = threading.Thread(target=write_new_response)
            t.start()
            result = pre_tool_use.wait_for_permission(channel_id)
            t.join()

        assert result == {"decision": "deny"}


# ---------------------------------------------------------------------------
# pre_tool_use.main (permission tools)
# ---------------------------------------------------------------------------

class TestPreToolUsePermission:
    def _mock_config(self):
        return {"schemaVersion": 2, "servers": []}

    def test_permission_tool_sends_buttons_and_allows(self):
        """permissionTools に含まれるツールはボタン送信 + IPC で許可を返す。"""
        hook_input = {
            "tool_name": "Bash",
            "tool_input": {"command": "rm -rf /tmp/test"},
            "cwd": "/tmp/test-project",
            "transcript_path": "",
        }
        with mock.patch("sys.stdin", io.StringIO(json.dumps(hook_input))), \
             mock.patch("pre_tool_use.load_config", return_value=self._mock_config()), \
             mock.patch("pre_tool_use.resolve_channel", return_value=("chan-001", "token-xxx", None, ["Bash"])), \
             mock.patch("pre_tool_use.post_permission_buttons") as mock_perm_buttons, \
             mock.patch("pre_tool_use.wait_for_permission", return_value={"decision": "allow"}), \
             mock.patch("sys.stdout", new_callable=io.StringIO) as mock_stdout:
            pre_tool_use.main()

        mock_perm_buttons.assert_called_once()
        output = json.loads(mock_stdout.getvalue())
        assert output["hookSpecificOutput"]["permissionDecision"] == "allow"

    def test_permission_tool_deny(self):
        """permissionTools で拒否が返された場合、deny を出力する。"""
        hook_input = {
            "tool_name": "Bash",
            "tool_input": {"command": "dangerous-command"},
            "cwd": "/tmp/test-project",
            "transcript_path": "",
        }
        with mock.patch("sys.stdin", io.StringIO(json.dumps(hook_input))), \
             mock.patch("pre_tool_use.load_config", return_value=self._mock_config()), \
             mock.patch("pre_tool_use.resolve_channel", return_value=("chan-001", "token-xxx", None, ["Bash"])), \
             mock.patch("pre_tool_use.post_permission_buttons"), \
             mock.patch("pre_tool_use.wait_for_permission", return_value={"decision": "deny"}), \
             mock.patch("sys.stdout", new_callable=io.StringIO) as mock_stdout:
            pre_tool_use.main()

        output = json.loads(mock_stdout.getvalue())
        assert output["hookSpecificOutput"]["permissionDecision"] == "deny"

    def test_non_permission_tool_exits(self):
        """permissionTools に含まれないツールは exit(0) する。"""
        hook_input = {
            "tool_name": "Read",
            "tool_input": {"file_path": "/tmp/test.txt"},
            "cwd": "/tmp/test-project",
            "transcript_path": "",
        }
        with mock.patch("sys.stdin", io.StringIO(json.dumps(hook_input))), \
             mock.patch("pre_tool_use.load_config", return_value=self._mock_config()), \
             mock.patch("pre_tool_use.resolve_channel", return_value=("chan-001", "token-xxx", None, ["Bash"])):
            with pytest.raises(SystemExit) as exc_info:
                pre_tool_use.main()
        assert exc_info.value.code == 0

    def test_permission_tool_block(self):
        """permissionTools で block（それ以外）が返された場合、block を出力する。"""
        hook_input = {
            "tool_name": "Bash",
            "tool_input": {"command": "some-command"},
            "cwd": "/tmp/test-project",
            "transcript_path": "",
        }
        with mock.patch("sys.stdin", io.StringIO(json.dumps(hook_input))), \
             mock.patch("pre_tool_use.load_config", return_value=self._mock_config()), \
             mock.patch("pre_tool_use.resolve_channel", return_value=("chan-001", "token-xxx", None, ["Bash"])), \
             mock.patch("pre_tool_use.post_permission_buttons"), \
             mock.patch("pre_tool_use.wait_for_permission", return_value={"decision": "block"}), \
             mock.patch("sys.stdout", new_callable=io.StringIO) as mock_stdout:
            pre_tool_use.main()

        output = json.loads(mock_stdout.getvalue())
        hook_out = output["hookSpecificOutput"]
        assert hook_out["permissionDecision"] == "deny"
        assert "Other" in hook_out.get("permissionDecisionReason", "")

    def test_permission_timeout_exits(self):
        """タイムアウト時は exit(0) する。"""
        hook_input = {
            "tool_name": "Bash",
            "tool_input": {"command": "echo hello"},
            "cwd": "/tmp/test-project",
            "transcript_path": "",
        }
        with mock.patch("sys.stdin", io.StringIO(json.dumps(hook_input))), \
             mock.patch("pre_tool_use.load_config", return_value=self._mock_config()), \
             mock.patch("pre_tool_use.resolve_channel", return_value=("chan-001", "token-xxx", None, ["Bash"])), \
             mock.patch("pre_tool_use.post_permission_buttons"), \
             mock.patch("pre_tool_use.wait_for_permission", return_value=None):
            with pytest.raises(SystemExit) as exc_info:
                pre_tool_use.main()
        assert exc_info.value.code == 0


# ---------------------------------------------------------------------------
# lib/thread.py — スレッドトラッキング
# ---------------------------------------------------------------------------

class TestThreadTracking:
    def test_file_present_returns_thread_id(self, tmp_path):
        """トラッキングファイルがあれば threadId を返す。"""
        channel_id = "test-thread-001"
        tracking_file = Path(f"/tmp/discord-bridge-thread-{channel_id}.json")
        tracking_file.write_text(json.dumps({"threadId": "thread-999"}))
        try:
            result = get_thread_id(channel_id)
            assert result == "thread-999"
        finally:
            tracking_file.unlink(missing_ok=True)

    def test_file_absent_returns_none(self):
        """トラッキングファイルがなければ None を返す。"""
        result = get_thread_id("nonexistent-channel-xyz")
        assert result is None

    def test_invalid_json_returns_none(self, tmp_path):
        """不正 JSON の場合は None を返す。"""
        channel_id = "test-thread-bad-json"
        tracking_file = Path(f"/tmp/discord-bridge-thread-{channel_id}.json")
        tracking_file.write_text("not valid json{{{")
        try:
            result = get_thread_id(channel_id)
            assert result is None
        finally:
            tracking_file.unlink(missing_ok=True)

    def test_resolve_target_channel_with_thread(self):
        """スレッドトラッキングあり → スレッドID を返す。"""
        channel_id = "test-resolve-001"
        tracking_file = Path(f"/tmp/discord-bridge-thread-{channel_id}.json")
        tracking_file.write_text(json.dumps({"threadId": "thread-123"}))
        try:
            result = resolve_target_channel(channel_id)
            assert result == "thread-123"
        finally:
            tracking_file.unlink(missing_ok=True)

    def test_resolve_target_channel_without_thread(self):
        """スレッドトラッキングなし → channel_id をそのまま返す。"""
        result = resolve_target_channel("no-thread-channel-xyz")
        assert result == "no-thread-channel-xyz"

    def test_env_var_takes_priority(self):
        """DISCORD_BRIDGE_THREAD_ID 環境変数がファイルより優先される。"""
        channel_id = "test-env-priority"
        tracking_file = Path(f"/tmp/discord-bridge-thread-{channel_id}.json")
        tracking_file.write_text(json.dumps({"threadId": "file-thread-id"}))
        try:
            with mock.patch.dict(os.environ, {"DISCORD_BRIDGE_THREAD_ID": "env-thread-id"}):
                result = resolve_target_channel(channel_id)
            assert result == "env-thread-id"
        finally:
            tracking_file.unlink(missing_ok=True)

    def test_env_var_without_file(self):
        """DISCORD_BRIDGE_THREAD_ID 設定時、ファイルなしでもその値を返す。"""
        with mock.patch.dict(os.environ, {"DISCORD_BRIDGE_THREAD_ID": "env-only-thread"}):
            result = resolve_target_channel("no-file-channel-xyz")
        assert result == "env-only-thread"

    def test_no_env_var_falls_back_to_file(self):
        """DISCORD_BRIDGE_THREAD_ID 未設定 → ファイルベース IPC に従う。"""
        channel_id = "test-no-env-fallback"
        tracking_file = Path(f"/tmp/discord-bridge-thread-{channel_id}.json")
        tracking_file.write_text(json.dumps({"threadId": "file-thread-only"}))
        try:
            with mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop("DISCORD_BRIDGE_THREAD_ID", None)
                result = resolve_target_channel(channel_id)
            assert result == "file-thread-only"
        finally:
            tracking_file.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# stop.main with thread (スレッド対応)
# ---------------------------------------------------------------------------

class TestStopMainWithThread:
    def _make_hook_input(self, message: str) -> dict:
        return {
            "session_id": str(uuid.uuid4()),
            "transcript_path": "",
            "cwd": "/tmp/test-project",
            "last_assistant_message": message,
        }

    def _mock_config(self):
        return {"schemaVersion": 2, "servers": []}

    def test_thread_active_sends_to_thread(self):
        """スレッドアクティブ時 → スレッドに送信する。"""
        channel_id = "test-stop-thread-ch"
        thread_id = "test-stop-thread-999"
        tracking_file = Path(f"/tmp/discord-bridge-thread-{channel_id}.json")
        tracking_file.write_text(json.dumps({"threadId": thread_id}))

        hook_input = self._make_hook_input("完了しました。")
        try:
            with mock.patch("sys.stdin", io.StringIO(json.dumps(hook_input))), \
                 mock.patch("stop.load_config", return_value=self._mock_config()), \
                 mock.patch("stop.resolve_channel", return_value=(channel_id, "token-xxx", "test-project", [])), \
                 mock.patch("stop.post_message") as mock_post:
                stop.main()
            mock_post.assert_called_once()
            # 送信先がスレッドIDであることを確認
            assert mock_post.call_args[0][1] == thread_id
        finally:
            tracking_file.unlink(missing_ok=True)

    def test_thread_404_falls_back_to_parent(self):
        """スレッドが 404 → 親チャンネルにフォールバックする。"""
        channel_id = "test-fallback-ch"
        thread_id = "test-fallback-thread-404"
        tracking_file = Path(f"/tmp/discord-bridge-thread-{channel_id}.json")
        tracking_file.write_text(json.dumps({"threadId": thread_id}))

        hook_input = self._make_hook_input("完了しました。")

        http_404 = urllib.error.HTTPError(
            url="https://discord.com/api/...",
            code=404,
            msg="Not Found",
            hdrs=None,  # type: ignore[arg-type]
            fp=None,
        )

        call_count = 0

        def side_effect(token, ch, text):
            nonlocal call_count
            call_count += 1
            if ch == thread_id:
                raise http_404

        try:
            with mock.patch("sys.stdin", io.StringIO(json.dumps(hook_input))), \
                 mock.patch("stop.load_config", return_value=self._mock_config()), \
                 mock.patch("stop.resolve_channel", return_value=(channel_id, "token-xxx", "test-project", [])), \
                 mock.patch("stop.post_message", side_effect=side_effect) as mock_post:
                stop.main()
            # 2回呼ばれる: 1回目スレッド(404) → 2回目親チャンネル
            assert call_count == 2
            assert mock_post.call_args_list[1][0][1] == channel_id
            # トラッキングファイルが削除されている
            assert not tracking_file.exists()
        finally:
            tracking_file.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# stop.main with context progress bar
# ---------------------------------------------------------------------------

class TestStopContextProgressBar:
    def test_progress_bar_appended(self):
        """コンテキストキャッシュがある場合、プログレスバーがメッセージ末尾に付く。"""
        session_id = str(uuid.uuid4())
        cache_path = f"/tmp/discord-bridge-context-{session_id}.json"
        Path(cache_path).write_text(json.dumps({"used_percentage": 42}))

        hook_input = {
            "session_id": session_id,
            "transcript_path": "",
            "cwd": "/tmp/test-project",
            "last_assistant_message": "Done.",
        }
        mock_config = {"schemaVersion": 2, "servers": []}
        try:
            with mock.patch("sys.stdin", io.StringIO(json.dumps(hook_input))), \
                 mock.patch("stop.load_config", return_value=mock_config), \
                 mock.patch("stop.resolve_channel", return_value=("chan-001", "token-xxx", "test", [])), \
                 mock.patch("stop.post_message") as mock_post:
                stop.main()
            content = mock_post.call_args[0][2]
            assert "📊 ctx 42%" in content
        finally:
            Path(cache_path).unlink(missing_ok=True)

    def test_progress_bar_with_rate_limits(self):
        """rate_limits がキャッシュにある場合、session/weekly 情報も表示される。"""
        session_id = str(uuid.uuid4())
        cache_path = f"/tmp/discord-bridge-context-{session_id}.json"
        from datetime import datetime, timezone, timedelta
        future = (datetime.now(timezone.utc) + timedelta(hours=2, minutes=30)).isoformat()
        cache_data = {
            "used_percentage": 50,
            "rate_limits": {
                "five_hour": {"utilization": 45, "resets_at": future},
                "seven_day": {"utilization": 12, "resets_at": future},
            },
        }
        Path(cache_path).write_text(json.dumps(cache_data))

        hook_input = {
            "session_id": session_id,
            "transcript_path": "",
            "cwd": "/tmp/test-project",
            "last_assistant_message": "Done.",
        }
        mock_config = {"schemaVersion": 2, "servers": []}
        try:
            with mock.patch("sys.stdin", io.StringIO(json.dumps(hook_input))), \
                 mock.patch("stop.load_config", return_value=mock_config), \
                 mock.patch("stop.resolve_channel", return_value=("chan-001", "token-xxx", "test", [])), \
                 mock.patch("stop.post_message") as mock_post:
                stop.main()
            content = mock_post.call_args[0][2]
            assert "50%" in content
            assert "session:45%" in content
            assert "weekly:12%" in content
            assert "│" in content
        finally:
            Path(cache_path).unlink(missing_ok=True)

    def test_no_cache_no_bar(self):
        """コンテキストキャッシュがない場合、プログレスバーは付かない。"""
        session_id = str(uuid.uuid4())
        hook_input = {
            "session_id": session_id,
            "transcript_path": "",
            "cwd": "/tmp/test-project",
            "last_assistant_message": "Done.",
        }
        mock_config = {"schemaVersion": 2, "servers": []}
        with mock.patch("sys.stdin", io.StringIO(json.dumps(hook_input))), \
             mock.patch("stop.load_config", return_value=mock_config), \
             mock.patch("stop.resolve_channel", return_value=("chan-001", "token-xxx", "test", [])), \
             mock.patch("stop.post_message") as mock_post:
            stop.main()
        content = mock_post.call_args[0][2]
        assert "█" not in content
        assert "░" not in content
