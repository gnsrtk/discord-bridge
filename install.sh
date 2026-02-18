#!/usr/bin/env bash
set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'

ok()   { echo -e "${GREEN}✓${RESET} $*"; }
warn() { echo -e "${YELLOW}!${RESET} $*"; }
fail() { echo -e "${RED}✗${RESET} $*"; exit 1; }
info() { echo -e "${BOLD}$*${RESET}"; }

CONFIG_DIR="$HOME/.discord-bridge"
CONFIG_FILE="$CONFIG_DIR/config.json"

info "=== discord-bridge init ==="
echo ""

# ── 1. 前提チェック ────────────────────────────────────────
info "[1/4] Checking prerequisites..."

# Node.js 18+
if ! command -v node &>/dev/null; then
  fail "Node.js が見つかりません。https://nodejs.org/ からインストールしてください。"
fi
NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  fail "Node.js 18 以上が必要です（現在: $(node --version)）"
fi
ok "Node.js $(node --version)"

# tmux
if ! command -v tmux &>/dev/null; then
  fail "tmux が見つかりません。'brew install tmux' でインストールしてください。"
fi
ok "tmux $(tmux -V | awk '{print $2}')"

# Python 3.10+
if ! command -v python3 &>/dev/null; then
  fail "Python 3 が見つかりません。'brew install python' でインストールしてください。"
fi
PY_MINOR=$(python3 -c "import sys; print(sys.version_info.minor)")
PY_MAJOR=$(python3 -c "import sys; print(sys.version_info.major)")
if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 10 ]; }; then
  fail "Python 3.10 以上が必要です（現在: $(python3 --version)）"
fi
ok "$(python3 --version)"

# claude
if ! command -v claude &>/dev/null; then
  warn "claude コマンドが見つかりません。Claude Code をインストールしてください。"
  warn "https://docs.anthropic.com/ja/docs/claude-code"
else
  ok "claude $(claude --version 2>/dev/null | head -1 || echo '(version unknown)')"
fi

echo ""

# ── 2. ビルド ──────────────────────────────────────────────
info "[2/4] Building..."

npm ci --silent
npm run build --silent
ok "Build complete"
echo ""

# ── 3. グローバルリンク ────────────────────────────────────
info "[3/4] Installing discord-bridge globally..."

npm link --silent
ok "discord-bridge linked → $(which discord-bridge)"
echo ""

# ── 4. 設定ファイル ────────────────────────────────────────
info "[4/4] Setting up config..."

mkdir -p "$CONFIG_DIR"

if [ -f "$CONFIG_FILE" ]; then
  ok "Config already exists: $CONFIG_FILE"
else
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cp "$SCRIPT_DIR/config.example.json" "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
  ok "Config template created: $CONFIG_FILE"
  warn "config.json を編集して Discord Bot の情報を入力してください。"
fi

echo ""
info "=== Setup complete! ==="
echo ""
echo "次のステップ:"
echo "  1. $CONFIG_FILE を編集"
echo "  2. discord-bridge start"
echo ""
