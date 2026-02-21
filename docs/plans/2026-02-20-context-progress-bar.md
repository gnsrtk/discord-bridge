# Context Window Progress Bar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Display context window usage as a progress bar footer on every Discord message.

**Architecture:** statusLine.command writes context data to `/tmp` cache file. stop.py reads that cache and appends a progress bar to each Discord message.

**Tech Stack:** Python 3 (hooks), Claude Code statusLine API

---

### Task 1: Create progress bar formatter (`hooks/lib/context.py`)

**Files:**
- Create: `hooks/lib/context.py`
- Create: `tests/test_context.py`

**Step 1: Write the failing tests**

File: `tests/test_context.py`

```python
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
```

**Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_context.py -v`
Expected: FAIL (ImportError — module not found)

**Step 3: Write implementation**

File: `hooks/lib/context.py`

```python
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
        return data["used_percentage"]
    except (OSError, json.JSONDecodeError, KeyError):
        return None
```

**Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_context.py -v`
Expected: All PASS

**Step 5: Commit**

```bash
git add hooks/lib/context.py tests/test_context.py
git commit -m "feat: add context window progress bar formatter"
```

---

### Task 2: Create statusLine script (`hooks/statusline.py`)

**Files:**
- Create: `hooks/statusline.py`
- Add tests to: `tests/test_context.py`

**Step 1: Write the failing tests**

Append to `tests/test_context.py`:

```python
import io
import unittest.mock as mock

import statusline


class TestStatusLine:
    def test_writes_cache_file(self, tmp_path):
        """stdin の context_window を cache ファイルに書き出す。"""
        stdin_data = {
            "session_id": "test-session-1",
            "context_window": {
                "used_percentage": 62,
                "remaining_percentage": 38,
                "context_window_size": 200000,
            },
        }
        cache_path = str(tmp_path / "context.json")
        with mock.patch("sys.stdin", io.StringIO(json.dumps(stdin_data))), \
             mock.patch("statusline.CACHE_PATH_TEMPLATE", str(tmp_path / "discord-bridge-context-{session_id}.json")):
            statusline.main()

        expected_file = tmp_path / "discord-bridge-context-test-session-1.json"
        assert expected_file.exists()
        data = json.loads(expected_file.read_text())
        assert data["used_percentage"] == 62

    def test_outputs_statusline_text(self, tmp_path):
        """stdout に statusLine テキストを出力する。"""
        stdin_data = {
            "session_id": "test-session-2",
            "context_window": {
                "used_percentage": 85,
                "remaining_percentage": 15,
                "context_window_size": 200000,
            },
        }
        with mock.patch("sys.stdin", io.StringIO(json.dumps(stdin_data))), \
             mock.patch("statusline.CACHE_PATH_TEMPLATE", str(tmp_path / "discord-bridge-context-{session_id}.json")), \
             mock.patch("sys.stdout", new_callable=io.StringIO) as mock_stdout:
            statusline.main()
        output = mock_stdout.getvalue().strip()
        assert "85%" in output

    def test_no_context_window_skips(self, tmp_path):
        """context_window がない場合はキャッシュを書かない。"""
        stdin_data = {"session_id": "test-session-3"}
        with mock.patch("sys.stdin", io.StringIO(json.dumps(stdin_data))), \
             mock.patch("statusline.CACHE_PATH_TEMPLATE", str(tmp_path / "discord-bridge-context-{session_id}.json")):
            statusline.main()
        expected_file = tmp_path / "discord-bridge-context-test-session-3.json"
        assert not expected_file.exists()
```

**Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_context.py::TestStatusLine -v`
Expected: FAIL (ImportError)

**Step 3: Write implementation**

File: `hooks/statusline.py`

```python
#!/usr/bin/env python3
"""StatusLine hook: context window data をキャッシュし、statusLine テキストを出力する。"""

import json
import sys

CACHE_PATH_TEMPLATE = "/tmp/discord-bridge-context-{session_id}.json"


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError:
        return

    session_id = data.get("session_id", "")
    context_window = data.get("context_window")

    if context_window and session_id:
        cache_path = CACHE_PATH_TEMPLATE.format(session_id=session_id)
        cache_data = {"used_percentage": context_window.get("used_percentage", 0)}
        try:
            with open(cache_path, "w") as f:
                json.dump(cache_data, f)
        except OSError:
            pass

    # statusLine text output
    if context_window:
        pct = context_window.get("used_percentage", 0)
        print(f"ctx: {pct}%")


if __name__ == "__main__":
    main()
```

**Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_context.py -v`
Expected: All PASS

**Step 5: Commit**

```bash
git add hooks/statusline.py tests/test_context.py
git commit -m "feat: add statusLine hook for context window caching"
```

---

### Task 3: Integrate progress bar into stop.py

**Files:**
- Modify: `hooks/stop.py:14-17` (add import)
- Modify: `hooks/stop.py:235-237` (append progress bar)
- Add tests to: `tests/test_hooks.py`

**Step 1: Write the failing test**

Append to `tests/test_hooks.py` (after `TestStopMainWithThread`):

```python
class TestStopContextProgressBar:
    def test_progress_bar_appended(self):
        """コンテキストキャッシュがある場合、プログレスバーがメッセージ末尾に付く。"""
        session_id = str(uuid.uuid4())
        cache_path = f"/tmp/discord-bridge-context-{session_id}.json"
        Path(cache_path).write_text(json.dumps({"used_percentage": 42}))

        hook_input = {
            "session_id": session_id,
            "transcript_path": "",
            "cwd": "/tmp/test-project",
            "last_assistant_message": "Done.",
        }
        mock_config = {"schemaVersion": 2, "servers": []}
        try:
            with mock.patch("sys.stdin", io.StringIO(json.dumps(hook_input))), \
                 mock.patch("stop.load_config", return_value=mock_config), \
                 mock.patch("stop.resolve_channel", return_value=("chan-001", "token-xxx", "test", [])), \
                 mock.patch("stop.post_message") as mock_post:
                stop.main()
            content = mock_post.call_args[0][2]
            assert "████░░░░░░" in content
            assert "42%" in content
        finally:
            Path(cache_path).unlink(missing_ok=True)

    def test_no_cache_no_bar(self):
        """コンテキストキャッシュがない場合、プログレスバーは付かない。"""
        session_id = str(uuid.uuid4())
        hook_input = {
            "session_id": session_id,
            "transcript_path": "",
            "cwd": "/tmp/test-project",
            "last_assistant_message": "Done.",
        }
        mock_config = {"schemaVersion": 2, "servers": []}
        with mock.patch("sys.stdin", io.StringIO(json.dumps(hook_input))), \
             mock.patch("stop.load_config", return_value=mock_config), \
             mock.patch("stop.resolve_channel", return_value=("chan-001", "token-xxx", "test", [])), \
             mock.patch("stop.post_message") as mock_post:
            stop.main()
        content = mock_post.call_args[0][2]
        assert "█" not in content
        assert "░" not in content
```

**Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_hooks.py::TestStopContextProgressBar -v`
Expected: FAIL

**Step 3: Modify stop.py**

Add import at line 17 (after existing lib imports):

```python
from lib.context import format_progress_bar, read_context_cache, CACHE_PATH_TEMPLATE
```

Add progress bar logic at line 236 (after `display_text = clean_message`, before `_dbg`):

```python
    # Append context progress bar if cache exists
    cache_path = CACHE_PATH_TEMPLATE.format(session_id=session_id)
    used_pct = read_context_cache(cache_path)
    if used_pct is not None:
        display_text += f"\n\n{format_progress_bar(used_pct)}"
```

**Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_hooks.py -v`
Expected: All PASS

**Step 5: Run full test suite**

Run: `python3 -m pytest tests/test_hooks.py tests/test_context.py -v`
Expected: All PASS

**Step 6: Commit**

```bash
git add hooks/stop.py tests/test_hooks.py
git commit -m "feat: append context progress bar to Discord messages"
```

---

### Task 4: Configure statusLine in settings

**Files:**
- Modify: `.claude/settings.local.json`

**Step 1: Add statusLine command**

Add to `.claude/settings.local.json`:

```json
{
  "permissions": { ... },
  "statusLine": {
    "command": "python3 /Users/g_taki/projects/repos/discord-bridge/hooks/statusline.py"
  }
}
```

**Step 2: Verify manually**

1. Restart Claude Code session
2. Send a message and confirm `/tmp/discord-bridge-context-*.json` is created
3. Confirm Discord message has progress bar footer

**Step 3: Commit**

```bash
git add .claude/settings.local.json
git commit -m "feat: configure statusLine for context progress bar"
```

---

### Task 5: Update documentation

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/ARCHITECTURE_en.md`
- Modify: `CHANGELOG.md`

**Step 1: Add progress bar section to ARCHITECTURE.md / ARCHITECTURE_en.md**

Add section describing:
- statusLine hook flow
- Cache file format (`/tmp/discord-bridge-context-{session_id}.json`)
- Progress bar display format and severity levels

**Step 2: Add CHANGELOG entry**

```markdown
## v1.8.0

### Added
- Context window progress bar on every Discord message footer
- `hooks/statusline.py` — statusLine command for caching context data
- `hooks/lib/context.py` — progress bar formatting utilities
```

**Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md docs/ARCHITECTURE_en.md CHANGELOG.md
git commit -m "docs: add context progress bar documentation"
```
