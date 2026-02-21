"""Context window progress bar utilities."""

import json


CACHE_PATH_TEMPLATE = "/tmp/discord-bridge-context-{session_id}.json"


def format_progress_bar(used_percentage: int) -> str:
    """Format context usage as a visual progress bar.

    Returns: e.g. "📊 █████░░░░░ 50%"
    """
    clamped = max(0, min(100, used_percentage))
    filled = round(clamped / 10)
    empty = 10 - filled

    if clamped >= 90:
        emoji = "🚨"
    elif clamped >= 70:
        emoji = "⚠️"
    else:
        emoji = "📊"

    bar = "█" * filled + "░" * empty
    return f"{emoji} {bar} {clamped}%"


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
