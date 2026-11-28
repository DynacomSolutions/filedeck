# FileDeck agent (Rust)

`filedeckd` is the Rust agent of FileDeck. It replaces the TypeScript agent step by step, Mac first.
It has the server skeleton (bearer authentication, `/healthz`, `/metrics`, `/api/info`) and the folder sizes: `du`, size jobs and the job list.
There is no change watcher yet, so a `du` that the stored rows cannot answer is answered by a job.
The web app and the hub do not change.

## Layout

| Crate | What it holds |
|---|---|
| `crates/fd-core` | configuration, start-up errors, the agent token and its file checks, build facts |
| `crates/fd-store` | the folder size store (SQLite), the walker and the `du` tree. Synchronous: the HTTP side runs it on blocking threads |
| `crates/fd-http` | the axum router, bearer authentication, `/healthz`, `/metrics`, `/api/info`, `du`, the size jobs and the job queue |
| `crates/filedeckd` | the binary: config load, listener, signal handling |

`tests/golden/` holds answers of the TypeScript agent that the Rust tests compare against.

## Build

The toolchain is pinned in `rust-toolchain.toml`. With `rustup` it installs itself.

```sh
cd agent
cargo build --release          # target/release/filedeckd
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo deny check               # needs cargo-deny
```

Set `CARGO_TARGET_DIR` to keep build output outside the checkout.

## Run

The agent needs a token. Put it in a file that only its owner can read:

```sh
umask 077
openssl rand -hex 32 > /etc/filedeck/agent-token
FILEDECK_NODE=macbook FILEDECK_ROOT=/ FILEDECK_AGENT_TOKEN_FILE=/etc/filedeck/agent-token PORT=8080 filedeckd
curl -s localhost:8080/healthz
curl -s -H "Authorization: Bearer $(cat /etc/filedeck/agent-token)" localhost:8080/api/info
```

The agent stops on SIGTERM or SIGINT. It fails readiness (`/healthz?ready=1`), stops accepting and finishes the requests in flight.
It runs no timer.

## Settings

The names match the TypeScript agent. An environment setting wins over the file.
The file is TOML, named by `--config <file>` or `FILEDECK_CONFIG`. Its keys are the lower case names without the prefix.

| Environment | File key | Default | Note |
|---|---|---|---|
| `FILEDECK_MODE` | | `agent` | any other value is refused |
| `FILEDECK_NODE` | `node` | `local` | |
| `FILEDECK_ROOT` | `root` | `/host` | absolute path |
| `FILEDECK_HOST` | `host` | all addresses | |
| `PORT` | `port` | `8080` | `0` picks a free port |
| `FILEDECK_INDEX_DIR` | `index_dir` | none | state folder; the size store is `sizes-<node>.db` in it. Without it the store is a private temporary file that goes with the process |
| `FILEDECK_DU_WAIT_MS` | `du_wait_ms` | `10000` | how long a `du` request waits for its scan before it answers 202 |
| `FILEDECK_WALK_MAX_ENTRIES` | `walk_max_entries` | `500000` | cap on the entries of one `du` answer |
| `FILEDECK_INDEX_REVALIDATE_MS` | `index_revalidate_ms` | `1800000` | a stored folder that did not change is reused for this long |
| `FILEDECK_JOB_CONCURRENCY` | `job_concurrency` | `2` | jobs that run at once (a scan that runs for 30 s stops counting, so a small one can start) |
| `FILEDECK_DU_ABANDON_MS` | `du_abandon_ms` | `120000` | a queued `du` job that no client asked about for this long is forgotten; `0` = never |
| `FILEDECK_READONLY` | `read_only` | none | comma separated absolute prefixes, checked at start |
| `FILEDECK_AGENT_TOKEN_FILE` | `agent_token_file` | none | see below |
| `FILEDECK_AGENT_TOKEN` | | none | the token itself; prefer the file |
| `FILEDECK_AUTH` | | off | `on` is refused: sign-in is not ported |

Exactly one of the two token settings must be set. The agent has no open mode.
The token has at least 16 characters and no space.
The token file must be a plain file (not a symbolic link), owned by root or by the agent user, with no group or other
permission bits (mode 0600 or 0400). The agent refuses to start otherwise, and never prints the token.

## Routes

| Route | Auth | Answer |
|---|---|---|
| `GET /healthz` | open | `ok`; `?ready=1` gives 503 before start and after SIGTERM |
| `GET /metrics` | open | Prometheus text 0.0.4: `filedeck_agent_build_info`, `filedeck_agent_start_timestamp_seconds` |
| `GET /api/info` | bearer | `{node, root, watches, readOnly, sandbox}`, as the TypeScript agent |
| `GET /api/du` | bearer | `path`, `depth` (0 to 64), `all`, `fresh`, `cachedOnly`, `refresh=auto`: the folder sizes (see below) |
| `POST /api/jobs/size` | bearer | `{path, fresh?}`: a size job, 202 and the job view |
| `GET /api/jobs` | bearer | `{jobs: [...]}`, newest first |
| `GET /api/jobs/:id` | bearer | the job view; `?wait=<0 to 30>` holds the answer until the job has ended |
| `POST /api/jobs/:id/cancel`, `DELETE /api/jobs/:id` | bearer | cancel; forget a finished job |
| anything else | bearer | 404 `{"error":"not found"}` |

## Folder sizes

`fd-store` keeps the schema and the meaning of the TypeScript store (`server/src/size-store.ts`), table for table. One file can be read by
either agent: the Rust agent reuses the rows the TS agent wrote, and the other way round (`server/test/rust/store-compat.test.ts` proves it).

- One row per folder, with its own counters and the totals of its subtree. Hard links count once per link. Symbolic links are counted, never followed.
  Another device is a mount point: counted, not entered. The trash and the work folders are skipped.
- A stored folder is reused while its inode, device and mtime match a fresh `lstat` and it is younger than `FILEDECK_INDEX_REVALIDATE_MS`.
  A change inside a file does not change its folder, and neither does a new name for a file in another folder (`links` is exact after a rescan).
  The change watcher of a later release removes this gap. `fresh=1` always reads from disk.
- One process writes the file. It holds an OS file lock (`<file>.lock`), which goes with the process: no heartbeat and no timer. The `writer` table
  still gets a new epoch at each start, and every commit checks it. A second process reads and answers `stale`, and starts no job.
- Scans of overlapping folders run one after the other, in the order they were asked for. Scans of other folders run side by side.
- Timers: a running scan arms one deadline (30 s, then it stops counting against the job limit), and a queued `du` job arms one deadline
  for its grace period. Nothing else wakes the agent.

Differences from the TypeScript agent: no job file (a job does not survive a restart), no writer lease hand-over between two processes,
no self-heal of a damaged file (it answers from memory and `filedeck_size_store_damaged` says 1), and a scan of a folder below a running scan waits for it
(the TS store lets it go beside).

A request without a valid `Authorization: Bearer <token>` gets 401 `{"error":"unauthorized"}`.
The token is compared in constant time (SHA-256 of both sides, then a constant time compare).

Set `FILEDECK_BUILD_COMMIT` at build time to put a commit in `filedeck_agent_build_info`.
