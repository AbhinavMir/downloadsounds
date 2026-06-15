#!/usr/bin/env bash
# Install/uninstall the YTD_DJ helper as a macOS LaunchAgent.
# Usage:
#   ./service.sh install   # generate + load plist (starts now, runs at login)
#   ./service.sh uninstall # unload + remove plist
#   ./service.sh restart   # unload + load (use after editing main.py)
#   ./service.sh status    # show running state + last log lines
#   ./service.sh log       # tail the log

set -e
HELPER_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="$HELPER_DIR/com.ytddj.helper.plist.template"
LABEL="com.ytddj.helper"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/.ytd_dj/helper.log"

case "${1:-}" in
  install)
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.ytd_dj"
    sed \
      -e "s|__RUN_SH__|$HELPER_DIR/run.sh|g" \
      -e "s|__HELPER_DIR__|$HELPER_DIR|g" \
      -e "s|__LOG_PATH__|$LOG|g" \
      "$TEMPLATE" > "$PLIST_DEST"
    launchctl unload "$PLIST_DEST" 2>/dev/null || true
    launchctl load "$PLIST_DEST"
    echo "Installed. Helper running on http://127.0.0.1:7531"
    echo "Logs: $LOG"
    ;;
  uninstall)
    launchctl unload "$PLIST_DEST" 2>/dev/null || true
    rm -f "$PLIST_DEST"
    echo "Uninstalled."
    ;;
  restart)
    launchctl unload "$PLIST_DEST" 2>/dev/null || true
    launchctl load "$PLIST_DEST"
    echo "Restarted."
    ;;
  status)
    if launchctl list | grep -q "$LABEL"; then
      launchctl list | grep "$LABEL"
      echo "---"
      tail -n 20 "$LOG" 2>/dev/null || echo "(no log yet)"
    else
      echo "Not loaded. Run: $0 install"
    fi
    ;;
  log)
    tail -f "$LOG"
    ;;
  *)
    echo "Usage: $0 {install|uninstall|restart|status|log}"
    exit 1
    ;;
esac
