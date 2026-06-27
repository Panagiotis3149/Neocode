#!/usr/bin/env bash
# build-and-run-neocode.sh — build Neocode then run the CLI
#
# Usage:
#   ./scripts/build-and-run-neocode.sh            # interactive mode
#   ./scripts/build-and-run-neocode.sh --version  # pass-through any args
#
# This runs `bun run build` and then launches dist/cli.mjs with Node.
# If the build fails the script exits before attempting to run.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

echo "Building Neocode..."
bun run build

echo "Starting Neocode..."
exec node "$ROOT_DIR/dist/cli.mjs" "$@"
