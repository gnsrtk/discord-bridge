from __future__ import annotations

import json
from pathlib import Path


def load_config() -> dict:
    config_path = Path.home() / ".discord-bridge" / "config.json"
    with open(config_path) as f:
        return json.load(f)


def resolve_channel(config: dict, cwd: str) -> tuple[str, str, str | None, list[str]]:
    """cwd から (channel_id, bot_token, project_name, permission_tools) を解決する。
    servers[] をループし、projectPath × cwd で最長一致を選択。
    不一致時は ValueError を raise する。
    """
    best_channel_id: str | None = None
    best_bot_token: str | None = None
    best_project_name: str | None = None
    best_permission_tools: list[str] = []
    best_match_len = 0

    for server in config.get("servers", []):
        bot_token = server.get("discord", {}).get("botToken", "")
        permission_tools = server.get("permissionTools", [])
        for project in server.get("projects", []):
            pp = project.get("projectPath", "").rstrip("/")
            if pp and (cwd == pp or cwd.startswith(pp + "/")) and len(pp) > best_match_len:
                best_channel_id = project["channelId"]
                best_bot_token = bot_token
                best_project_name = project.get("name")
                best_permission_tools = permission_tools
                best_match_len = len(pp)

    if best_channel_id and best_bot_token:
        return best_channel_id, best_bot_token, best_project_name, best_permission_tools

    raise ValueError(f"No project matches cwd: {cwd!r}")
