"""tests/test_hooks.py — hooks のユニットテスト"""

import io
import json
import os
import sys
import tempfile
import unittest.mock as mock
import uuid
from pathlib import Path

import pytest

# hooks ディレクトリをパスに追加
sys.path.insert(0, str(Path(__file__).parent.parent / "hooks"))

import stop  # noqa: E402  (パス追加後のインポートのため)
from lib.config import resolve_channel  # noqa: E402
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

    def test_message_sent_with_title(self):
        """有効な last_assistant_message はタイトル付きで Discord に送信される。"""
        hook_input = {
            "session_id": str(uuid.uuid4()),
            "transcript_path": "",
            "cwd": "/tmp/test-project",
            "last_assistant_message": "実装完了しました。",
        }
        mock_config = {"schemaVersion": 2, "servers": []}
        with mock.patch("sys.stdin", io.StringIO(json.dumps(hook_input))), \
             mock.patch("stop.load_config", return_value=mock_config), \
             mock.patch("stop.resolve_channel", return_value=("chan-001", "token-xxx", "test-project")), \
             mock.patch("stop.post_message") as mock_post:
            stop.main()
        mock_post.assert_called_once()
        content = mock_post.call_args[0][2]
        assert "✅ Claude 完了" in content
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
                 mock.patch("stop.resolve_channel", return_value=("chan-001", "token-xxx", "test-project")), \
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
        channel_id, bot_token, project_name = resolve_channel(config, "/home/user/proj-b")
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
        channel_id, bot_token, _ = resolve_channel(config, "/home/user/proj-a/src/components")
        assert channel_id == "ch-a"
        assert bot_token == "token-personal"

    def test_fallback_returns_first_server_first_project(self):
        """不一致時は servers[0].projects[0] にフォールバック"""
        config = self._make_config([
            self._make_server("personal", "token-personal", "personal", [
                self._make_project("proj-a", "ch-a", "/home/user/proj-a"),
            ]),
        ])
        channel_id, bot_token, project_name = resolve_channel(config, "/home/user/unknown")
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
        channel_id, _, project_name = resolve_channel(config, "/home/user/nested/src")
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
        channel_id, bot_token, project_name = resolve_channel(config, "/home/user/nested/src")
        assert channel_id == "ch-nested"
        assert bot_token == "token-work"
        assert project_name == "nested"

    def test_empty_servers_raises(self):
        """servers が空の場合は ValueError"""
        with pytest.raises(ValueError):
            resolve_channel({"servers": []}, "/some/path")


# ---------------------------------------------------------------------------
# is_question
# ---------------------------------------------------------------------------

class TestIsQuestion:
    def test_shimasu_ka(self):
        """「しますか？」パターンを検出する。"""
        assert stop.is_question("実行しますか？") is True

    def test_deshou_ka(self):
        """「でしょうか？」パターンを検出する。"""
        assert stop.is_question("よろしいでしょうか？") is True

    def test_shou_ka(self):
        """「しょうか？」パターンを検出する。"""
        assert stop.is_question("確認しましょうか？") is True

    def test_desu_ka(self):
        """「ですか？」パターンを検出する。"""
        assert stop.is_question("よろしいですか？") is True

    def test_fullwidth_question_mark(self):
        """全角疑問符を検出する。"""
        assert stop.is_question("実行しますか？") is True

    def test_halfwidth_question_mark(self):
        """半角疑問符を検出する。"""
        assert stop.is_question("実行しますか?") is True

    def test_trailing_whitespace(self):
        """末尾空白があっても検出する。"""
        assert stop.is_question("実行しますか？  ") is True

    def test_period_ending_not_question(self):
        """句点終わりは質問ではない。"""
        assert stop.is_question("実行しました。") is False

    def test_no_question_mark(self):
        """疑問符なしは質問ではない。"""
        assert stop.is_question("実行します") is False

    def test_empty_string(self):
        """空文字列は質問ではない。"""
        assert stop.is_question("") is False

    def test_question_in_middle(self):
        """文中に質問パターンがあっても末尾でなければ False。"""
        assert stop.is_question("しますか？という話ですが、完了しました。") is False


# ---------------------------------------------------------------------------
# stop.main with buttons (質問パターン検出)
# ---------------------------------------------------------------------------

class TestStopMainWithButtons:
    def _make_hook_input(self, message: str) -> dict:
        return {
            "session_id": str(uuid.uuid4()),
            "transcript_path": "",
            "cwd": "/tmp/test-project",
            "last_assistant_message": message,
        }

    def _mock_config(self):
        return {"schemaVersion": 2, "servers": []}

    def test_question_uses_buttons(self):
        """質問パターンの場合、post_message_with_buttons が呼ばれる。"""
        hook_input = self._make_hook_input("この変更を適用しますか？")
        with mock.patch("sys.stdin", io.StringIO(json.dumps(hook_input))), \
             mock.patch("stop.load_config", return_value=self._mock_config()), \
             mock.patch("stop.resolve_channel", return_value=("chan-001", "token-xxx", "test-project")), \
             mock.patch("stop.post_message_with_buttons") as mock_buttons, \
             mock.patch("stop.post_message") as mock_plain:
            stop.main()
        mock_buttons.assert_called_once()
        mock_plain.assert_not_called()

    def test_non_question_uses_plain(self):
        """非質問パターンの場合、post_message が呼ばれる。"""
        hook_input = self._make_hook_input("実装完了しました。")
        with mock.patch("sys.stdin", io.StringIO(json.dumps(hook_input))), \
             mock.patch("stop.load_config", return_value=self._mock_config()), \
             mock.patch("stop.resolve_channel", return_value=("chan-001", "token-xxx", "test-project")), \
             mock.patch("stop.post_message_with_buttons") as mock_buttons, \
             mock.patch("stop.post_message") as mock_plain:
            stop.main()
        mock_plain.assert_called_once()
        mock_buttons.assert_not_called()

    def test_attachment_with_question_uses_files(self):
        """添付 + 質問パターンの場合、post_message_with_files が呼ばれボタン化しない。"""
        hook_input = self._make_hook_input(
            "確認しますか？ [DISCORD_ATTACH: /tmp/discord-bridge-outputs/out.png]"
        )
        with mock.patch("sys.stdin", io.StringIO(json.dumps(hook_input))), \
             mock.patch("stop.load_config", return_value=self._mock_config()), \
             mock.patch("stop.resolve_channel", return_value=("chan-001", "token-xxx", "test-project")), \
             mock.patch("stop.post_message_with_files") as mock_files, \
             mock.patch("stop.post_message_with_buttons") as mock_buttons, \
             mock.patch("stop.post_message") as mock_plain:
            stop.main()
        mock_files.assert_called_once()
        mock_buttons.assert_not_called()
        mock_plain.assert_not_called()
