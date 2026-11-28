#!/bin/sh
# A stand-in for filedeck-iotrace in the tests. It waits for `read` lines on its input and answers each with one JSON line, like the real helper.
# FAKE_IOTRACE says what to do: ok (rows, t moves 1 s per read), fail (first line ok:false, exit 3), crash (exit 1 at the first read), silent (never answers).
t=1000000
while read -r line; do
  case "$FAKE_IOTRACE" in
    fail) printf '{"ok":false,"error":"no BPF in this kernel"}\n'; exit 3 ;;
    crash) exit 1 ;;
    silent) exec sleep 30 ;;
    *) t=$((t + 1000)); printf '{"t":%s,"ok":true,"rows":[{"dev":"259:0","cg":%s,"pid":4242,"comm":"postgres","r":100,"w":200,"rb":409600,"wb":819200},{"dev":"259:0","cg":%s,"pid":7,"comm":"kworker","r":10,"w":0,"rb":40960,"wb":0},{"dev":"9:9","cg":1,"pid":1,"comm":"x","r":1,"w":1,"rb":1,"wb":1}]}\n' "$t" "$FAKE_CG" "$FAKE_CG2" ;;
  esac
done
