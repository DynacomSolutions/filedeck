#!/usr/bin/env python3
"""Keep the published chart's built-in configuration suitable for a generic install."""
from pathlib import Path
import sys

values = Path("k8s/values.yaml").read_text()
scratch = values.split("testSources:", 1)[1].split("\nbrand:", 1)[0]
checks = {
    "network sources are disabled by default": "sources: []" in values,
    "scratch services are disabled by default": "  enabled: false" in scratch,
    "no private stylesheet is embedded in the chart": '  cssContent: ""' in values,
    "no deployment-specific sealed data is embedded": "  sealed: {}" in values,
    "the default node does not bind to a machine name": '    nodeName: ""' in values,
}
failed = [name for name, ok in checks.items() if not ok]
if failed:
    print("chart defaults check failed: " + "; ".join(failed))
    sys.exit(1)
print(f"chart defaults check passed: {len(checks)} generic-install safeguards")
