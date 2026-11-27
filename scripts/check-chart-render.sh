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

test "$(printf '%s\n' "$hub" | awk '/name: FILEDECK_HUB_METRICS_PORT/{getline; gsub(/"/, "", $2); print $2}')" = 9091
test "$(printf '%s\n' "$hub" | awk '/- name: metrics/{getline; print $2}')" = 9091
if helm template t k8s -s templates/hub.yaml --set port=9091 >/dev/null 2>&1; then
  echo "hub chart accepted identical API and metrics ports"
  exit 1
fi

echo "chart render check passed"
