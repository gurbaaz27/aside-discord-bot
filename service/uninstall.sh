#!/bin/bash
set -euo pipefail

LABEL="com.gurbaaz.aside-discord-bot"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST_PATH"
echo "Stopped and removed $LABEL."
