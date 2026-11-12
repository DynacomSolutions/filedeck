#!/usr/bin/env bash
# Smoke check of a built Filedeck image: agent and hub start and answer, the du CLI runs, the shipped tools are present.
# usage: scripts/ci-image-smoke.sh <image> [agent-port] [hub-port]
set -euo pipefail
image=${1:?usage: ci-image-smoke.sh <image> [agent-port] [hub-port]}
aport=${2:-18081}
hport=${3:-18080}
work=$(mktemp -d)
cleanup() {
  docker rm -f filedeck-smoke-agent filedeck-smoke-hub >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
chmod 755 "$work"
echo smoke > "$work/hello.txt"

wait_for() { # url, expected substring (optional)
  local url=$1 want=${2:-} body
  for _ in $(seq 1 60); do
    if body=$(curl -fsS --max-time 3 "$url" 2>/dev/null) && [[ "$body" == *"$want"* ]]; then
      printf '%s' "$body"
      return 0
    fi
    sleep 1
  done
  echo "timeout waiting for $url (wanted: ${want:-any answer})" >&2
  docker logs filedeck-smoke-agent >&2 || true
  docker logs filedeck-smoke-hub >&2 || true
  return 1
}

echo "== agent"
docker run -d --name filedeck-smoke-agent --network host -v "$work:/data" \
  -e FILEDECK_MODE=agent -e FILEDECK_ROOT=/data -e FILEDECK_NODE=local -e PORT="$aport" "$image" >/dev/null
echo "agent /healthz: $(wait_for "http://127.0.0.1:$aport/healthz" ok)"

echo "== hub"
docker run -d --name filedeck-smoke-hub --network host \
  -e FILEDECK_MODE=hub -e NODES="local=http://127.0.0.1:$aport" -e PORT="$hport" "$image" >/dev/null
echo "hub /healthz: $(wait_for "http://127.0.0.1:$hport/healthz" ok)"
shell=$(wait_for "http://127.0.0.1:$hport/" '<div id="root">')
echo "hub app shell: ${#shell} bytes, has the root element"
nodes=$(wait_for "http://127.0.0.1:$hport/api/nodes" '"local"')
echo "hub /api/nodes: $nodes"
list=$(wait_for "http://127.0.0.1:$hport/api/nodes/local/api/fs/list?path=/" hello.txt)
echo "hub -> agent listing contains hello.txt (${#list} bytes)"

echo "== du CLI"
docker run --rm --entrypoint filedeck "$image" du --help | head -3

echo "== tool versions"
docker run --rm --entrypoint sh "$image" -c '
  set -e
  for t in 7zz bsdtar qpdf ffmpeg git smbclient; do command -v "$t" >/dev/null || { echo "missing: $t" >&2; exit 1; }; done
  7zz | sed -n 2p
  bsdtar --version
  qpdf --version | head -1
  ffmpeg -version | head -1
  git --version
  smbclient --version
  node --version
'
echo "smoke check passed"
