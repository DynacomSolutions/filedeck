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
  cat "${RECONCILER_NODES:?}"
elif [[ $1 == get && $2 == --raw ]]; then
  # a watch: the objects now as ADDED, a bookmark, then a line for each change of the stream file until the caller goes away
  case "$3" in
    /api/v1/nodes\?*watch=1*allowWatchBookmarks=true*labelSelector=dynacom.dev%2Ffiledeck-managed%3Dtrue) kind=nodes ;;
    /api/v1/namespaces/default/pods\?*watch=1*allowWatchBookmarks=true*labelSelector=app.kubernetes.io%2Fname%3Dfiledeck%2Capp.kubernetes.io%2Finstance%3Dfiledeck%2Cdynacom.dev%2Ffiledeck-managed-agent%3Dtrue) kind=pods ;;
    *) printf 'unexpected watch: %s\n' "$3" >&2; exit 1 ;;
  esac
  [[ ${FAIL_WATCH:-0} == 1 ]] && exit 29
  stream="${RECONCILER_STREAMS:?}/$kind"
  printf '{"type":"ADDED","object":{"kind":"%s"}}\n' "$kind"
  printf '{"type":"BOOKMARK","object":{"kind":"%s"}}\n' "$kind"
  seen=$(cat "$stream" 2>/dev/null || true)
  while :; do
    now=$(cat "$stream" 2>/dev/null || true)
    if [[ $now != "$seen" ]]; then
      seen=$now
      printf '{"type":"MODIFIED","object":{"kind":"%s"}}\n' "$kind"
    fi
    sleep 0.05
  done
elif [[ $1 == get && $2 == pods ]]; then
  [[ ${FAIL_PODS:-0} == 1 ]] && exit 19
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
  printf 'owned-stale-service\n'
elif [[ $1 == get && $2 == endpointslices ]]; then
  [[ $* == *app.kubernetes.io/instance=filedeck* ]] || exit 18
  printf 'owned-stale-slice\n'
elif [[ $1 == get && $2 == endpointslice && $3 == owned-stale-slice ]]; then
  printf 'owned-stale-service\n'
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
    patch_payload="${!#}"
    value=$(printf '%s' "$patch_payload" | sed -n 's/.*"NODES":"\([^"]*\)".*/\1/p')
    test -n "$value"
    printf '%s' "$value" >"$state"
  else
    [[ ${FAIL_PATCH:-0} == 1 ]] && exit 23
    value=$(printf '%s' "${!#}" | sed -n 's/.*nodes-hash":"\([0-9a-f]*\)".*/\1/p')
    test -n "$value"
    printf '%s' "$value" >"$hub_state"
    printf 'hub patch observed\n' >>"$log"
  fi
elif [[ $1 == apply ]]; then
  cat >>"$log"
elif [[ $1 == delete ]]; then
  printf 'delete %s observed\n' "$3" >>"$log"
  case "$3" in
    owned-stale-service) : >"${OWNED_SERVICE_FILE:?}"; rm -f "${OWNED_SERVICE_FILE:?}" ;;
    owned-stale-slice) : >"${OWNED_SLICE_FILE:?}"; rm -f "${OWNED_SLICE_FILE:?}" ;;
  esac
else
  printf 'unexpected kubectl invocation: %s\n' "$*" >&2
  exit 1
fi
KUBECTL
chmod 700 "$bin/kubectl"

log="$root/reconcile.log"
state="$root/state"
hub_state="$root/hub-state"
nodes="$root/nodes"
streams="$root/streams"
foreign_service="$root/foreign-service"
foreign_slice="$root/foreign-endpoint"
owned_service="$root/owned-stale-service"
owned_slice="$root/owned-stale-slice"
mkdir -p "$streams"
printf 'local=http://filedeck-agent-local.default:8080' >"$state"
: >"$hub_state"
: >"$nodes"
printf 'foreign-service' >"$foreign_service"
printf 'foreign-endpoint' >"$foreign_slice"
printf 'owned-service' >"$owned_service"
printf 'owned-endpoint' >"$owned_slice"
printf 'foreign-service and foreign-endpoint exist outside this release\n' >"$log"
static=local=http://filedeck-agent-local.default:8080
joined="$static,join-linux=http://filedeck-managed-agent-$(printf '%s' join-linux | sha256sum | cut -c1-12):8080"

pid=''
run=0
# Start the reconciler in its own process group, as a container would run it. $@ are extra environment settings.
start() {
  run=$((run + 1))
  hb="$root/hb$run"
  mkdir -p "$hb"
  env PATH="$bin:$PATH" NAMESPACE=default APP_NAME=filedeck RELEASE_NAME=filedeck CONFIGMAP_NAME=filedeck-managed-nodes HUB_NAME=filedeck-hub HEARTBEAT="$hb/heartbeat" \
    NODE_LABEL=dynacom.dev/filedeck-managed NODE_VALUE=true STATIC_NAMES=local STATIC_TARGETS="$static" PORT=8080 WATCH_SECONDS=300 \
    RECONCILER_LOG="$log" RECONCILER_STATE="$state" RECONCILER_HUB_STATE="$hub_state" RECONCILER_NODES="$nodes" RECONCILER_STREAMS="$streams" \
    OWNED_SERVICE_FILE="$owned_service" OWNED_SLICE_FILE="$owned_slice" "$@" setsid "$script" &
  pid=$!
}
stop() {
  # (the group leader is setsid's child: its group id is its pid)
  kill -TERM -- "-$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}
# wait up to 10 s for a command to succeed
until_ok() {
  for _ in $(seq 1 200); do
    if "$@"; then return 0; fi
    sleep 0.05
  done
  echo "timed out waiting for: $*" >&2
  return 1
}
state_is() { [[ "$(cat "$state")" == "$1" ]]; }
pass_done() { [[ -e "$hb/heartbeat" ]]; }
exited() { ! kill -0 "$pid" 2>/dev/null; }
poke() { date +%s%N >"$streams/$1"; }
trap 'stop; rm -rf -- "$root"' EXIT

# 1. no node carries the label: the first pass leaves the static list, and the watch keeps the process alive with no loop
start
until_ok pass_done
state_is "$static"
test "$(grep -c 'hub patch observed' "$log")" -eq 1 # (the hub carries no node hash yet)
kill -0 "$pid"

# 2. a node gets the label: the node watch event updates the ConfigMap within 5 s, and no more than that
printf 'join-linux\n' >"$nodes"
began=$(date +%s)
poke nodes
until_ok state_is "$joined"
test $(($(date +%s) - began)) -le 5
until_ok test "$(grep -c 'hub patch observed' "$log")" -eq 2
grep -q 'join-linux' "$log"
grep -q '10.42.0.77' "$log"
grep -q 'endpointslice' "$log"
grep -q 'app.kubernetes.io/name=filedeck,app.kubernetes.io/instance=filedeck' "$log"
grep -q 'foreign-service and foreign-endpoint exist' "$log"
if grep -q 'delete.*foreign' "$log"; then
  echo 'foreign resource was deleted' >&2
  exit 1
fi
test -s "$foreign_service"
test -s "$foreign_slice"
until_ok test ! -e "$owned_service"
until_ok test ! -e "$owned_slice"
test "$(grep -c 'hub patch observed' "$log")" -eq 2
# a burst of events and a pod event settle on the same state, with no second hub patch
poke nodes
poke pods
sleep 0.5
test "$(grep -c 'hub patch observed' "$log")" -eq 2

# 3. the label goes away: the watch event takes the node out again within 5 s
: >"$nodes"
began=$(date +%s)
poke nodes
until_ok state_is "$static"
test $(($(date +%s) - began)) -le 5

# 4. every watch line writes its heartbeat (a bookmark counts), so a stuck watch is the one that goes stale
before=$(cat "$hb/heartbeat.nodes")
test -n "$before"
test -s "$hb/heartbeat.pods"
stop

# 5. a watch that fails writes no heartbeat (it is retried after a pause), so the liveness probe sees it
start FAIL_WATCH=1
until_ok pass_done
sleep 1.2
first=$(cat "$hb/heartbeat.nodes")
sleep 2.2
test "$(cat "$hb/heartbeat.nodes")" = "$first"
kill -0 "$pid"
stop

# 6. a node is left over from before: a pod list failure ends the process with that status, and nothing is cleaned up
printf 'join-linux\n' >"$nodes"
printf '%s' "$joined" >"$state"
: >"$log"
start FAIL_PODS=1
until_ok exited
set +e
wait "$pid"
status=$?
set -e
kill -TERM -- "-$pid" 2>/dev/null || true # (the watches of the process that ended)
test "$status" -eq 19
state_is "$joined"
if grep -q 'delete' "$log"; then
  echo 'Pod-list failure caused cleanup' >&2
  exit 1
fi

# 7. a pod that is Running but not Ready is not accepted
: >"$log"
start POD_READY=0
until_ok pass_done
until_ok state_is "$static"
if grep -q '10.42.0.77' "$log"; then
  echo 'Ready=False with ContainersReady=True was accepted' >&2
  exit 1
fi
stop
start
until_ok state_is "$joined"
until_ok pass_done
test "$(grep -c 'hub patch observed' "$log")" -eq 2
stop

# 8. a failed hub patch ends the process, and the next start patches again
printf '%s' "$static" >"$state"
: >"$hub_state"
: >"$log"
start FAIL_PATCH=1
until_ok exited
set +e
wait "$pid"
status=$?
set -e
kill -TERM -- "-$pid" 2>/dev/null || true # (the watches of the process that ended)
test "$status" -eq 23
test "$(cat "$state")" != "$static"
start
until_ok pass_done
until_ok grep -q 'hub patch observed' "$log"
test "$(grep -c 'hub patch observed' "$log")" -eq 1
stop

# 9. a node list failure ends the process with that status
start FAIL_NODES=1
until_ok exited
set +e
wait "$pid"
status=$?
set -e
kill -TERM -- "-$pid" 2>/dev/null || true # (the watches of the process that ended)
test "$status" -eq 17
state_is "$joined"
printf 'managed reconciler fixture passed: offline static render, node and pod watches, label change within 5 s, heartbeat per watch line\n'
