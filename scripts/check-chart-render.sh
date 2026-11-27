#!/usr/bin/env bash
# Render checks for the agent index volume: the default hostPath is unchanged, and a node can set its own.
set -euo pipefail
cd "$(dirname "$0")/.."

index_path() { awk '/- name: index$/ {f=1; next} f && /mountPath:/ {f=0} f && /path:/ {print $2; exit}'; }

default=$(helm template t k8s | index_path)
test "$default" = "/var/lib/filedeck" || { echo "default index hostPath is $default"; exit 1; }

node=$(helm template t k8s --set 'nodes[0].name=a' --set 'nodes[0].indexHostPath=/home/filedeck' | index_path)
test "$node" = "/home/filedeck" || { echo "node index hostPath is $node"; exit 1; }

chart=$(helm template t k8s --set agent.indexHostPath=/data/fd | index_path)
test "$chart" = "/data/fd" || { echo "chart-wide index hostPath is $chart"; exit 1; }

policy=(helm template t k8s -s templates/hub-networkpolicy.yaml --set hub.networkPolicy.enabled=true)
closed=$("${policy[@]}")
test "$(printf '%s\n' "$closed" | awk '/ingress:/{if (NF == 1) {getline; print $1} else print $2}')" = '[]'
scraped=$("${policy[@]}" --set-string metrics.scrapeFrom.namespaceSelector.matchLabels.role=collector)
test "$(printf '%s\n' "$scraped" | awk '/- port:/{print $3}')" = metrics
printf '%s\n' "$scraped" | awk '/role: collector/{found=1} END {exit !found}'
both=$("${policy[@]}" --set-string metrics.scrapeFrom.namespaceSelector.matchLabels.role=collector \
  --set-string 'hub.networkPolicy.from[0].podSelector.matchLabels.role=proxy')
test "$(printf '%s\n' "$both" | awk '/- from:/{n++} END {print n+0}')" = 2

test "$(printf '%s\n' "$both" | awk '
  /- from:/ { peer="" }
  /role: collector/ { peer="collector" }
  /role: proxy/ { peer="proxy" }
  /- port:/ { print peer, $3 }
')" = $'proxy http\ncollector metrics'

hub=$(helm template t k8s -s templates/hub.yaml --set 'groups.local[0].name=Data' --set 'groups.local[0].paths[0]=/data')
test "$(printf '%s\n' "$hub" | awk '/name: FILEDECK_GROUPS_FILE/{getline; print $2}')" = /etc/filedeck/groups/rules.json
printf '%s\n' "$hub" | awk '/checksum\/storage-groups:/{checksum=1} /mountPath: \/etc\/filedeck\/groups/{mount=1} END {exit !(checksum && mount)}'

managed=$(helm template t k8s --set managedNodes.enabled=true)
case "$managed" in *$'kind: DaemonSet\n'*) ;; *) echo "managed chart must render the agent DaemonSet" >&2; exit 1 ;; esac
case "$managed" in *"name: filedeck-managed-reconciler"*) ;; *) echo "managed chart must render the reconciler" >&2; exit 1 ;; esac
if awk '/^kind: EndpointSlice$/{found=1} END{exit !found}' <<<"$managed"; then
  echo "offline chart must not render joined-node endpoints" >&2
  exit 1
fi
! grep -R -q 'lookup "v1" "Node"' k8s/templates || { echo "chart must not depend on Helm Node lookup" >&2; exit 1; }
scripts/test-managed-reconciler.sh
auth_managed=$(helm template t k8s --set managedNodes.enabled=true --set auth.enabled=true --set agentToken.secretName=filedeck-agent-token)
case "$auth_managed" in *"kind: ClusterRoleBinding"*) ;; *) exit 1 ;; esac
case "$auth_managed" in *"name: FILEDECK_AUTH"*) ;; *) exit 1 ;; esac
case "$auth_managed" in *"name: FILEDECK_PAM_SERVICE"*) ;; *) exit 1 ;; esac
case "$auth_managed" in *"SYS_CHROOT"*) ;; *) exit 1 ;; esac
case "$auth_managed" in *'dynacom.dev/filedeck-managed-agent: "true"'*) ;; *) exit 1 ;; esac
witness=$(helm template witness k8s --set fullnameOverride=custom --set managedNodes.enabled=true)
case "$witness" in *'app.kubernetes.io/name: custom'*'app.kubernetes.io/instance: witness'*) ;; *) echo "chart name and release instance labels differ incorrectly" >&2; exit 1 ;; esac
printf '%s\n' "$witness" | python3 -c '
import sys, yaml
docs = list(yaml.safe_load_all(sys.stdin))
reconciler = next(d for d in docs if d and d.get("kind") == "Deployment" and d["metadata"]["name"] == "custom-managed-reconciler")
container = reconciler["spec"]["template"]["spec"]["containers"][0]
assert {m["name"] for m in container["volumeMounts"]} == {"script", "heartbeat"}
assert container["securityContext"]["runAsNonRoot"] is True
assert {v["name"] for v in reconciler["spec"]["template"]["spec"]["volumes"]} == {"script", "heartbeat"}
agent = next(d for d in docs if d and d.get("kind") == "DaemonSet" and d["metadata"]["name"] == "custom-managed-agent")
assert "startupProbe" in agent["spec"]["template"]["spec"]["containers"][0]
print("parsed startup and volume mounts: OK")
'

test "$(printf '%s\n' "$hub" | awk '/name: FILEDECK_HUB_METRICS_PORT/{getline; gsub(/"/, "", $2); print $2}')" = 9091
test "$(printf '%s\n' "$hub" | awk '/- name: metrics/{getline; print $2}')" = 9091
if helm template t k8s -s templates/hub.yaml --set port=9091 >/dev/null 2>&1; then
  echo "hub chart accepted identical API and metrics ports"
  exit 1
fi

echo "chart render check passed"

# Disk pressure (docs/disk-pressure.md): off by default. When on, the settings reach the agent; the host cgroup tree and the host process list are opt-in.
off=$(helm template t k8s --set 'nodes[0].name=a')
case "$off" in *FILEDECK_PRESSURE*|*host-cgroup*|*hostPID*|*SYS_PTRACE*) echo "disk pressure must render nothing by default" >&2; exit 1 ;; esac
on=$(helm template t k8s --set 'nodes[0].name=a' --set agent.pressure.enabled=true)
case "$on" in *"name: FILEDECK_PRESSURE"*) ;; *) echo "agent.pressure.enabled must set FILEDECK_PRESSURE" >&2; exit 1 ;; esac
case "$on" in *host-cgroup*|*hostPID*|*SYS_PTRACE*) echo "agent.pressure.enabled alone must not mount the cgroup tree or share the process list" >&2; exit 1 ;; esac
full=$(helm template t k8s --set 'nodes[0].name=a' --set agent.pressure.enabled=true --set agent.pressure.cgroupMount=true --set agent.pressure.hostPID=true)
for want in "mountPath: /host-cgroup" "path: /sys/fs/cgroup" "value: /host-cgroup" "hostPID: true" '"SYS_PTRACE"'; do
  case "$full" in *"$want"*) ;; *) echo "pressure render lacks: $want" >&2; exit 1 ;; esac
done
# the host cgroup tree is read only
printf '%s\n' "$full" | awk '/name: host-cgroup$/ {f=1; next} f && /readOnly: true/ {ok=1} f && /^      volumes:/ {f=0} END {exit !ok}'
# liveness stays on the real listener
test "$(printf '%s\n' "$full" | awk '/name: agent$/ {a=1} a && !d && /livenessProbe:/ {getline; print $0; d=1}' | grep -c 'path: /healthz')" = 1
managedp=$(helm template t k8s --set managedNodes.enabled=true --set agent.pressure.enabled=true --set agent.pressure.cgroupMount=true --set agent.pressure.hostPID=true)
for want in "hostPID: true" "mountPath: /host-cgroup" "FILEDECK_PRESSURE_CGROUP_ROOT" "SYS_PTRACE"; do
  case "$managedp" in *"$want"*) ;; *) echo "managed pressure render lacks: $want" >&2; exit 1 ;; esac
done
