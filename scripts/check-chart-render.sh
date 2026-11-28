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

# The holder table (eBPF): nothing of it in a default render; with it on, every agent pod gets the helper, the capabilities, the host pid space and the BTF mount.
off=$(helm template t k8s --set managedNodes.enabled=true --set 'nodes[0].name=a' --set 'nodes[0].nodeName=a')
for name in FILEDECK_HOLDERS hostPID /sys/kernel/btf; do
  case "$off" in *"$name"*) echo "a default render must not mention $name" >&2; exit 1 ;; esac
done
on=$(helm template t k8s --set agent.holders.ebpf=true --set agent.holders.ringMb=32 --set managedNodes.enabled=true --set 'nodes[0].name=a' --set 'nodes[0].nodeName=a')
test "$(printf '%s\n' "$on" | grep -c 'hostPID: true')" = 2 || { echo "the holder table needs hostPID in the agent pods and the managed agent pods" >&2; exit 1; }
test "$(printf '%s\n' "$on" | grep -c 'FILEDECK_HOLDERS_RING_MB')" = 2
test "$(printf '%s\n' "$on" | grep -c '/sys/kernel/btf')" -ge 4
test "$(printf '%s\n' "$on" | grep -c -E '"BPF", "PERFMON"|BPF, PERFMON')" = 2
printf '%s\n' "$on" | grep -A1 'FILEDECK_HOLDERS_RING_MB' | grep -q '"32"' || { echo "the ring size value is not passed" >&2; exit 1; }
