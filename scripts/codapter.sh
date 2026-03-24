#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

export CODAPTER_COLLAB_EXTENSION_PATH="$ROOT_DIR/packages/collab-extension/dist/index.js"
export CODAPTER_COLLAB=true
export CODAPTER_DEBUG_LOG_FILE=/tmp/codapter.jsonl
export CODEX_CLI_PATH="$ROOT_DIR/scripts/stdio-tap.mjs"

export TAP_LOG=/tmp/codapter-stdio.log
export TAP_TARGET="$ROOT_DIR/dist/codapter.mjs"

rm -f "$TAP_LOG"
rm -f "$CODAPTER_DEBUG_LOG_FILE"
/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9222
