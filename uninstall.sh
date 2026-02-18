#!/usr/bin/env bash
set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'

ok()   { echo -e "${GREEN}✓${RESET} $*"; }
warn() { echo -e "${YELLOW}!${RESET} $*"; }
info() { echo -e "${BOLD}$*${RESET}"; }

PID_FILE="$HOME/.discord-bridge/discord-bridge.pid"
CONFIG_DIR="$HOME/.discord-bridge"

info "=== discord-bridge uninstall ==="
echo ""

# ── 1. 停止 ───────────────────────────────────────────────
info "[1/3] Stopping discord-bridge..."

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    rm -f "$PID_FILE"
    ok "Stopped (PID $PID)"
  else
    rm -f "$PID_FILE"
    ok "Not running (stale PID file removed)"
  fi
else
  ok "Not running"
fi

echo ""

# ── 2. グローバルリンク解除 ────────────────────────────────
info "[2/3] Removing global link..."

if command -v discord-bridge &>/dev/null; then
  npm unlink --global discord-bridge 2>/dev/null || npm unlink 2>/dev/null || true
  ok "discord-bridge unlinked"
else
  ok "Already unlinked"
fi

echo ""

# ── 3. 設定ディレクトリ ────────────────────────────────────
info "[3/3] Config directory: $CONFIG_DIR"

if [ -d "$CONFIG_DIR" ]; then
  echo -n "設定ファイルを削除しますか? (config.json, ログ等) [y/N]: "
  read -r ANSWER
  if [[ "$ANSWER" =~ ^[Yy]$ ]]; then
    rm -rf "$CONFIG_DIR"
    ok "Removed $CONFIG_DIR"
  else
    ok "Kept $CONFIG_DIR"
  fi
else
  ok "Config directory not found, nothing to remove"
fi

echo ""
info "=== Uninstall complete! ==="
echo ""
