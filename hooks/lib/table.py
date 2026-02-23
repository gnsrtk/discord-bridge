"""Markdown テーブル → ASCII テーブル変換（tabulate ベース）"""
from __future__ import annotations

import re

from tabulate import tabulate

# Markdown テーブル: ヘッダー行 + セパレータ行 + データ行（1行以上）
_TABLE_RE = re.compile(
    r"(?m)"
    r"^(\|.+\|)[ \t]*\n"                     # ヘッダー行
    r"^(\|[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|)[ \t]*\n"  # セパレータ行
    r"((?:^\|.+\|[ \t]*\n?)+)",              # データ行
)

# fenced code block: ``` or ~~~（言語指定付き含む）
_FENCE_RE = re.compile(r"(?m)^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$")


def _parse_row(line: str) -> list[str]:
    """パイプ区切りの1行をセルのリストに分割する。"""
    # エスケープパイプを一時置換
    line = line.replace(r"\|", "\x00")
    # 先頭・末尾の | を除去して分割
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|"):
        line = line[:-1]
    cells = [c.strip().replace("\x00", "|") for c in line.split("|")]
    return cells


def parse_markdown_table(block: str) -> tuple[list[str], list[list[str]]] | None:
    """Markdown テーブルブロックをパースして (headers, rows) を返す。"""
    lines = block.strip().splitlines()
    if len(lines) < 3:
        return None

    header_line = lines[0]
    sep_line = lines[1]
    data_lines = lines[2:]

    # セパレータ行の検証
    sep_stripped = sep_line.strip()
    if not sep_stripped.startswith("|") or not sep_stripped.endswith("|"):
        return None
    sep_inner = sep_stripped[1:-1]
    for part in sep_inner.split("|"):
        part = part.strip()
        if not re.match(r"^:?-{3,}:?$", part):
            return None

    headers = _parse_row(header_line)
    num_cols = len(headers)

    rows: list[list[str]] = []
    for line in data_lines:
        line = line.strip()
        if not line:
            continue
        cells = _parse_row(line)
        # 列数を揃える（不足は空セルで補完）
        if len(cells) < num_cols:
            cells.extend([""] * (num_cols - len(cells)))
        elif len(cells) > num_cols:
            cells = cells[:num_cols]
        rows.append(cells)

    if not rows:
        return None

    return headers, rows


def convert_tables_in_text(text: str) -> str:
    """テキスト中の Markdown テーブルを ASCII テーブル（コードブロック）に変換する。

    fenced code block（``` / ~~~）内のテーブルは変換しない。
    """
    # fenced code block の範囲を記録
    fenced_ranges: list[tuple[int, int]] = []
    for m in _FENCE_RE.finditer(text):
        fenced_ranges.append((m.start(), m.end()))

    def _in_fence(start: int, end: int) -> bool:
        return any(fs <= start and end <= fe for fs, fe in fenced_ranges)

    def _replace(m: re.Match) -> str:
        if _in_fence(m.start(), m.end()):
            return m.group(0)

        block = m.group(0)
        parsed = parse_markdown_table(block)
        if parsed is None:
            return block

        headers, rows = parsed
        ascii_table = tabulate(rows, headers=headers, tablefmt="simple")
        return f"```\n{ascii_table}\n```"

    return _TABLE_RE.sub(_replace, text)
