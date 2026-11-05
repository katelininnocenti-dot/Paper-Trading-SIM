#!/usr/bin/env bash
# Local restarter. Render runs `node server.js` directly and does not use this script.
cd "$(dirname "$0")"
if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi
while true; do
  node server.js
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) server exited, restarting in 3s" >&2
  sleep 3
done
