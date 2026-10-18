---
name: filedeck-du
description: Report folder and disk sizes on filedeck-managed nodes with `filedeck du` instead of `du`, `ncdu` or `find -size`. Use when asked how big a directory is, what is using space, or to find the largest folders on a node.
---

# filedeck du

Filedeck keeps a cached size index of each managed node. Query it instead of
scanning the disk: it answers in milliseconds and puts no I/O load on the node.

## When to use

- Size of a folder or disk on a filedeck-managed node: use `filedeck du`.
- Do not run `du`, `ncdu`, `find -size` or other long recursive scans there.
- `df` is fine for whole-filesystem totals (used and free space).

## Synopsis

Matches 3.FD-11; the CLI is the source of truth if it differs.

```
filedeck du [-s] [-h] [-d N] [-a] [--apparent-size] [--fresh] [--json] node:/path...
```

- `-s` summary only, `-h` human-readable sizes, `-d N` depth limit.
- `-a` include files, not only directories.
- `--apparent-size` report file length instead of disk usage.
- `--fresh` force a rescan (see below).
- `--json` machine-readable output.
- Paths are `node:/path`, for example `node1:/srv/data`.

## Environment

- `FILEDECK_URL`: base URL of the filedeck server.
- `FILEDECK_TOKEN`: read-only token. It can read sizes only, never file contents.

## Behaviour

- The first scan of a large tree can be slow. The server then answers 202 with a
  job; the CLI waits and shows progress. Let it finish, do not kill and retry.
- Results come from a cache and may be stale. Use `--fresh` only when you need
  current numbers, for example right after deleting or writing a lot of data.
- Hard links are counted once per link, unlike `du`. Totals can exceed `du`.

## Examples

```
filedeck du -sh node1:/srv/data
filedeck du -h -d 1 node1:/srv/data
filedeck du -h -d 2 node1:/srv/data node2:/var/lib
filedeck du --json -d 1 node1:/srv/data
filedeck du -sh --fresh node1:/srv/data/uploads
```
