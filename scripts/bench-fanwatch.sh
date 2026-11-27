#!/usr/bin/env bash
# Measure the fanotify helper: create FILES files in DIRS folders and report how fast the helper turns the kernel events into lines, and what it costs in CPU.
#
#   scripts/bench-fanwatch.sh [FILES [DIRS]]        (defaults: 100000 files in 100 folders)
#
# The helper needs CAP_SYS_ADMIN and CAP_DAC_READ_SEARCH. Without them (an ordinary user) the script runs inside an unprivileged user namespace on a tmpfs, with the
# test-only library server/test/fanwatch-shim.c standing in for open_by_handle_at (which the kernel refuses there): the numbers then show a folder lookup that is
# much slower than the real call, so they are a lower bound for a path-cache miss, and the cache hits are the real thing.
# Work files go to $FILEDECK_BENCH_DIR (default: a new folder under $TMPDIR), and are removed at the end.
set -euo pipefail
files=${1:-100000}
dirs=${2:-100}
here=$(cd "$(dirname "$0")" && pwd)
# FILEDECK_BENCH_SRC, FILEDECK_BENCH_CLOSE and FILEDECK_BENCH_LINE compare another build of the helper (for example the old one-line-per-folder output:
# FILEDECK_BENCH_CLOSE='^w ' FILEDECK_BENCH_LINE='^[xwm] '): the source file, and the patterns of its "closed after writing" line and of any event line.
src=${FILEDECK_BENCH_SRC:-$here/../server/native/filedeck-fanwatch.c}
close_re=${FILEDECK_BENCH_CLOSE:-^W f }
line_re=${FILEDECK_BENCH_LINE:-^[CDMWAR] }
base=${FILEDECK_BENCH_DIR:-${TMPDIR:-/tmp}}
work=$(mktemp -d "$base/fanbench-XXXXXX")
trap 'rm -rf "$work"' EXIT
cc -O2 -o "$work/helper" "$src"

inner() { # runs the measurement; $1 = work folder (a mount in the user namespace case)
  local w=$1 d=$1/watched
  mkdir -p "$d"
  for i in $(seq "$dirs"); do mkdir "$d/dir$i"; done
  # (the helper's own files are kept outside the watched folder, so its output is not an event)
  local o=$work
  mkfifo "$o/in"
  "$work/helper" "$d" > "$o/out" 2> "$o/err" < "$o/in" &
  local pid=$!
  exec 3> "$o/in"
  for _ in $(seq 100); do grep -q '^#ready' "$o/out" && break; sleep 0.05; done
  local per=$((files / dirs)) t0 t1
  t0=$(date +%s.%N)
  for i in $(seq "$dirs"); do for j in $(seq "$per"); do printf x > "$d/dir$i/f$j"; done; done
  t1=$(date +%s.%N)
  local want=$((per * dirs)) got=0 t2
  for _ in $(seq 600); do
    got=$(grep -c "$close_re" "$o/out" || true)
    [ "$got" -ge "$want" ] && break
    sleep 0.1
  done
  t2=$(date +%s.%N)
  echo sync >&3
  for _ in $(seq 100); do grep -q '^#sync' "$o/out" && break; sleep 0.05; done
  local ticks hz
  ticks=$(awk '{print $14 + $15}' "/proc/$pid/stat"); echo "user and system time (ticks of 1/$(getconf CLK_TCK) s): $(awk '{print $14, $15}' /proc/$pid/stat)"
  hz=$(getconf CLK_TCK)
  kill "$pid" 2> /dev/null || true
  wait "$pid" 2> /dev/null || true
  local lines
  lines=$(grep -c "$line_re" "$o/out" || true)
  awk -v want="$want" -v got="$got" -v lines="$lines" -v t0="$t0" -v t1="$t1" -v t2="$t2" -v ticks="$ticks" -v hz="$hz" 'BEGIN {
    printf "files created:          %d in %.2f s (%.0f files/s)\n", want, t1 - t0, want / (t1 - t0)
    printf "close events seen:      %d of %d (all seen %.2f s after the last file)\n", got, want, t2 - t1
    printf "event lines written:    %d (%.0f lines/s over the whole run)\n", lines, lines / (t2 - t0)
    printf "helper CPU time:        %.2f s (%.1f us per line; %.1f %% of one core during the creation)\n", ticks / hz, (ticks / hz) * 1e6 / lines, (ticks / hz) * 100 / (t1 - t0)
  }'
  grep '^#caps' "$o/out" || true
  grep '^#stats' "$o/out" | tail -1 || true
}

# a helper with its capabilities runs until it is stopped (timeout: status 124); one without them says so and ends with status 2 or 3
probe=0
timeout 1 "$work/helper" "$work" < /dev/null > /dev/null 2>&1 || probe=$?
if [ "$probe" -ne 2 ] && [ "$probe" -ne 3 ]; then
  echo "mode: real (the helper has its capabilities)"
  inner "$work/run"
else
  cc -shared -fPIC -o "$work/shim.so" "$here/../server/test/fanwatch-shim.c" -ldl
  echo "mode: unprivileged user namespace on a tmpfs, open_by_handle_at by a test library"
  export FILEDECK_SHIM_ROOT=$work/run/watched work files dirs close_re line_re
  declare -f inner > "$work/inner.sh"
  unshare -Urm bash -c 'set -euo pipefail; mkdir -p "$1/run"; mount -t tmpfs tmpfs "$1/run"; export LD_PRELOAD=$1/shim.so; source "$1/inner.sh"; inner "$1/run"' _ "$work"
fi
