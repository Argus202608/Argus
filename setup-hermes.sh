#!/bin/bash
# Backward-compatible launcher retained for existing clone/setup instructions.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/setup-argus.sh" "$@"
