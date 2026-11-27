#!/usr/bin/env bash
set -euo pipefail
umask 077

cd "$(dirname "$0")/.."
parent=${FILEDECK_TEST_ROOT:-$PWD/.data}
mkdir -p "$parent"
root=$(mktemp -d "$parent/managed-reconciler.XXXXXX")
trap 'rm -rf -- "$root"' EXIT

render="$root/render.yaml"
script="$root/reconcile.sh"
helm template filedeck k8s --set managedNodes.enabled=true >"$render"
awk '/^  reconcile.sh: \|$/ { found=1; next } found && /^    / { sub(/^    /, ""); print; next } found { exit }' "$render" >"$script"
chmod 700 "$script"
test -s "$script"

bin="$root/bin"
mkdir -p "$bin"
cat >"$bin/kubectl" <<'KUBECTL'
#!/usr/bin/env bash
set -euo pipefail
log=${RECONCILER_LOG:?}
state=${RECONCILER_STATE:?}
printf 'kubectl %s\n' "$*" >>"$log"
if [[ $1 == -n ]]; then
  shift 2
fi
if [[ $1 == get && $2 == nodes ]]; then
  printf 'join-linux\n'
elif [[ $1 == get && $2 == pods ]]; then
  printf '10.42.0.77\tReady=True\n'
elif [[ $1 == get && $2 == configmap/filedeck-managed-nodes ]]; then
  cat "$state"
elif [[ $1 == get && $2 == services ]]; then
  :
elif [[ $1 == get && $2 == endpointslices ]]; then
  :
elif [[ $1 == create ]]; then
  value=''
  for arg in "$@"; do
    case "$arg" in --from-literal=NODES=*) value=${arg#--from-literal=NODES=} ;; esac
  done
  cat <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: filedeck-managed-nodes
data:
  NODES: $value
EOF
elif [[ $1 == apply ]]; then
  payload=$(cat)
  printf '%s\n' "$payload" >>"$log"
  if grep -q '^  name: filedeck-managed-nodes$' <<<"$payload"; then
    awk -F': ' '/^  NODES:/{print $2}' <<<"$payload" >"$state"
  fi
elif [[ $1 == patch ]]; then
  printf 'hub patch observed\n' >>"$log"
elif [[ $1 == delete ]]; then
  printf 'delete observed\n' >>"$log"
else
  printf 'unexpected kubectl invocation: %s\n' "$*" >&2
  exit 1
fi
KUBECTL
cat >"$bin/sleep" <<'SLEEP'
#!/usr/bin/env bash
exit 42
SLEEP
chmod 700 "$bin/kubectl" "$bin/sleep"

log="$root/reconcile.log"
state="$root/state"
printf 'local=http://filedeck-agent-local.default:8080' >"$state"
set +e
PATH="$bin:$PATH" NAMESPACE=default NODE_LABEL=dynacom.dev/filedeck-managed NODE_VALUE=true \
  STATIC_NAMES=local STATIC_TARGETS=local=http://filedeck-agent-local.default:8080 PORT=8080 INTERVAL=1 \
  RECONCILER_LOG="$log" RECONCILER_STATE="$state" "$script"
status=$?
set -e
test "$status" -eq 42
grep -q 'join-linux' "$log"
grep -q '10.42.0.77' "$log"
grep -q 'hub patch observed' "$log"
grep -q 'endpointslice' "$log"
patches=$(grep -c 'hub patch observed' "$log")
test "$patches" -eq 1
set +e
PATH="$bin:$PATH" NAMESPACE=default NODE_LABEL=dynacom.dev/filedeck-managed NODE_VALUE=true \
  STATIC_NAMES=local STATIC_TARGETS=local=http://filedeck-agent-local.default:8080 PORT=8080 INTERVAL=1 \
  RECONCILER_LOG="$log" RECONCILER_STATE="$state" "$script"
status=$?
set -e
test "$status" -eq 42
test "$(grep -c 'hub patch observed' "$log")" -eq 1
printf 'managed reconciler fixture passed: offline static render plus later join discovery\n'
