import json
from pathlib import Path


def load_config() -> dict:
    config_path = Path.home() / ".discord-bridge" / "config.json"
    with open(config_path) as f:
        return json.load(f)


def resolve_channel(config: dict, cwd: str) -> tuple[str, str | None]:
    """cwd から channel_id と project_name を解決する。
    Returns: (channel_id, project_name) — project_name は一致なしの場合 None
    """
    channel_id = None
    project_name = None
    best_match_len = 0
    for project in config.get("projects", []):
        pp = project.get("projectPath", "").rstrip("/")
        if pp and (cwd == pp or cwd.startswith(pp + "/")) and len(pp) > best_match_len:
            channel_id = project["channelId"]
            project_name = project.get("name", "")
            best_match_len = len(pp)

    if not channel_id:
        projects = config.get("projects", [])
        if not projects:
            raise ValueError("projects is empty in config.json")
        channel_id = projects[0]["channelId"]

    return channel_id, project_name
