#!/usr/bin/env bash
# Render checks for the agent index volume: the default hostPath is unchanged, and a node can set its own.
set -euo pipefail
cd "$(dirname "$0")/.."

# index_path reads all input: an early awk exit would make helm die of SIGPIPE under pipefail
index_path() { awk '/- name: index$/ {f=1; next} f && /mountPath:/ {f=0} f && /path:/ {if (!done) print $2; done=1}'; }

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

# MCP server: off by default; on, it needs a TLS Secret, has its own port, HTTPS probes, a Service port, grants and a NetworkPolicy
test -z "$(helm template t k8s | grep -E 'FILEDECK_MCP|name: mcp|hub-mcp|mcp-grants' || true)"
mcp=(helm template t k8s --set hub.mcp.enabled=true --set hub.mcp.tls.secretName=mcp-tls
  --set 'hub.mcp.grants[0].id=ops' --set 'hub.mcp.grants[0].tokenSecret.name=mcp-ops' --set 'hub.mcp.grants[0].tokenSecret.key=tok'
  --set 'hub.mcp.grants[0].resources[0]=filedeck://nodes/web1/' --set 'hub.mcp.grants[0].tools[0]=filedeck_du')
refuse() { if "$@" >/dev/null 2>&1; then echo "chart accepted: $*"; exit 1; fi; }
refuse helm template t k8s --set hub.mcp.enabled=true                                                    # no TLS Secret
refuse "${mcp[@]}" --set hub.mcp.port=8080                                                                # the API port
refuse "${mcp[@]}" --set hub.mcp.port=9091                                                                # the metrics port
refuse "${mcp[@]}" --set 'hub.mcp.grants[1].id=ops' --set 'hub.mcp.grants[1].tokenSecret.name=x' \
  --set 'hub.mcp.grants[1].resources[0]=filedeck://' --set 'hub.mcp.grants[1].tools[0]=*'                 # the same id twice
refuse "${mcp[@]}" --set 'hub.mcp.grants[1].id=Bad_Id' --set 'hub.mcp.grants[1].tokenSecret.name=x' \
  --set 'hub.mcp.grants[1].resources[0]=filedeck://' --set 'hub.mcp.grants[1].tools[0]=*'                 # a bad id
refuse "${mcp[@]}" --set 'hub.mcp.grants[1].id=empty' --set 'hub.mcp.grants[1].tokenSecret.name=x'        # no scope
refuse "${mcp[@]}" --set auth.enabled=true --set agentToken.secretName=agent-tok                                                                # sign-in on, no account
"${mcp[@]}" --set auth.enabled=true --set agentToken.secretName=agent-tok --set hub.mcp.account=svc >/dev/null
mcphub=$("${mcp[@]}" -s templates/hub.yaml)
test "$(printf '%s\n' "$mcphub" | awk '/name: FILEDECK_MCP_PORT/{getline; gsub(/"/, "", $2); print $2}')" = 9092
test "$(printf '%s\n' "$mcphub" | awk '/name: FILEDECK_MCP_GRANTS_FILE/{getline; print $2}')" = /etc/filedeck/mcp/grants.json
test "$(printf '%s\n' "$mcphub" | awk '/name: FILEDECK_MCP_TLS_CERT/{getline; print $2}')" = /var/run/filedeck/mcp-tls/tls.crt
test "$(printf '%s\n' "$mcphub" | awk '/name: FILEDECK_MCP_TLS_KEY/{getline; print $2}')" = /var/run/filedeck/mcp-tls/tls.key
! grep -q FILEDECK_MCP_TOKEN <<<"$mcphub"                                                  # no single token any more
grep -q 'httpGet: {path: /mcp/healthz, port: mcp, scheme: HTTPS}' <<<"$mcphub"
grep -q 'httpGet: {path: /mcp/readyz, port: mcp, scheme: HTTPS}' <<<"$mcphub"
printf '%s\n' "$mcphub" | awk '/- name: mcp$/{c++} END {exit !(c >= 2)}' # the container port and the Service port
# the TLS Secret and each grant's token Secret are mounted read only; the token file is the Secret's key as `token`
printf '%s\n' "$mcphub" | awk '/- name: mcp-tls$/{f=1} f && /readOnly: true/{ok=1} END {exit !ok}'
printf '%s\n' "$mcphub" | awk '/- name: mcp-token-ops$/{f=1} f && /mountPath: \/var\/run\/filedeck\/mcp\/ops/{ok=1} END {exit !ok}'
printf '%s\n' "$mcphub" | awk '/- key: tok$/{getline; if ($2 == "token") ok=1} END {exit !ok}'
# the pod has no checksum of the grants: editing the list or a token must not roll the hub
! grep -q 'checksum/mcp' <<<"$mcphub"
grants=$("${mcp[@]}" -s templates/hub-mcp-grants.yaml)
# the grants ConfigMap has its own name, apart from the token Secrets (a Secret named like the release plus -mcp-grants is common)
grep -q 'name: filedeck-mcp-grant-scopes' <<<"$grants"
grep -q 'name: filedeck-mcp-grant-scopes' <<<"$mcphub"
! grep -q 'name: filedeck-mcp-grants$' <<<"$grants$mcphub"
grep -q 'grants.json: "\[{\\"id\\":\\"ops\\"' <<<"$grants"
grep -q 'filedeck://nodes/web1/' <<<"$grants"
grep -q '/var/run/filedeck/mcp/ops/token' <<<"$grants"
# The public route points at the http port only
test -z "$("${mcp[@]}" --set 'route.enabled=true' -s templates/httproute.yaml 2>/dev/null | grep -E 'mcp|9092' || true)"
# The MCP policy is made with hub.networkPolicy.enabled false. It keeps the other hub ports open, and no peer reaches the MCP port by default.
open=$("${mcp[@]}" -s templates/hub-mcp-networkpolicy.yaml)
test "$(printf '%s\n' "$open" | awk '/- port:/{print $3}' | tr '\n' ' ')" = 'http metrics '
printf '%s\n' "$open" | awk '/port: mcp/{found=1} END {exit found}'
peers=$("${mcp[@]}" -s templates/hub-mcp-networkpolicy.yaml --set-string 'hub.mcp.allowFrom[0].podSelector.matchLabels.role=client')
test "$(printf '%s\n' "$peers" | awk '/- port:/{print $3}' | tr '\n' ' ')" = 'http metrics mcp '
printf '%s\n' "$peers" | awk '/role: client/{found=1} END {exit !found}'
# With the hub policy on, the MCP policy must not widen it: only the MCP port, only the listed peers
both=$("${mcp[@]}" -s templates/hub-mcp-networkpolicy.yaml --set hub.networkPolicy.enabled=true --set-string 'hub.mcp.allowFrom[0].podSelector.matchLabels.role=client')
test "$(printf '%s\n' "$both" | awk '/- port:/{print $3}' | tr '\n' ' ')" = 'mcp '
test -z "$(helm template t k8s -s templates/hub-mcp-networkpolicy.yaml 2>/dev/null || true)" || { echo "MCP policy rendered while MCP is off"; exit 1; }
# the session limit of one grant is always set; the allowed hosts only when listed (empty = any host), and they are not hub.allowedHosts
test "$(printf '%s\n' "$mcphub" | awk '/name: FILEDECK_MCP_SESSIONS_PER_GRANT/{getline; gsub(/"/, "", $2); print $2}')" = 32
! grep -q FILEDECK_MCP_ALLOWED_HOSTS <<<"$mcphub"
! grep -q FILEDECK_MCP_ALLOWED_HOSTS <<<"$("${mcp[@]}" -s templates/hub.yaml --set 'hub.allowedHosts[0]=files.example.org')"
hosts=$("${mcp[@]}" -s templates/hub.yaml --set 'hub.mcp.allowedHosts[0]=filedeck-hub.apps.svc:9092' --set 'hub.mcp.allowedHosts[1]=filedeck-hub.apps.svc')
test "$(printf '%s\n' "$hosts" | awk '/name: FILEDECK_MCP_ALLOWED_HOSTS/{getline; gsub(/"/, "", $2); print $2}')" = 'filedeck-hub.apps.svc:9092,filedeck-hub.apps.svc'
# With the Tailscale sidecar on and no other hub policy, the MCP policy isolates the pod, so it must allow the UDP port of tailscaled
sidecar=("${mcp[@]}" --set auth.enabled=true --set agentToken.secretName=agent-tok --set hub.mcp.account=svc --set hub.trustedProxies=1
  --set auth.tailscale.sidecar.enabled=true --set auth.tailscale.sidecar.authKey.secretName=ts-key --set auth.tailscale.sidecar.image.repository=ts --set auth.tailscale.sidecar.image.tag=v1)
udp=$("${sidecar[@]}" -s templates/hub-mcp-networkpolicy.yaml)
printf '%s\n' "$udp" | awk '/- port: 41641/{getline; if ($2 == "UDP") ok=1} END {exit !ok}'
! grep -q 'protocol: UDP' <<<"$open"                                                          # no sidecar, no UDP rule
! grep -q 'protocol: UDP' <<<"$("${sidecar[@]}" -s templates/hub-mcp-networkpolicy.yaml --set hub.networkPolicy.enabled=true)"
grep -A1 'name: TS_TAILSCALED_EXTRA_ARGS' <<<"$("${sidecar[@]}" -s templates/hub.yaml)" | grep -q -- '--port=41641'
# the UDP port must be a real port: the chart refuses to render with 0, 70000 or a word
for bad in 0 70000 -5; do
  if "${sidecar[@]}" --set "auth.tailscale.sidecar.udpPort=$bad" >/dev/null 2>&1; then echo "udpPort $bad must not render" >&2; exit 1; fi
done
"${sidecar[@]}" --set auth.tailscale.sidecar.udpPort=65535 >/dev/null

echo "chart render check passed"
