#!/usr/bin/env bash
# Test only (fanwatch-live.test.ts): runs the fanotify helper on a work folder, makes changes in it, and prints what the helper wrote.
#   fanwatch-scenario.sh SCENARIO HELPER WORKDIR
# The helper's stdout is printed, then a line "--- stderr", then its stderr.
set -u
scenario=$1 helper=$2 w=$3
mkdir -p "$w/watched"
cd "$w"
mkfifo in
"$helper" "$w/watched" < in > out 2> err &
pid=$!
exec 3> in
for _ in $(seq 100); do grep -q '^#ready' out 2> /dev/null && break; sleep 0.05; done
sync_and_stop() {
  echo sync >&3
  for _ in $(seq 100); do grep -q '^#sync' out && break; sleep 0.05; done
  kill "$pid" 2> /dev/null
  wait "$pid" 2> /dev/null
  cat out
  echo "--- stderr"
  cat err
}
d=$w/watched
case $scenario in
basic)
  mkdir "$d/a"
  echo hi > "$d/a/f.txt"
  mv "$d/a/f.txt" "$d/a/g.txt"
  mkdir "$d/a/d"
  echo x > "$d/a/d/x"
  mv "$d/a" "$d/b"
  echo y > "$d/b/d/y"
  chmod 600 "$d/b/g.txt"
  printf 'odd' > "$d/b/$(printf 'we\nird\\name')"
  rm "$d/b/g.txt"
  rm -r "$d/b/d"
  rmdir "$d/b" 2> /dev/null || rm -r "$d/b"
  sync_and_stop
  ;;
tree)
  mkdir -p "$d/t/u/v"
  for i in 1 2 3; do echo x > "$d/t/u/v/f$i"; done
  sleep 0.5
  rm -rf "$d/t"
  sync_and_stop
  ;;
burst)
  for i in $(seq 20); do mkdir "$d/dir$i"; done
  for i in $(seq 20); do for j in $(seq 50); do : > "$d/dir$i/f$j"; done; done
  sync_and_stop
  ;;
trailing)
  exec 4>> "$d/log"
  for _ in $(seq 20); do echo x >&4; sleep 0.1; done
  sleep 2.5
  sync_and_stop
  ;;
mounts)
  # a mount change must come out as one "#mounts" line within a second, and a quiet table must print none
  sleep 0.5
  grep -q '^#mounts' out && echo "early #mounts" >> err
  mkdir "$w/extra"
  mount -t tmpfs tmpfs "$w/extra"
  for _ in $(seq 20); do grep -q '^#mounts' out && break; sleep 0.05; done
  umount "$w/extra"
  sync_and_stop
  ;;
esac
