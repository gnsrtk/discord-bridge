"""Context window progress bar and rate limit utilities."""
from __future__ import annotations

import json
from datetime import datetime, timezone


CACHE_PATH_TEMPLATE = "/tmp/discord-bridge-context-{session_id}.json"



def format_reset_time(resets_at: str) -> str:
    """Format ISO 8601 reset time as human-readable remaining time."""
    try:
        reset_str = resets_at.replace("Z", "+00:00")
        reset_dt = datetime.fromisoformat(reset_str)
        now = datetime.now(timezone.utc)
        diff = (reset_dt - now).total_seconds()
        mins = max(0, int(diff / 60))
        if mins >= 1440:
            days = mins // 1440
            hours = (mins % 1440) // 60
            return f"{days}d{hours:02d}h"
        if mins >= 60:
            return f"{mins // 60}h{mins % 60:02d}m"
        return f"{mins}m"
    except Exception:
        return "?"


def format_rate_limit_entry(label: str, utilization: int, resets_at: str) -> str:
    """Format a single rate limit entry like 'session:45%(2h30m)'."""
    reset = format_reset_time(resets_at)
    return f"{label}:{utilization}%({reset})"


def format_context_status(used_percentage: int, model: str | None = None) -> str:
    """Format context usage with model name.

    Returns: e.g. "📊 Opus 4.6 50%" or "📊 ctx 50%" if no model name
    """
    clamped = max(0, min(100, used_percentage))
    label = model if model else "ctx"
    return f"📊 {label} {clamped}%"


def format_footer(
    used_percentage: int,
    rate_limits: dict | None = None,
    model: str | None = None,
) -> str:
    """Format the full Discord footer with model, context %, and rate limits.

    Returns: e.g. "Opus 4.6 50% │ session:45%(2h30m) │ weekly:12%(5d03h)"
    """
    parts = [format_context_status(used_percentage, model)]

    if rate_limits and isinstance(rate_limits, dict):
        fh = rate_limits.get("five_hour")
        if fh and isinstance(fh, dict):
            util = fh.get("utilization")
            reset = fh.get("resets_at", "")
            if isinstance(util, (int, float)):
                parts.append(format_rate_limit_entry("session", int(util), reset))
        sd = rate_limits.get("seven_day")
        if sd and isinstance(sd, dict):
            util = sd.get("utilization")
            reset = sd.get("resets_at", "")
            if isinstance(util, (int, float)):
                parts.append(format_rate_limit_entry("weekly", int(util), reset))

    return " │ ".join(parts)


def read_context_cache(cache_path: str) -> int | None:
    """Read used_percentage from cache file. Returns None if unavailable."""
    try:
        with open(cache_path) as f:
            data = json.load(f)
        val = data["used_percentage"]
        if not isinstance(val, (int, float)):
            return None
        return int(val)
    except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError):
        return None


def read_full_cache(cache_path: str) -> dict | None:
    """Read full cache including rate_limits. Returns None if unavailable."""
    try:
        with open(cache_path) as f:
            data = json.load(f)
        if not isinstance(data.get("used_percentage"), (int, float)):
            return None
        return data
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return None
