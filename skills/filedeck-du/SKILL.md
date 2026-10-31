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
filedeck du [-s] [-h] [-d N] [-a] [--apparent-size] [--fresh | --cached] [--json] [--timeout SECONDS] node:/path...
```

- `-s`/`--summarize` total only, `-h`/`--human-readable` sizes like 1.5K,
  `-d N`/`--max-depth=N` depth limit, `-a`/`--all` include files.
- `--apparent-size` report file length instead of disk usage.
- `--fresh` force a rescan (see below).
- `--cached` answer from stored sizes only. It never starts a scan; a folder
  that is not stored is reported on stderr and the exit code is 1.
- `--json` machine-readable output.
- `--timeout SECONDS` give up and exit 1 after this long (default: 600; `0` means no cap; the server job keeps running after a timeout, rerun the same command to rejoin).
- Paths are `node:/path`, for example `node1:/srv/data`.
- Output is `SIZE<TAB>node:/path`, children before parent. Default unit is 1K
  blocks of disk usage.
- Exit code 0 ok, 1 an argument failed (including a timeout or an uncached `--cached` folder), 2 usage or config error.

## Environment

- `FILEDECK_URL`: base URL of the filedeck server.
- `FILEDECK_TOKEN`: read-only token. It can call only the du API (sizes), nothing else.

## Behaviour

- Prefer `--cached` for a quick answer: it returns at once and never loads the
  node with a scan. Drop it only when the folder is not stored yet.
- Query the narrowest path you need, not a parent such as `node1:/srv`. A small
  subtree is cheap; a broad one can start a long walk.
- The CLI gives up after 600 seconds by default (`--timeout 0` removes the cap).
  Scans started this way are background jobs: they do not show in the main jobs list of the web UI.

- The first scan of a large tree can be slow. The server then answers 202 with a
  job; the CLI waits and shows progress. Let it finish, do not kill and retry.
- Results come from a cache and may be stale. Stale-cache and truncation notes
  go to stderr with the age of the oldest folder. Use `--fresh` only when you need
  current numbers, for example right after deleting or writing a lot of data.
- Hard links are counted once per link, unlike `du`. Totals can exceed `du`.

## Examples

```
filedeck du -sh --cached node1:/srv/data
filedeck du -sh node1:/srv/data
filedeck du -h -d 1 node1:/srv/data
filedeck du -h -d 2 node1:/srv/data node2:/var/lib
filedeck du --json -d 1 node1:/srv/data
filedeck du -sh --fresh node1:/srv/data/uploads
```
