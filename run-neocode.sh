#!/usr/bin/env bash
# run-neocode.sh — run the latest built Neocode CLI from dist/cli.mjs
#
# Usage:
#   ./scripts/run-neocode.sh            # interactive mode
#   ./scripts/run-neocode.sh --version  # pass-through any args
#
# Prerequisites:
#   - `bun run build` has been run at least once (dist/cli.mjs must exist)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_PATH="$ROOT_DIR/dist/cli.mjs"

if [[ ! -f "$CLI_PATH" ]]; then
  echo "Neocode: dist/cli.mjs not found." >&2
  echo "" >&2
  echo "Build first:" >&2
  echo "  bun run build" >&2
  exit 1
fi

exec node "$CLI_PATH" "$@"
