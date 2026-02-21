"""tests/test_context.py — context progress bar tests"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "hooks"))

from lib.context import format_progress_bar, read_context_cache


class TestFormatProgressBar:
    def test_zero_percent(self):
        result = format_progress_bar(0)
        assert result == "📊 ░░░░░░░░░░ 0%"

    def test_50_percent(self):
        result = format_progress_bar(50)
        assert result == "📊 █████░░░░░ 50%"

    def test_100_percent(self):
        result = format_progress_bar(100)
        assert result == "🚨 ██████████ 100%"

    def test_70_percent_warning(self):
        result = format_progress_bar(70)
        assert result.startswith("⚠️")
        assert "70%" in result

    def test_90_percent_critical(self):
        result = format_progress_bar(90)
        assert result.startswith("🚨")
        assert "90%" in result

    def test_rounds_to_nearest_block(self):
        # 25% → 2.5 blocks → 3 filled (round)
        result = format_progress_bar(25)
        filled = result.count("█")
        empty = result.count("░")
        assert filled + empty == 10

    def test_negative_clamped(self):
        result = format_progress_bar(-5)
        assert "0%" in result

    def test_over_100_clamped(self):
        result = format_progress_bar(150)
        assert "100%" in result


class TestReadContextCache:
    def test_valid_cache(self, tmp_path):
        cache = tmp_path / "context.json"
        cache.write_text(json.dumps({"used_percentage": 42}))
        result = read_context_cache(str(cache))
        assert result == 42

    def test_missing_file(self):
        result = read_context_cache("/nonexistent/path.json")
        assert result is None

    def test_invalid_json(self, tmp_path):
        cache = tmp_path / "context.json"
        cache.write_text("not json")
        result = read_context_cache(str(cache))
        assert result is None

    def test_missing_key(self, tmp_path):
        cache = tmp_path / "context.json"
        cache.write_text(json.dumps({"other": 1}))
        result = read_context_cache(str(cache))
        assert result is None

    def test_non_numeric_value_returns_none(self, tmp_path):
        """used_percentage が数値でない場合は None を返す。"""
        cache = tmp_path / "context.json"
        cache.write_text(json.dumps({"used_percentage": "not_a_number"}))
        result = read_context_cache(str(cache))
        assert result is None

    def test_null_value_returns_none(self, tmp_path):
        """used_percentage が null の場合は None を返す。"""
        cache = tmp_path / "context.json"
        cache.write_text(json.dumps({"used_percentage": None}))
        result = read_context_cache(str(cache))
        assert result is None

    def test_float_value_returns_int(self, tmp_path):
        """used_percentage が float の場合は int に変換して返す。"""
        cache = tmp_path / "context.json"
        cache.write_text(json.dumps({"used_percentage": 42.7}))
        result = read_context_cache(str(cache))
        assert result == 42
