# Grouped storage

The hub and `filedeck groups` show allocated bytes from completed size-store rows. They do not start a scan.

## Configure groups

Set `groups` in the Helm values. Use each agent's Filedeck name as the key. The chart mounts the rules as a ConfigMap on the agents.

```yaml
groups:
  workstation:
    - name: Build data
      paths: [/data/builds]
      exclude: [/data/builds/tmp]
      labels:
        container: builder
    - name: Build cache
      paths: [/data/builds/cache]
```

Use absolute folder paths relative to the agent root. The longest prefix takes precedence. An exclusion removes its subtree unless a more specific rule includes it. Without Helm, set `FILEDECK_GROUPS_FILE` on the agent to a JSON file with the same structure.

A group's oldest contributing scan sets its date. A missing cached boundary can leave a known parent total unattributed until the next completed scan. A stale flag means the size store cannot confirm the total, or the scan reported errors. The chart includes unattributed filesystem usage and reports measured overage separately. Hard links count once per directory entry. The view flags heavily linked groups and keeps older link counts unknown until the scanner measures them.

Filedeck counts each filesystem's capacity once. A bind mount's path maps back to its visible source where possible. When Linux reports several physical drives for one device, the view shows them together.

## Read storage totals

Use `GET /api/groups` on the hub. Add `?node=workstation` to request one node. When sign-in is on, machine-wide totals require an administrator account.

Enable the `groups` token scope to allow the CLI to read sizes. Configure `FILEDECK_URL` and `FILEDECK_TOKEN` as for `filedeck du`. Add `--json` for machine-readable output.

```sh
filedeck groups
filedeck groups --json workstation
```

## Enable IO pressure

Set `hub.victoriaMetricsUrl`, or set `FILEDECK_VICTORIA_METRICS_URL` on the hub. Leave it empty to disable the join. Without Helm, set `FILEDECK_GROUPS_FILE` on the hub to the same rules file as the agents.

The hub requests one hour of samples, with one sample per minute. It limits each reply to 8 MiB and keeps the last samples when a reply exceeds the limit. It refreshes the samples at most once per minute. Drive values use disk series. Groups use container filesystem series with exact label matches on the same node and device. Busy time for a set of devices is the highest member value at each sample. Resting is the median of the lowest quarter of samples. Missing series stay unavailable. Container throughput and utilisation need separate series. The CLI token receives storage totals only.

Scrape `/metrics` on the named `http` port of agent pods and the named `metrics` port of hub pods.
Set `hub.metricsPort` to change the hub port from 9091.
When the hub NetworkPolicy is on, `metrics.scrapeFrom` grants access to the metrics port only.
Without Helm, set `FILEDECK_HUB_METRICS_PORT` to use a separate port. Leave it unset to serve metrics on the hub HTTP port.
Agent metrics cover grouped storage reads. Hub metrics cover IO queries. Both include errors and the time of the last successful collection.
