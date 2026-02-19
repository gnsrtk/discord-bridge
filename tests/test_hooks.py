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
        mock_config = {"discord": {"botToken": "token-xxx"}}
        with mock.patch("sys.stdin", io.StringIO(json.dumps(hook_input))), \
             mock.patch("stop.load_config", return_value=mock_config), \
             mock.patch("stop.resolve_channel", return_value=("chan-001", "test-project")), \
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
        mock_config = {"discord": {"botToken": "token-xxx"}}
        sentinel = tmp_path / f"discord-bridge-last-sent-{session_id}.txt"
        mock_post = mock.MagicMock()

        def run_main():
            with mock.patch("sys.stdin", io.StringIO(json.dumps(hook_input))), \
                 mock.patch("stop.load_config", return_value=mock_config), \
                 mock.patch("stop.resolve_channel", return_value=("chan-001", "test-project")), \
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
