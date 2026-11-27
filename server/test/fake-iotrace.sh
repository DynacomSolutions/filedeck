#!/bin/sh
# A stand-in for filedeck-iotrace in the tests. FAKE_IOTRACE says what to do: ok (rows, then wait), fail (first line ok:false, exit 3), crash (rows, exit 1), silent (no output).
case "$FAKE_IOTRACE" in
  fail) printf '{"ok":false,"error":"no BPF in this kernel"}\n'; exit 3 ;;
  silent) exec sleep 30 ;;
  crash) printf '{"t":1,"ok":true,"rows":[]}\n'; sleep 0.2; exit 1 ;;
  *) printf '{"t":1,"ok":true,"rows":[{"dev":"259:0","cg":%s,"pid":4242,"comm":"postgres","r":100,"w":200,"rb":409600,"wb":819200},{"dev":"259:0","cg":%s,"pid":7,"comm":"kworker","r":10,"w":0,"rb":40960,"wb":0},{"dev":"9:9","cg":1,"pid":1,"comm":"x","r":1,"w":1,"rb":1,"wb":1}]}\n' "$FAKE_CG" "$FAKE_CG2"; exec sleep 30 ;;
esac
