#!/usr/bin/env bash
# install-neocode.sh — make `neocode` available as a global command
#
# Strategy:
#   1. Build the CLI (dist/cli.mjs + bin/neocode must exist after).
#   2. Link this package globally via `bun link` so `neocode` resolves from
#      any directory on PATH.
#
# After running this script you can use `neocode` from any terminal:
#   neocode --version
#   neocode
#
# Prerequisites:
#   - Bun installed and on PATH
#   - This script run from the repo root (or any path inside the repo)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

echo "Step 1/2: Building Neocode..."
bun run build

echo "Step 2/2: Linking neocode globally via bun link..."
bun link

echo ""
echo "Done. You can now run Neocode from anywhere:"
echo "  neocode --version"
echo "  neocode"
echo ""
echo "If 'neocode' is not found on PATH, ensure Bun's global bin directory"
echo "is on your PATH. You can find it with:  bun pm bin -g"
