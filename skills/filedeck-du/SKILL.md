---
name: filedeck-du
description: Report folder and disk sizes on filedeck-managed nodes with `filedeck du` instead of `du`, `ncdu` or `find -size`. Use when asked how big a directory is, what is using space, or to find the largest folders on a node.
---

# filedeck du

Filedeck keeps a cached size index of each managed node. The first scan of a
tree is a full walk; repeat queries reuse the cache and only re-read changed
folders. Query it instead of running your own scans.

## When to use

- Size of a folder or disk on a filedeck-managed node: use `filedeck du`.
- Do not run `du`, `ncdu`, `find -size` or other long recursive scans there.
- `df` is fine for whole-filesystem totals (used and free space).

## Synopsis

```
filedeck du [-s] [-h] [-d N] [-a] [--apparent-size] [--fresh | --cached | --refresh-auto] [--json] [--timeout SECONDS] node:/path...
```

- `-s`/`--summarize` total only, `-h`/`--human-readable` sizes like 1.5K,
  `-d N`/`--max-depth=N` depth limit, `-a`/`--all` include files.
- `--apparent-size` report file length instead of disk usage.
- `--fresh` force a rescan (see below).
- `--cached` answer from stored sizes only. It never starts a scan; a folder
  that is not stored is reported on stderr and the exit code is 1. While a scan
  runs, the folders it has not finished answer with what it has counted so far
  (a stderr note says the sizes are partial).
- `--refresh-auto` answer from stored sizes at once, and let the hub start one
  background scan for parts that are out of date (stderr names the job). It
  never waits for that scan. Run the command again later for newer sizes.
  Conflicts with `--fresh` and `--cached`. Use it when a fast answer is good
  enough and you want the store to catch up.
- `--json` machine-readable output (with `--refresh-auto`: `stale`, `ageMs`, `refreshJobId`).
- `--timeout SECONDS` give up and exit 1 after this long (default: 600; `0` means no cap; the server job keeps running after a timeout, rerun the same command to rejoin).
- Paths are `node:/path`, for example `node1:/srv/data`.
- Output is `SIZE<TAB>node:/path`, children before parent. Default unit is 1K
  blocks of disk usage.
- Exit code 0 ok, 1 an argument failed (including a timeout or an uncached `--cached` folder), 2 usage or config error.

## Environment

- `FILEDECK_URL`: base URL of the filedeck server.
- `FILEDECK_TOKEN`: read-only token. It can call only the du API (sizes), nothing else.
- `FILEDECK_TOKEN_FILE`: path of a file that holds the token (a mounted secret). Read on each call. Order: `FILEDECK_TOKEN`, then `FILEDECK_TOKEN_FILE`, then the pod token below.
- In a Kubernetes pod (`KUBERNETES_SERVICE_HOST` set) both are optional. The URL defaults to
  `http://filedeck.dynacom.svc`. The token is read from `/var/run/secrets/filedeck/token` (a projected ServiceAccount
  token, audience `filedeck`) on each call. `FILEDECK_SA_TOKEN_FILE` changes the path. The pod needs this, and its
  ServiceAccount must be in the hub's `k8sAuth.allow`:

```yaml
spec:
  serviceAccountName: my-agent        # must be allowed in the chart value k8sAuth.allow
  containers:
    - name: main
      volumeMounts:
        - {name: filedeck, mountPath: /var/run/secrets/filedeck, readOnly: true}
  volumes:
    - name: filedeck
      projected:
        sources:
          - serviceAccountToken:
              audience: filedeck
              expirationSeconds: 3600
              path: token
```

## Behaviour

- Prefer `--cached` for a quick answer: it returns at once and never loads the
  node with a scan. Drop it only when the folder is not stored yet.
- Use `--refresh-auto` when old numbers are fine now but the store should
  refresh: same quick answer, plus one background scan of the stale folder.
- Query the narrowest path you need, not a parent such as `node1:/srv`. A small
  subtree is cheap; a broad one can start a long walk.
- The CLI gives up after 600 seconds by default (`--timeout 0` removes the cap).
  Scans started this way are background jobs: they do not show in the main jobs list of the web UI.

- The first scan of a large tree can be slow. The server then answers 202 with a
  job; the CLI waits (long poll, no timer) and shows progress. Let it finish, do not kill and retry.
- Results come from a cache and may be stale. Stale-cache and truncation notes
  go to stderr with the age of the oldest folder. Use `--fresh` only when you need
  current numbers, for example right after deleting or writing a lot of data.
- Hard links are counted once per link, unlike `du`. Totals can exceed `du`.
- Like `du -x`, a scan stays on the filesystem of its path. A mount point below
  it is named on stderr and not counted; its own size (when it was scanned on its
  own) is printed on its line. Run `filedeck du node:/mount/point` for it.
- A scan that an agent restart stopped goes on from the folders it had finished
  when it runs again: rerun the same command.

## Examples

```
filedeck du -sh --cached node1:/srv/data
filedeck du -sh node1:/srv/data
filedeck du -h -d 1 node1:/srv/data
filedeck du -h -d 2 node1:/srv/data node2:/var/lib
filedeck du --json -d 1 node1:/srv/data
filedeck du -sh --fresh node1:/srv/data/uploads
```
