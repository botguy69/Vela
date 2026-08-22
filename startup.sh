#!/bin/sh
set -eu
cd /workspace
export PGLITE_DATA_DIR="/workspace/data/pglite"
export VELA_WORKER="1"
mkdir -p "$PGLITE_DATA_DIR"
if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
  exit 0
fi
npm run dev >>/tmp/app-startup.log 2>&1 &
