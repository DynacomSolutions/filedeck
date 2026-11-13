#!/usr/bin/env bash
# Memory check of a big du: builds the agent, then runs scripts/scan-memory.mjs under a hard memory cap (a systemd user scope: the process is killed if it
# goes over, like an agent pod) when one is available, with the heap limit and a clean temp folder as in the pod.
# usage: scripts/scan-memory-check.sh <work-dir> [folders=50000] [files-per-folder=60] [cap=256M]
# 50000 folders x 60 files = 3 million files. The tree is kept in <work-dir> for the next run; delete it when done.
set -euo pipefail
work=${1:?usage: scan-memory-check.sh <work-dir> [folders] [files-per-folder] [cap]}
folders=${2:-50000}
files=${3:-60}
cap=${4:-256M}
here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mkdir -p "$work" && cd "$work" && pwd)
(cd "$here" && npm run build -w server >/dev/null)
# the pod's /tmp is an empty volume; a big shared /tmp would make the agent's own temp-folder sweep part of the measurement
export TMPDIR="$work/tmp"
mkdir -p "$TMPDIR"
cmd=(node --max-old-space-size=160 "$here/scripts/scan-memory.mjs" "$work" "$folders" "$files")
if command -v systemd-run >/dev/null && systemd-run --user --scope -q -p MemoryMax=1G true 2>/dev/null; then
  echo "running under a memory cap of $cap (MemoryMax, no swap)"
  exec systemd-run --user --scope -q -p MemoryMax="$cap" -p MemorySwapMax=0 --setenv=TMPDIR="$TMPDIR" -- "${cmd[@]}"
fi
echo "no systemd user scope here: running without a cap (the RSS samples still tell)"
exec "${cmd[@]}"
