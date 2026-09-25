#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 or later is required." >&2
  exit 1
fi

node scripts/setup.mjs
exec node server.mjs --open
