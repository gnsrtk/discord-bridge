"""hooks/lib/thread.py — スレッドトラッキング用ユーティリティ"""

import json
import os

THREAD_TRACKING_DIR = "/tmp"


def _tracking_path(channel_id: str) -> str:
    return os.path.join(THREAD_TRACKING_DIR, f"discord-bridge-thread-{channel_id}.json")


def get_thread_id(channel_id: str) -> str | None:
    """トラッキングファイルから threadId を読み取る。なければ None。"""
    path = _tracking_path(channel_id)
    try:
        with open(path) as f:
            data = json.load(f)
        return data.get("threadId")
    except (OSError, json.JSONDecodeError, KeyError):
        return None


def resolve_target_channel(channel_id: str) -> str:
    """アクティブスレッドがあればスレッドID、なければ channel_id を返す。"""
    thread_id = get_thread_id(channel_id)
    return thread_id if thread_id else channel_id


def clear_thread_tracking(channel_id: str) -> None:
    """トラッキングファイルを削除する。"""
    path = _tracking_path(channel_id)
    try:
        os.unlink(path)
    except OSError:
        pass
