# `filedeck du`

A `du` for the folders on your nodes, answered from the hub's stored folder sizes instead of walking the disk each time.

```sh
filedeck du [-s] [-h] [-d N] [-a] [--apparent-size] [--fresh | --cached] [--json] [--timeout SECONDS] node:/path...
```

| Flag | Meaning |
|---|---|
| `-s`, `-d N` | Summary only, or entries up to N levels below the argument (like `du`) |
| `-h` | Sizes as `1.5K`, `23M` (powers of 1024, rounded up, like `du -h`) |
| `-a` | Also list files |
| `--apparent-size` | Bytes of content instead of disk usage |
| `--fresh` | Re-read every folder instead of reusing stored sizes |
| `--cached` | Answer from stored sizes only: never starts a scan, and says so when a folder is not stored (exit 1). Conflicts with `--fresh` |
| `--json` | Print the hub's answer as JSON (one object per argument) |
| `--timeout SECONDS` | Give up on an argument after this long in total (default: 600; `0` follows a live job with no cap; Ctrl-C or the timeout leaves the job running, rerun to rejoin) and exit 1 |

Without `-h` the unit is 1 KiB blocks, as in `du`. Children are printed before their parent. Paths are `node:/path`, where `node` is a node name from the sidebar. A long scan answers with a job; the CLI polls it and prints progress on stderr. When the answer comes from stored sizes it says so on stderr (with the age of the oldest folder), because changes since the last scan may be missing; `--fresh` avoids that. Like `du -x`, a scan stays on the filesystem of its path: a mount point below it is not counted in any folder above it, but listed as an entry of its own (the size of its own scan when it has one, otherwise only a note on stderr). With `--cached` while a scan runs, folders the scan has not finished answer with what it has counted so far, and stderr says the sizes are partial. A scan that an agent restart stopped goes on from the folders it had already stored when its job runs again. The agent streams each answer from its store, so its memory does not grow with the number of entries; near its memory limit a scan briefly waits while the kernel frees the cache of what it has read. Exit status is 0 on success, 1 if any argument failed, 2 for a usage or configuration error, 130 when interrupted with Ctrl-C (the job keeps running on the server).

Environment: `FILEDECK_URL` (hub base URL, for example `https://filedeck.example.org`) and `FILEDECK_TOKEN` (the read-only token).

Token setup: create a Secret with a long random value (`kubectl create secret generic filedeck-api-token --from-literal=token="$(openssl rand -base64 48)"`) and set `apiToken.secretName: filedeck-api-token` in the chart values; the hub reads it as `FILEDECK_API_TOKEN` (or the file named by `FILEDECK_API_TOKEN_FILE`). The CLI sends the token in the header `X-Filedeck-Token: <token>`; `Authorization` is never read or changed, so an ingress or OIDC login in front of the hub keeps working. A request with a matching `X-Filedeck-Token` may call only `GET /api/nodes/<node>/api/du` and `GET /api/nodes/<node>/api/jobs/<id>` for du jobs; every other route answers 403. If the header is present with any other value (wrong, empty, repeated), or present while the feature is off, the answer is 401. The hub removes the header before it talks to an agent. Requests without the header are handled as before. Unset, the feature is off.

Ingress rule: skip login only when `X-Filedeck-Token` is present; the hub then enforces the token and the du-only scope itself, so a request carrying the header with anything else is refused.

Run it from the image (`filedeck du ...` is on the `PATH`), from a checkout after `npm run build` (`npx filedeck du ...` or `node server/dist/cli.js du ...`), or anywhere with Node 22 and the built `server/dist`.

## The stored sizes file

An agent keeps its stored folder sizes in a SQLite file, `sizes-<node>.db` in the index folder. If only an index of that file is damaged, the agent rebuilds it and logs one line. If the file is not SQLite or its tables are damaged, the agent replaces it by itself: it makes a new, empty file `sizes-<node>.db.gen<N>` (the next number), deletes the damaged file and its `-wal` and `-shm` files, and logs one line that names both files. Folder sizes are then measured again. No operator step is needed. Every agent process that uses the file moves to the new one within a few seconds. A file name is never used again, so a process that still has the old file open can never mix its writes into the new one. An agent makes a new file at most once in 10 minutes. While a heal waits, sizes are read from disk (`cached` is false). The Prometheus text at `GET /metrics` on the agent port (no token, only these two 0/1 gauges) shows `filedeck_size_store_available` (0 while sizes are not cached) and `filedeck_size_store_damaged` (1 while a damaged file is not yet replaced).

A new file gives free pages back to the disk (incremental auto-vacuum). A file made by an older version never does, so it keeps the size of the most folders it ever held. When such a file is more than half free pages and more than 1 GiB is free, the agent replaces it with a new file in the same way and logs one line.

[Back to the README](../README.md)
