"""tests/test_context.py — context progress bar + rate limit tests"""

import json
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "hooks"))

from lib.context import (
    format_context_status,
    format_reset_time,
    format_rate_limit_entry,
    format_footer,
    read_context_cache,
    read_full_cache,
)


class TestFormatResetTime:
    """format_reset_time のテスト。+30s のバッファで丸め誤差を防ぐ。"""

    def test_minutes_only(self):
        future = datetime.now(timezone.utc) + timedelta(minutes=30, seconds=30)
        result = format_reset_time(future.isoformat())
        assert result == "30m"

    def test_hours_and_minutes(self):
        future = datetime.now(timezone.utc) + timedelta(hours=2, minutes=30, seconds=30)
        result = format_reset_time(future.isoformat())
        assert result == "2h30m"

    def test_days_and_hours(self):
        future = datetime.now(timezone.utc) + timedelta(days=5, hours=3, seconds=30)
        result = format_reset_time(future.isoformat())
        assert result == "5d03h"

    def test_zero_minutes(self):
        future = datetime.now(timezone.utc) + timedelta(seconds=10)
        result = format_reset_time(future.isoformat())
        assert result == "0m"

    def test_past_time_clamps_to_zero(self):
        past = datetime.now(timezone.utc) - timedelta(hours=1)
        result = format_reset_time(past.isoformat())
        assert result == "0m"

    def test_z_suffix(self):
        future = datetime.now(timezone.utc) + timedelta(hours=1)
        iso = future.strftime("%Y-%m-%dT%H:%M:%SZ")
        result = format_reset_time(iso)
        assert "h" in result or "m" in result

    def test_invalid_string(self):
        assert format_reset_time("not-a-date") == "?"

    def test_empty_string(self):
        assert format_reset_time("") == "?"

    def test_exactly_one_day(self):
        future = datetime.now(timezone.utc) + timedelta(days=1, seconds=30)
        result = format_reset_time(future.isoformat())
        assert result == "1d00h"


class TestFormatRateLimitEntry:
    def test_basic_format(self):
        future = datetime.now(timezone.utc) + timedelta(hours=2, minutes=30, seconds=30)
        result = format_rate_limit_entry("session", 45, future.isoformat())
        assert result == "session:45%(2h30m)"

    def test_weekly_label(self):
        future = datetime.now(timezone.utc) + timedelta(days=5, hours=3, seconds=30)
        result = format_rate_limit_entry("weekly", 12, future.isoformat())
        assert result == "weekly:12%(5d03h)"

    def test_zero_utilization(self):
        future = datetime.now(timezone.utc) + timedelta(hours=4)
        result = format_rate_limit_entry("session", 0, future.isoformat())
        assert result.startswith("session:0%")


class TestFormatContextStatus:
    def test_with_model(self):
        result = format_context_status(50, "Opus 4.6")
        assert result == "📊 Opus 4.6 50%"

    def test_without_model(self):
        result = format_context_status(50)
        assert result == "📊 ctx 50%"

    def test_none_model(self):
        result = format_context_status(50, None)
        assert result == "📊 ctx 50%"

    def test_always_has_icon(self):
        assert format_context_status(0, "Opus 4.6").startswith("📊")
        assert format_context_status(70, "Opus 4.6").startswith("📊")
        assert format_context_status(90, "Opus 4.6").startswith("📊")
        assert format_context_status(100, "Opus 4.6").startswith("📊")

    def test_clamped_to_0(self):
        result = format_context_status(-5, "Opus 4.6")
        assert result == "📊 Opus 4.6 0%"

    def test_clamped_to_100(self):
        result = format_context_status(150, "Opus 4.6")
        assert result == "📊 Opus 4.6 100%"


class TestFormatFooter:
    def test_context_only_no_model(self):
        result = format_footer(50)
        assert result == "📊 ctx 50%"

    def test_context_with_model(self):
        result = format_footer(50, model="Opus 4.6")
        assert result == "📊 Opus 4.6 50%"

    def test_context_with_rate_limits(self):
        future_session = datetime.now(timezone.utc) + timedelta(hours=2, minutes=30, seconds=30)
        future_weekly = datetime.now(timezone.utc) + timedelta(days=5, hours=3, seconds=30)
        rate_limits = {
            "five_hour": {"utilization": 45, "resets_at": future_session.isoformat()},
            "seven_day": {"utilization": 12, "resets_at": future_weekly.isoformat()},
        }
        result = format_footer(50, rate_limits, model="Opus 4.6")
        assert "📊 Opus 4.6 50%" in result
        assert "session:45%(2h30m)" in result
        assert "weekly:12%(5d03h)" in result
        assert " │ " in result

    def test_session_only(self):
        future = datetime.now(timezone.utc) + timedelta(hours=1)
        rate_limits = {
            "five_hour": {"utilization": 80, "resets_at": future.isoformat()},
        }
        result = format_footer(60, rate_limits)
        assert "session:80%" in result
        assert "weekly" not in result

    def test_none_rate_limits(self):
        result = format_footer(50, None)
        assert result == "📊 ctx 50%"

    def test_empty_rate_limits(self):
        result = format_footer(50, {})
        assert result == "📊 ctx 50%"

    def test_invalid_utilization_skipped(self):
        rate_limits = {
            "five_hour": {"utilization": "bad", "resets_at": "2026-01-01T00:00:00Z"},
        }
        result = format_footer(50, rate_limits)
        assert result == "📊 ctx 50%"

    def test_non_dict_entry_skipped(self):
        rate_limits = {"five_hour": "invalid"}
        result = format_footer(50, rate_limits)
        assert result == "📊 ctx 50%"

    def test_non_dict_rate_limits_skipped(self):
        """rate_limits がリストや数値の場合、クラッシュせずスキップ。"""
        assert format_footer(50, []) == "📊 ctx 50%"
        assert format_footer(50, 1) == "📊 ctx 50%"
        assert format_footer(50, "bad") == "📊 ctx 50%"


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


class TestReadFullCache:
    def test_valid_cache_with_rate_limits(self, tmp_path):
        cache = tmp_path / "context.json"
        data = {
            "used_percentage": 50,
            "rate_limits": {
                "five_hour": {"utilization": 45, "resets_at": "2026-02-21T12:00:00Z"},
                "seven_day": {"utilization": 12, "resets_at": "2026-02-25T12:00:00Z"},
            },
        }
        cache.write_text(json.dumps(data))
        result = read_full_cache(str(cache))
        assert result is not None
        assert result["used_percentage"] == 50
        assert result["rate_limits"]["five_hour"]["utilization"] == 45

    def test_valid_cache_without_rate_limits(self, tmp_path):
        cache = tmp_path / "context.json"
        cache.write_text(json.dumps({"used_percentage": 42}))
        result = read_full_cache(str(cache))
        assert result is not None
        assert result["used_percentage"] == 42
        assert "rate_limits" not in result

    def test_missing_file(self):
        result = read_full_cache("/nonexistent/path.json")
        assert result is None

    def test_invalid_json(self, tmp_path):
        cache = tmp_path / "context.json"
        cache.write_text("not json")
        result = read_full_cache(str(cache))
        assert result is None

    def test_non_numeric_percentage_returns_none(self, tmp_path):
        cache = tmp_path / "context.json"
        cache.write_text(json.dumps({"used_percentage": "bad"}))
        result = read_full_cache(str(cache))
        assert result is None

    def test_missing_percentage_returns_none(self, tmp_path):
        cache = tmp_path / "context.json"
        cache.write_text(json.dumps({"rate_limits": {}}))
        result = read_full_cache(str(cache))
        assert result is None
