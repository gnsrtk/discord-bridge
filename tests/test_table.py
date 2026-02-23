"""tests/test_table.py — Markdown テーブル変換のテスト"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "hooks"))

from lib.table import parse_markdown_table, convert_tables_in_text  # noqa: E402


class TestParseMarkdownTable:
    """parse_markdown_table のテスト"""

    def test_basic_ascii_table(self):
        block = (
            "| Name | Score | Rank |\n"
            "| --- | --- | --- |\n"
            "| Alice | 100 | S |\n"
            "| Bob | 85 | A |\n"
        )
        result = parse_markdown_table(block)
        assert result is not None
        headers, rows = result
        assert headers == ["Name", "Score", "Rank"]
        assert rows == [["Alice", "100", "S"], ["Bob", "85", "A"]]

    def test_japanese_table(self):
        block = (
            "| 名前 | スコア |\n"
            "| --- | --- |\n"
            "| 田中 | 100 |\n"
        )
        result = parse_markdown_table(block)
        assert result is not None
        headers, rows = result
        assert headers == ["名前", "スコア"]
        assert rows == [["田中", "100"]]

    def test_alignment_separators(self):
        """`:---:`, `---:`, `:---` を正しくパース"""
        block = (
            "| Left | Center | Right |\n"
            "| :--- | :---: | ---: |\n"
            "| a | b | c |\n"
        )
        result = parse_markdown_table(block)
        assert result is not None
        headers, rows = result
        assert headers == ["Left", "Center", "Right"]
        assert rows == [["a", "b", "c"]]

    def test_empty_cells(self):
        block = (
            "| A | B |\n"
            "| --- | --- |\n"
            "| x |  |\n"
            "|  | y |\n"
        )
        result = parse_markdown_table(block)
        assert result is not None
        _, rows = result
        assert rows == [["x", ""], ["", "y"]]

    def test_escaped_pipe(self):
        r"""セル内の `\|` を `|` として処理"""
        block = (
            "| Cmd | Desc |\n"
            "| --- | --- |\n"
            r"| a \| b | test |" + "\n"
        )
        result = parse_markdown_table(block)
        assert result is not None
        _, rows = result
        assert rows[0][0] == "a | b"

    def test_uneven_columns(self):
        """列数が不揃いな行は空セルで補完"""
        block = (
            "| A | B | C |\n"
            "| --- | --- | --- |\n"
            "| x | y |\n"
        )
        result = parse_markdown_table(block)
        assert result is not None
        _, rows = result
        assert rows == [["x", "y", ""]]

    def test_no_separator_returns_none(self):
        """セパレータ行がなければ None"""
        block = (
            "| A | B |\n"
            "| x | y |\n"
        )
        result = parse_markdown_table(block)
        assert result is None

    def test_short_separator_returns_none(self):
        """ダッシュが3未満のセパレータは拒否"""
        block = (
            "| A | B |\n"
            "| -- | -- |\n"
            "| x | y |\n"
        )
        result = parse_markdown_table(block)
        assert result is None


class TestConvertTablesInText:
    """convert_tables_in_text のテスト"""

    def test_basic_conversion(self):
        text = (
            "Here is a table:\n\n"
            "| Name | Score |\n"
            "| --- | --- |\n"
            "| Alice | 100 |\n"
            "\nEnd."
        )
        result = convert_tables_in_text(text)
        assert "```" in result
        assert "Alice" in result
        assert "Here is a table:" in result
        assert "End." in result
        # Markdown テーブル構文はなくなっている
        assert "| --- |" not in result

    def test_multiple_tables(self):
        text = (
            "| A | B |\n"
            "| --- | --- |\n"
            "| 1 | 2 |\n"
            "\nText between.\n\n"
            "| C | D |\n"
            "| --- | --- |\n"
            "| 3 | 4 |\n"
        )
        result = convert_tables_in_text(text)
        assert result.count("```") == 4  # 2 tables × 2 fences

    def test_non_table_text_preserved(self):
        text = "Just some text.\nNo tables here.\n"
        result = convert_tables_in_text(text)
        assert result == text

    def test_backtick_code_block_excluded(self):
        """バッククォートコードブロック内のテーブルは変換しない"""
        text = (
            "```\n"
            "| A | B |\n"
            "| --- | --- |\n"
            "| 1 | 2 |\n"
            "```\n"
        )
        result = convert_tables_in_text(text)
        assert result == text

    def test_language_tagged_code_block_excluded(self):
        """言語指定付きコードブロック内も変換しない"""
        text = (
            "```markdown\n"
            "| A | B |\n"
            "| --- | --- |\n"
            "| 1 | 2 |\n"
            "```\n"
        )
        result = convert_tables_in_text(text)
        assert result == text

    def test_tilde_code_block_excluded(self):
        """~~~ コードブロック内も変換しない"""
        text = (
            "~~~\n"
            "| A | B |\n"
            "| --- | --- |\n"
            "| 1 | 2 |\n"
            "~~~\n"
        )
        result = convert_tables_in_text(text)
        assert result == text

    def test_mixed_code_block_and_table(self):
        """コードブロック外のテーブルのみ変換"""
        text = (
            "```\n"
            "| Inside | Block |\n"
            "| --- | --- |\n"
            "| no | convert |\n"
            "```\n"
            "\n"
            "| Outside | Block |\n"
            "| --- | --- |\n"
            "| yes | convert |\n"
        )
        result = convert_tables_in_text(text)
        # コードブロック内は元のまま
        assert "| Inside | Block |" in result
        # コードブロック外は変換済み
        assert "| Outside | Block |" not in result
        assert "yes" in result
        assert "convert" in result

    def test_non_table_pipe_not_converted(self):
        """通常文の `a | b` はテーブルと判定しない"""
        text = "Choose a | b | c for the option.\n"
        result = convert_tables_in_text(text)
        assert result == text

    def test_discord_attach_marker_preserved(self):
        """[DISCORD_ATTACH: ...] マーカーがある場合に副作用なし"""
        text = (
            "| A | B |\n"
            "| --- | --- |\n"
            "| 1 | 2 |\n"
            "\n[DISCORD_ATTACH: /tmp/file.png]\n"
        )
        result = convert_tables_in_text(text)
        assert "[DISCORD_ATTACH: /tmp/file.png]" in result
        assert "```" in result

    def test_japanese_table_conversion(self):
        """日本語テーブルが変換されること（ズレは許容）"""
        text = (
            "| 名前 | 役職 |\n"
            "| --- | --- |\n"
            "| 田中 | Manager |\n"
        )
        result = convert_tables_in_text(text)
        assert "```" in result
        assert "田中" in result
        assert "| --- |" not in result
