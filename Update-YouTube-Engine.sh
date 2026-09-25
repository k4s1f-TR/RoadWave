#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
exec node scripts/install-youtube.mjs --update
