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
hub_state=${RECONCILER_HUB_STATE:?}
printf 'kubectl %s\n' "$*" >>"$log"
if [[ $1 == -n ]]; then
  shift 2
fi
if [[ $1 == get && $2 == nodes ]]; then
  [[ ${FAIL_NODES:-0} == 1 ]] && exit 17
  printf 'join-linux\n'
elif [[ $1 == get && $2 == pods ]]; then
  [[ $* == *app.kubernetes.io/instance=filedeck* ]] || exit 18
  if [[ ${POD_READY:-1} == 1 ]]; then
    printf 'join-linux\tRunning\t10.42.0.77\tPodScheduled=True Ready=True ContainersReady=False\n'
  else
    printf 'join-linux\tRunning\t10.42.0.77\tPodScheduled=True Ready=False ContainersReady=True\n'
  fi
elif [[ $1 == get && $2 == configmap/filedeck-managed-nodes ]]; then
  cat "$state"
elif [[ $1 == get && $2 == services ]]; then
  [[ $* == *app.kubernetes.io/instance=filedeck* ]] || exit 18
  :
elif [[ $1 == get && $2 == endpointslices ]]; then
  [[ $* == *app.kubernetes.io/instance=filedeck* ]] || exit 18
  :
elif [[ $1 == get && $2 == deployment/filedeck-hub ]]; then
  cat "$hub_state"
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
elif [[ $1 == patch ]]; then
  if [[ $2 == configmap ]]; then
    node_id=$(printf '%s' join-linux | sha256sum | cut -c1-12)
    printf '%s' "local=http://filedeck-agent-local.default:8080,join-linux=http://filedeck-managed-agent-$node_id:8080" >"$state"
  else
    [[ ${FAIL_PATCH:-0} == 1 ]] && exit 23
    node_id=$(printf '%s' join-linux | sha256sum | cut -c1-12)
    value=$(printf '%s' "local=http://filedeck-agent-local.default:8080,join-linux=http://filedeck-managed-agent-$node_id:8080" | sha256sum | cut -d' ' -f1)
    printf '%s' "$value" >"$hub_state"
    printf 'hub patch observed\n' >>"$log"
  fi
elif [[ $1 == apply ]]; then
  cat >>"$log"
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
hub_state="$root/hub-state"
heartbeat="$root/heartbeat"
printf 'local=http://filedeck-agent-local.default:8080' >"$state"
: >"$hub_state"
printf 'foreign-service and foreign-endpoint exist outside this release\n' >"$log"
set +e
PATH="$bin:$PATH" NAMESPACE=default RELEASE_NAME=filedeck CONFIGMAP_NAME=filedeck-managed-nodes HUB_NAME=filedeck-hub HEARTBEAT="$heartbeat" NODE_LABEL=dynacom.dev/filedeck-managed NODE_VALUE=true \
  STATIC_NAMES=local STATIC_TARGETS=local=http://filedeck-agent-local.default:8080 PORT=8080 INTERVAL=1 \
  RECONCILER_LOG="$log" RECONCILER_STATE="$state" RECONCILER_HUB_STATE="$hub_state" "$script"
status=$?
set -e
test "$status" -eq 42
grep -q 'join-linux' "$log"
grep -q '10.42.0.77' "$log"
grep -q 'hub patch observed' "$log"
grep -q 'endpointslice' "$log"
grep -q 'app.kubernetes.io/name=filedeck,app.kubernetes.io/instance=filedeck' "$log"
grep -q 'foreign-service and foreign-endpoint exist' "$log"
! grep -q 'delete.*foreign' "$log"
patches=$(grep -c 'hub patch observed' "$log")
test "$patches" -eq 1
: >"$log"
set +e
PATH="$bin:$PATH" NAMESPACE=default RELEASE_NAME=filedeck CONFIGMAP_NAME=filedeck-managed-nodes HUB_NAME=filedeck-hub HEARTBEAT="$heartbeat" NODE_LABEL=dynacom.dev/filedeck-managed NODE_VALUE=true \
  STATIC_NAMES=local STATIC_TARGETS=local=http://filedeck-agent-local.default:8080 PORT=8080 INTERVAL=1 POD_READY=0 \
  RECONCILER_LOG="$log" RECONCILER_STATE="$state" RECONCILER_HUB_STATE="$hub_state" "$script"
status=$?
set -e
test "$status" -eq 42
! grep -q '10.42.0.77' "$log"
set +e
PATH="$bin:$PATH" NAMESPACE=default RELEASE_NAME=filedeck CONFIGMAP_NAME=filedeck-managed-nodes HUB_NAME=filedeck-hub HEARTBEAT="$heartbeat" NODE_LABEL=dynacom.dev/filedeck-managed NODE_VALUE=true \
  STATIC_NAMES=local STATIC_TARGETS=local=http://filedeck-agent-local.default:8080 PORT=8080 INTERVAL=1 \
  RECONCILER_LOG="$log" RECONCILER_STATE="$state" RECONCILER_HUB_STATE="$hub_state" "$script"
status=$?
set -e
test "$status" -eq 42
test "$(grep -c 'hub patch observed' "$log")" -eq 1
printf 'local=http://filedeck-agent-local.default:8080' >"$state"
: >"$hub_state"
: >"$log"
set +e
PATH="$bin:$PATH" NAMESPACE=default RELEASE_NAME=filedeck CONFIGMAP_NAME=filedeck-managed-nodes HUB_NAME=filedeck-hub HEARTBEAT="$heartbeat" NODE_LABEL=dynacom.dev/filedeck-managed NODE_VALUE=true \
  STATIC_NAMES=local STATIC_TARGETS=local=http://filedeck-agent-local.default:8080 PORT=8080 INTERVAL=1 \
  FAIL_PATCH=1 RECONCILER_LOG="$log" RECONCILER_STATE="$state" RECONCILER_HUB_STATE="$hub_state" "$script"
status=$?
set -e
test "$status" -eq 23
test "$(cat "$state")" != "local=http://filedeck-agent-local.default:8080"
set +e
PATH="$bin:$PATH" NAMESPACE=default RELEASE_NAME=filedeck CONFIGMAP_NAME=filedeck-managed-nodes HUB_NAME=filedeck-hub HEARTBEAT="$heartbeat" NODE_LABEL=dynacom.dev/filedeck-managed NODE_VALUE=true \
  STATIC_NAMES=local STATIC_TARGETS=local=http://filedeck-agent-local.default:8080 PORT=8080 INTERVAL=1 \
  RECONCILER_LOG="$log" RECONCILER_STATE="$state" RECONCILER_HUB_STATE="$hub_state" "$script"
status=$?
set -e
test "$status" -eq 42
test "$(grep -c 'hub patch observed' "$log")" -eq 1
set +e
PATH="$bin:$PATH" NAMESPACE=default RELEASE_NAME=filedeck CONFIGMAP_NAME=filedeck-managed-nodes HUB_NAME=filedeck-hub HEARTBEAT="$heartbeat" NODE_LABEL=dynacom.dev/filedeck-managed NODE_VALUE=true \
  STATIC_NAMES=local STATIC_TARGETS=local=http://filedeck-agent-local.default:8080 PORT=8080 INTERVAL=1 \
  FAIL_NODES=1 RECONCILER_LOG="$log" RECONCILER_STATE="$state" RECONCILER_HUB_STATE="$hub_state" "$script"
status=$?
set -e
test "$status" -eq 17
test "$(cat "$state")" = "local=http://filedeck-agent-local.default:8080,join-linux=http://filedeck-managed-agent-$(printf '%s' join-linux | sha256sum | cut -c1-12):8080"
printf 'managed reconciler fixture passed: offline static render plus later join discovery\n'
