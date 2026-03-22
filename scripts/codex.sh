#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

export CODEX_CLI_PATH="$ROOT_DIR/scripts/stdio-tap.mjs"

export TAP_LOG=/tmp/codapter-codex-stdio.log
export TAP_TARGET=codex

rm -f "$TAP_LOG"
/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port=9222
