#!/usr/bin/env python3
"""Keep the published chart's built-in configuration suitable for a generic install."""
from pathlib import Path
import sys

values = Path("k8s/values.yaml").read_text()
helpers = Path("k8s/templates/_helpers.tpl").read_text()
hub = Path("k8s/templates/hub.yaml").read_text()
sidecar = hub.split("- name: tailscaled", 1)[-1]
scratch = values.split("testSources:", 1)[1].split("\nbrand:", 1)[0]
checks = {
    "storage group rules are empty by default": "groups: {}" in values,
    "the VictoriaMetrics URL is empty by default": '  victoriaMetricsUrl: ""' in values,
    "network sources are disabled by default": "sources: []" in values,
    "scratch services are disabled by default": "  enabled: false" in scratch,
    "scratch pod chart label is empty by default": '  podChartLabel: ""' in scratch,
    "no private stylesheet is embedded in the chart": '  cssContent: ""' in values,
    "no deployment-specific sealed data is embedded": "  sealed: {}" in values,
    "the fanotify watcher (extra capability) is off by default": "  fanotify:\n    enabled: false" in values,
    "the du API token is off by default": "apiToken:\n  secretName: \"\"" in values,
    "the API token reads folder sizes only by default": '  scopes: ["du"]' in values,
    "pod storage gauges (agent API token) are off by default": "  podStorage:\n    enabled: false" in values,
    "size gauges list no path by default": "  sizeGauges: []" in values,
    "the node-local event socket is off by default": "    socket:\n      enabled: false" in values,
    "the tailscale sidecar is off by default": "    sidecar:\n      enabled: false" in values,
    "tailscale headers are off by default": "    headers: false" in values,
    "the sidecar refuses to render without hub.trustedProxies": "lt (int .Values.hub.trustedProxies) 1" in helpers,
    "the sidecar does not run as the hub's user": "runAsUser: 1001" in sidecar and "runAsUser: 1000" not in sidecar,
    "the sidecar sets the identity listener and Serve points at it": "127.0.0.2" in helpers and "FILEDECK_TAILSCALE_LISTEN" in hub,
    "the default node does not bind to a machine name": '    nodeName: ""' in values,
}
failed = [name for name, ok in checks.items() if not ok]
if failed:
    print("chart defaults check failed: " + "; ".join(failed))
    sys.exit(1)
print(f"chart defaults check passed: {len(checks)} generic-install safeguards")
