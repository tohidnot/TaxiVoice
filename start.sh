#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -d node_modules/electron ]]; then
  npm install --no-fund --no-audit
fi
exec npx electron .
