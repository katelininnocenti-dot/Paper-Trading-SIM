#!/usr/bin/env bash
cd "$(dirname "$0")"
if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi
exec node server.js
