# `filedeck du`

A `du` for the folders on your nodes, answered from the hub's stored folder sizes instead of walking the disk each time.

```sh
filedeck du [-s] [-h] [-d N] [-a] [--apparent-size] [--fresh | --cached | --refresh-auto] [--json] [--timeout SECONDS] node:/path...
```

| Flag | Meaning |
|---|---|
| `-s`, `-d N` | Summary only, or entries up to N levels below the argument (like `du`) |
| `-h` | Sizes as `1.5K`, `23M` (powers of 1024, rounded up, like `du -h`) |
| `-a` | Also list files |
| `--apparent-size` | Bytes of content instead of disk usage |
| `--fresh` | Re-read every folder instead of reusing stored sizes |
| `--cached` | Answer from stored sizes only: never starts a scan, and says so when a folder is not stored (exit 1). Conflicts with `--fresh` |
| `--refresh-auto` | Answer from stored sizes at once. If a part is out of date, the hub also starts (or joins) one background scan of that folder, and stderr names its job. The CLI does not wait for it: run the command again later for newer sizes. Conflicts with `--fresh` and `--cached` |
| `--json` | Print the hub's answer as JSON (one object per argument) |
| `--timeout SECONDS` | Give up on an argument after this long in total (default: 600; `0` follows a live job with no cap; Ctrl-C or the timeout leaves the job running, rerun to rejoin) and exit 1 |

Without `-h` the unit is 1 KiB blocks, as in `du`. Children are printed before their parent. Paths are `node:/path`, where `node` is a node name from the sidebar. A long scan answers with a job; the CLI follows it with long polls (see below) and prints progress on stderr. A scan of a folder below a scan that still runs does not wait for it, so a small folder is answered at once while a large folder above it is scanned. When the answer comes from stored sizes it says so on stderr (with the age of the oldest folder), because changes since the last scan may be missing; `--fresh` avoids that. Like `du -x`, a scan stays on the filesystem of its path: a mount point below it is not counted in any folder above it, but listed as an entry of its own (the size of its own scan when it has one, otherwise only a note on stderr). With `--cached` while a scan runs, folders the scan has not finished answer with what it has counted so far, and stderr says the sizes are partial. A scan that an agent restart stopped goes on from the folders it had already stored when its job runs again. The agent streams each answer from its store, so its memory does not grow with the number of entries; near its memory limit a scan briefly waits while the kernel frees the cache of what it has read. Exit status is 0 on success, 1 if any argument failed, 2 for a usage or configuration error, 130 when interrupted with Ctrl-C (the job keeps running on the server).

Environment: `FILEDECK_URL` (hub base URL, for example `https://filedeck.example.org`) and `FILEDECK_TOKEN` (the read-only token). Instead of `FILEDECK_TOKEN` you can set `FILEDECK_TOKEN_FILE`, the path of a file that holds the token (for a mounted secret); the CLI reads it at each run. `FILEDECK_TOKEN` wins when both are set.

## API: stored sizes first, live refresh in the background

`GET /api/du?path=<p>[&depth=N][&all=1][&fresh=1][&cachedOnly=1][&refresh=auto]`

| Parameter | Meaning |
|---|---|
| (none) | A folder the store vouches for is answered at once. Otherwise the hub starts or joins a scan, waits up to `duWaitMs`, then answers 200, or 202 `{jobId, state}` |
| `fresh=1` | Always a scan (a rescan). Unchanged |
| `cachedOnly=1` | Stored rows only, never a scan. 204 when the folder is not stored. `stale: true` unless the store vouches for the rows. Unchanged |
| `refresh=auto` | Answer from the stored rows at once. When they are not vouched for, they go out with `stale: true`, and one scan of that folder (no wider tree) is started or joined in the background. When the folder is not stored, it behaves as without the parameter. Conflicts with `fresh` and `cachedOnly` (400) |

Fields added to the answer: `ageMs` (milliseconds since the stored row of the asked folder was scanned; absent for a scan that has not finished), and with `refresh=auto` on stale rows `refreshJobId` (the background scan; absent when none was started). `stale` and `cached` are as before. Every request for the same folder joins the one live scan. No refresh scan starts while another process writes the store, while a scan of an overlapping folder runs, or while as many refresh scans run as the job concurrency allows; the answer is then still `stale: true` with no `refreshJobId`. The scan has no queue priority of its own: it waits in the same job queue as other scans.

`GET /api/jobs/<id>?wait=<seconds>` (0 to 30) is a long poll: the hub answers when the job has ended, or after that many seconds with the job as it is. Without `wait` it answers at once. A client follows a job with repeated long polls and needs no timer. The CLI asks for 20 seconds each time.

Token setup: create a Secret with a long random value (`kubectl create secret generic filedeck-api-token --from-literal=token="$(openssl rand -base64 48)"`) and set `apiToken.secretName: filedeck-api-token` in the chart values; the hub reads it as `FILEDECK_API_TOKEN` (or the file named by `FILEDECK_API_TOKEN_FILE`). The CLI sends the token in the header `X-Filedeck-Token: <token>`; `Authorization` is never read or changed, so an ingress or OIDC login in front of the hub keeps working. A request with a matching `X-Filedeck-Token` may call only `GET /api/nodes/<node>/api/du` and `GET /api/nodes/<node>/api/jobs/<id>` for du jobs; every other route answers 403. If the header is present with any other value (wrong, empty, repeated), or present while the feature is off, the answer is 401. The hub removes the header before it talks to an agent. Requests without the header are handled as before. Unset, the feature is off.

Pods need no secret. With the chart value `k8sAuth.allow` set (for example `["agents/*", "dynacom/storage-scanner"]`: `namespace/name`, or `namespace/*` for a whole namespace), a pod that mounts a projected ServiceAccount token with audience `filedeck` can run `filedeck du` with no environment. In a pod (`KUBERNETES_SERVICE_HOST` set) the CLI uses `http://filedeck.dynacom.svc` when `FILEDECK_URL` is unset, and reads `/var/run/secrets/filedeck/token` (or `FILEDECK_SA_TOKEN_FILE`) when `FILEDECK_TOKEN` is unset. The token goes in the same `X-Filedeck-Token` header. The hub checks it with the Kubernetes TokenReview API (audience `filedeck`), caches the answer by token hash until the token expires (at most 5 minutes), and checks the ServiceAccount against the allowlist: an unknown or expired token answers 401, a ServiceAccount that is not listed answers 403. Such a token may read `du` and its jobs only, never `changes` or `groups`. Each call is written to the audit log with the ServiceAccount. The chart adds a ClusterRole that may only create TokenReviews, bound to the hub account. Pod spec:

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

Ingress rule: skip login only when `X-Filedeck-Token` is present; the hub then enforces the token and the du-only scope itself, so a request carrying the header with anything else is refused.

Run it from the image (`filedeck du ...` is on the `PATH`), from a checkout after `npm run build` (`npx filedeck du ...` or `node server/dist/cli.js du ...`), or anywhere with Node 22 and the built `server/dist`.

## The stored sizes file

An agent keeps its stored folder sizes in a SQLite file, `sizes-<node>.db` in the index folder. If only an index of that file is damaged, the agent rebuilds it and logs one line. If the file is not SQLite or its tables are damaged, the agent replaces it by itself: it makes a new, empty file `sizes-<node>.db.gen<N>` (the next number), deletes the damaged file and its `-wal` and `-shm` files, and logs one line that names both files. Folder sizes are then measured again. No operator step is needed. Every agent process that uses the file moves to the new one within a few seconds. A file name is never used again, so a process that still has the old file open can never mix its writes into the new one. An agent makes a new file at most once in 10 minutes. While a heal waits, sizes are read from disk (`cached` is false). The Prometheus text at `GET /metrics` on the agent port (no token, only these two 0/1 gauges) shows `filedeck_size_store_available` (0 while sizes are not cached) and `filedeck_size_store_damaged` (1 while a damaged file is not yet replaced).

A new file gives free pages back to the disk (incremental auto-vacuum). A file made by an older version never does, so it keeps the size of the most folders it ever held. When such a file is more than half free pages and more than 1 GiB is free, the agent replaces it with a new file in the same way and logs one line.

[Back to the README](../README.md)
