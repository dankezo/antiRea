#!/bin/bash
# Restart the maze bench server with fresh in-memory state.
# Usage: restart-server.sh [port] [reqlog]
set -u
cd "$(dirname "$0")"
PORT="${1:-8931}"
REQLOG="${2:-$PWD/requests.log}"
if command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
  sleep 0.5
fi
rm -f "$REQLOG"
PORT="$PORT" REQLOG="$REQLOG" setsid nohup node server.cjs > server.out 2>&1 < /dev/null &
for i in $(seq 1 40); do
  if curl -s "http://127.0.0.1:${PORT}/__stats" >/dev/null 2>&1; then
    echo "server up on port ${PORT}"
    exit 0
  fi
  sleep 0.25
done
echo "server did not come up" >&2
exit 1
