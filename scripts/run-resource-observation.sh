#!/usr/bin/env bash
# The caller supplies pinned Node/npm on PATH. All desktop operations are isolated.
set -euo pipefail
observation_project="$(cd "$(dirname "$0")/.." && pwd)"
observation_display_log="$(mktemp -d /tmp/dsh-p1-display-XXXXXX)"
export DISPLAY=":$((100 + $$ % 1000))"
display_pid=''
manager_pid=''
cleanup() {
  if [ -n "$manager_pid" ]; then kill "$manager_pid" 2>/dev/null || true; wait "$manager_pid" 2>/dev/null || true; fi
  if [ -n "$display_pid" ]; then kill "$display_pid" 2>/dev/null || true; wait "$display_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'DISPLAY_LOG=%s\n' "$observation_display_log"
Xvfb "$DISPLAY" -screen 0 1200x800x24 -nolisten tcp > "$observation_display_log/xvfb.log" 2>&1 &
display_pid=$!
for attempt in {1..100}; do
  kill -0 "$display_pid"
  if xdpyinfo -display "$DISPLAY" > /dev/null 2>&1; then break; fi
  sleep .1
done
xdpyinfo -display "$DISPLAY" > "$observation_display_log/xdpyinfo.txt"
openbox > "$observation_display_log/openbox.log" 2>&1 &
manager_pid=$!
for attempt in {1..100}; do
  kill -0 "$manager_pid"
  if xprop -root _NET_SUPPORTING_WM_CHECK | grep -q 'window id'; then break; fi
  sleep .1
done
xprop -root _NET_SUPPORTING_WM_CHECK | grep -q 'window id'
cd "$observation_project"
dbus-run-session -- node scripts/observe-companion.mjs "$@"
