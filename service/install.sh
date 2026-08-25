#!/bin/bash
set -euo pipefail

LABEL="com.gurbaaz.aside-discord-bot"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
TEMPLATE="$SCRIPT_DIR/$LABEL.plist.template"

BUN_PATH="${BUN_PATH:-$(command -v bun || true)}"
if [[ -z "$BUN_PATH" || ! -x "$BUN_PATH" ]]; then
  echo "Could not find Bun. Install Bun or set BUN_PATH=/absolute/path/to/bun." >&2
  exit 1
fi

if [[ ! -f "$PROJECT_DIR/.env" ]]; then
  echo "Missing $PROJECT_DIR/.env. Copy .env.example and configure it first." >&2
  exit 1
fi

mkdir -p "$PLIST_DIR" "$PROJECT_DIR/.data/logs"

python3 - "$TEMPLATE" "$PLIST_PATH" "$PROJECT_DIR" "$BUN_PATH" <<'PY'
from pathlib import Path
import sys

source, destination, project_dir, bun_path = map(Path, sys.argv[1:])
text = source.read_text()
text = text.replace("__PROJECT_DIR__", str(project_dir))
text = text.replace("__BUN_PATH__", str(bun_path))
text = text.replace("__BUN_DIR__", str(bun_path.parent))
Path(destination).write_text(text)
PY

plutil -lint "$PLIST_PATH"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

cat <<EOF
Installed and started $LABEL.

Status:
  launchctl print gui/$(id -u)/$LABEL

Logs:
  tail -f "$PROJECT_DIR/.data/logs/bot.log" "$PROJECT_DIR/.data/logs/bot-error.log"
EOF
