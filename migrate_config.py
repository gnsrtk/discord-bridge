#!/usr/bin/env python3
"""migrate_config.py — ~/.discord-bridge/config.json を schemaVersion 1 → 2 に変換する"""
import json
import shutil
import sys
from pathlib import Path

CONFIG_PATH = Path.home() / ".discord-bridge" / "config.json"
BACKUP_PATH = CONFIG_PATH.with_suffix(".json.bak")


def migrate(v1: dict) -> dict:
    if v1.get("schemaVersion") != 1:
        print(f"[migrate] schemaVersion が 1 ではありません ({v1.get('schemaVersion')}). スキップします。")
        sys.exit(0)

    return {
        "schemaVersion": 2,
        "servers": [
            {
                "name": "personal",
                "discord": v1["discord"],
                "tmux": v1["tmux"],
                "projects": v1["projects"],
            }
        ],
    }


def main() -> None:
    if not CONFIG_PATH.exists():
        print(f"[migrate] 設定ファイルが見つかりません: {CONFIG_PATH}")
        sys.exit(1)

    with open(CONFIG_PATH) as f:
        v1 = json.load(f)

    v2 = migrate(v1)

    shutil.copy2(CONFIG_PATH, BACKUP_PATH)
    print(f"[migrate] バックアップ作成: {BACKUP_PATH}")

    with open(CONFIG_PATH, "w") as f:
        json.dump(v2, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"[migrate] 変換完了: {CONFIG_PATH}")
    print("[migrate] servers[0].name は 'personal' に設定されました。必要に応じて編集してください。")


if __name__ == "__main__":
    main()
