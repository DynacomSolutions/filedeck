# FileDeck agent (Rust)

`filedeckd` is the Rust agent of FileDeck. It replaces the TypeScript agent step by step, Mac first.
The agent has bearer authentication, `/healthz`, `/metrics`, `/api/info` and the read only file routes (mounts, list, stat, read, download, text).
The web app and the hub do not change.

## Layout

| Crate | What it holds |
|---|---|
| `crates/fd-core` | configuration, start-up errors, the agent token and its file checks, build facts |
| `crates/fd-fs` | confined file access: path resolution under the root, list, stat, ranges, text, mounts |
| `crates/fd-http` | the axum router, bearer authentication, `/healthz`, `/metrics`, `/api/info`, the file routes |
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
| `FILEDECK_INDEX_DIR` | `index_dir` | none | state folder (not used yet) |
| `FILEDECK_READONLY` | `read_only` | none | comma separated absolute prefixes, checked at start |
| `FILEDECK_PROC_MOUNTS` | `proc_mounts` | system table | a mount table in `/proc/mounts` format, read instead of the system's own |
| `FILEDECK_MAX_EDIT` | `max_edit` | `5242880` | the largest file `/api/fs/text` returns, in bytes |
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
| `GET /api/mounts` | bearer | `{mounts: [...]}`: device, mount point, type, sizes, network kind. Every mount is `readOnly`. |
| `GET /api/fs/list` | bearer | `{path, entries, truncated}`; `stream=1` gives NDJSON batches. Folders first, natural order, at most 20000 entries. |
| `GET /api/fs/stat` | bearer | one entry; a final link is not followed |
| `GET,HEAD /api/fs/read`, `/api/fs/download` | bearer | file bytes with `Range`, `Last-Modified` and a sandbox CSP |
| `GET /api/fs/text` | bearer | `{path, content, size, mtime, etag}`; 413 over `FILEDECK_MAX_EDIT`, 415 for a binary file |
| routes that change files | bearer | 403 `{"error":"this agent is read-only"}` |
| anything else | bearer | 404 `{"error":"not found"}` |

Paths follow the TypeScript agent: `..` is refused (400), an absolute link is re-based on the root, a link that climbs above
the root is clamped, and the agent's own names (`.filedeck-trash`, `.filedeck-work`, `.filedeck-work-*`) are hidden and refused.
Each folder on the way is opened with `openat` and `O_NOFOLLOW`, so a swapped folder cannot lead out of the root.
The mount table is `/proc/mounts` on Linux (or `FILEDECK_PROC_MOUNTS`) and the output of `mount(8)` on macOS.

A request without a valid `Authorization: Bearer <token>` gets 401 `{"error":"unauthorized"}`.
The token is compared in constant time (SHA-256 of both sides, then a constant time compare).

Set `FILEDECK_BUILD_COMMIT` at build time to put a commit in `filedeck_agent_build_info`.
