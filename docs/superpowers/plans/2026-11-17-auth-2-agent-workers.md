# Per-user workers on the agents: implementation plan (part 2a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With `FILEDECK_AUTH=on`, every file request an agent gets runs in a worker process that has the signed-in account's uid, gid and groups, no capabilities, no-new-privileges and the seccomp filter, and for a virtual account also a Landlock ruleset made from its grants. Trash, thumbnails, the compare index, agent jobs and `/api/du` follow the account.

**Architecture:** The agent's root process keeps routing, the size store, the change watcher for sizes, the trash sweep and worker management. A new `WorkerPool` starts `node worker.js` through `filedeck-sandbox` (new options: supplementary groups, `chroot`, socketpair only) as the local account that a new host helper, `filedeck-id`, resolves through the machine's own NSS. Root and worker talk over a socket pair made by `spawn` (stdio slot 3, no path on disk) with a small framed protocol that streams bodies both ways with flow control and carries aborts. The worker runs the same Hono file routes as today, which this plan moves out of `createAgent` into one shared function. With auth off nothing changes.

**Tech Stack:** Node 22, TypeScript, Hono, `node:net`, `node:stream` (`duplexPair` in tests), `node:test`; C (musl, static) for `filedeck-sandbox`; C (glibc, dynamic, old baseline) for `filedeck-id`; Helm.

**Spec:** `docs/superpowers/specs/2026-11-17-authentication-design.md`. This plan covers "Order of work" step 2 on the agent side. Part 2b (`docs/superpowers/plans/2026-11-17-auth-2-agent-workers-2b.md`) covers PAM, system-user key sign-in, the real `SystemAuth` on the hub, refusing uid 0 at sign-in, narrowing `canUseNode`, act-as-root and event streams after sign-out. Part 1 (`docs/superpowers/plans/2026-11-17-auth-1-hub-sign-in.md`) is built and in review; this branch is stacked on it.

**State after 2a (not released):** with `FILEDECK_AUTH=on` all file work of a signed-in account is confined by the kernel. Virtual accounts work end to end. System accounts still cannot sign in (`unavailableSystemAuth` until 2b), so the docs still say `FILEDECK_AUTH` is not ready to turn on. With auth off the whole suite passes unchanged. Release waits for 2b, part 3 and board row 20.160.

## Deviations from the spec

1. **Compare index.** The spec puts the compare index on the hub and keys it by account. In the code the persistent index (listings and content hashes, `IndexCache` in `diff-routes.ts`, `FILEDECK_INDEX_DIR/index-<node>.db`) is on the agent, and the hub keeps only one `CompareSession` per job, which part 1 already gives an owner. So the index moves into the worker: one file per account under `FILEDECK_INDEX_DIR/accounts/<key>/`. The key holds a hash of a virtual account's grants, because `stat` is not limited by Landlock and a listing cached under old grants could be served under new ones. The disk cost is the one the spec accepts.
2. **Trash folder per virtual account.** The spec gives each uid one folder. Two virtual accounts with the same `runAs` would then see, and through their Landlock rule read, each other's deleted files, also from folders the other has no grant on. So system users get `.filedeck-trash/u<uid>/` as specified, and each virtual account gets `.filedeck-trash/v-<name>/` (owned by its `runAs` uid). Legacy items at the top of `.filedeck-trash` move to `u0/` the first time the root process makes a scoped folder there.
3. **`/api/du` check.** The spec says `faccessat`. `faccessat` does not apply Landlock, so it would let a virtual account through to folders outside its grants. The worker tries to open each folder (`O_RDONLY | O_DIRECTORY`) instead, which applies both the file modes and Landlock.
4. **Worker seccomp allows `socketpair(AF_UNIX)`.** Node starts every child process (git, bsdtar, 7zz, ffmpeg) with stdio pipes made by `socketpair`, which the launcher's filter refuses today. A new launcher flag lets only `socketpair` with `AF_UNIX` through. `socket`, `connect`, `bind`, `listen`, `accept` and io_uring stay refused.
5. **Archive jobs are not handed over across an agent restart with auth on.** Today an agent's compress, extract and permission jobs are kept in a shared job file and adopted by the next process. A worker cannot write that root-owned file, and its jobs must run as the account. With auth on these jobs live in the worker's memory and fail with `interrupted by an agent restart` when the agent stops. Size and `du` jobs stay in the root process and keep the hand-over.
6. **Setting name.** The spec writes `FILEDECK_WORKER_IDLE`. Part 1 named its time settings with a unit (`FILEDECK_SESSION_IDLE_SECONDS`), so this is `FILEDECK_WORKER_IDLE_SECONDS`.
7. **No PAM or NSS mounts.** The agent already sees the machine's `/` at `FILEDECK_ROOT` (`/host` in the chart), and the host helpers `chroot` there, so the chart adds only the `SYS_CHROOT` capability (auth on), not mounts. The spec says the same; it is listed here because the board row asked for mounts.

Not deviations, but decisions the spec leaves open: transcoding stores nothing on disk (`transcode.ts`), so only thumbnails get a per-uid cache. With every worker busy and the pool full, a new account gets 503 with `Retry-After: 5`. A system user's worker has no Landlock ruleset (the spec asks for Landlock only for virtual accounts). The concurrency limits (search, archive tools, thumbnails, hashing) apply per worker.

## Global Constraints

- Everything new is inert unless `FILEDECK_AUTH=on`. With it off, every existing test passes unchanged and no worker is ever started.
- A worker never runs as uid 0 or gid 0. A name or `runAs` that resolves to uid 0 is answered like an unknown name: 403 `{"error":"no account on this machine"}`.
- A worker never gets a secret: no `FILEDECK_AGENT_TOKEN`, `FILEDECK_API_TOKEN`, `FILEDECK_VAULT_KEY` or other secret in its environment, its arguments or its init message.
- Workers: `FILEDECK_MAX_WORKERS` (default 6) at once, `FILEDECK_WORKER_IDLE_SECONDS` (default 600), each started with `--max-old-space-size=96`. Past the limit the least recently used idle worker is stopped. A worker with a request in flight, an open stream or a live job is not idle.
- A request in flight on a worker that dies answers 503 `{"error":"worker stopped"}` (or ends its body with an error once the head is sent). The next request starts a new worker.
- Frames on the worker socket carry at most 64 KiB of payload. Each stream has a window of 1 MiB per direction.
- Two virtual accounts with the same `runAs` but different grants get separate workers.
- Root-only tests use the repo's pattern (`server/test/sandbox.test.ts`): `const ROOT_ONLY = process.getuid?.() === 0 ? false : "worker live: skipped (not running as root)"`. Every new skip text gets an anchored entry in `scripts/check-test-skips.mjs`.
- Run server tests with a private `TMPDIR` (a folder only you can change), for example `export TMPDIR=$(mktemp -d)`, else the sandbox tests fail locally.
- The repo's British English prose and comment style. No real infrastructure names in code, tests or docs.

## Review Focus

1. **A link or `..` inside a virtual account's grant that leads outside it** (to a folder the `runAs` user can read). The kernel must refuse it, also for search, thumbnails, git, archives and `/api/du`. Test owner: Task 7, `link out of a grant`.
2. **A big download or upload that the client drops halfway.** The worker must stop reading or writing at once and the root process must not buffer the file. Test owner: Task 3, `bounded buffering` and `abort reaches the handler`.
3. **A worker killed in the middle of a request** (out of memory, `kill -9`). Expect 503 or a body that ends with an error, never a hang, and a fresh worker on the next request. Test owner: Task 5, `worker killed mid-request`.
4. **An epoch raised while the account's worker is busy.** The old worker stops, a claim with the old epoch is refused, a claim with the new epoch gets a new worker. Test owner: Task 6, `epoch change`.
5. **Two virtual accounts with one `runAs`.** Separate workers, separate trash folders, and neither sees the other's deleted files. Test owners: Task 6 `same runAs, other grants` and Task 8 `virtual accounts sharing a runAs`.

---

### Task 1: Launcher: supplementary groups, chroot, socketpair only

**Files:**
- Modify: `server/native/filedeck-sandbox.c` (option parsing, the user change, the seccomp filter, the file comment and usage line)
- Modify: `server/src/sandbox.ts` (`SandboxOpts`, `spawnSandboxed`)
- Modify: `scripts/check-test-skips.mjs` (allow `worker live: skipped (not running as root)`)
- Test: `server/test/sandbox.test.ts`

**Interfaces:**
- Produces, in the launcher:
  - `--groups G1,G2,...`: decimal gids, at most 256, each parsed with `parse_id`. Needs `--uid`. `setgroups(n, list)` replaces `setgroups(0, NULL)`. A gid 0 in the list is refused (exit 64) unless `--allow-root-user`.
  - `--chroot DIR`: after the roots are opened and before the capability steps: `chroot(DIR)` then `chdir("/")`. Refused together with `--cwd-fd` (exit 64). A failure exits 71 with `filedeck-sandbox: chroot DIR: <error>`. COMMAND is then looked up inside DIR.
  - `--allow-socketpair`: the filter lets `socketpair` through when `args[0] == AF_UNIX` and gives `EACCES` otherwise. Ignored with `--allow-sockets`.
- Produces, in `sandbox.ts`, new `SandboxOpts` fields: `groups?: number[]`, `chroot?: string`, `allowSocketpair?: boolean`, `landlock?: false` (pass `--no-landlock` even where Landlock works), `keepStdio?: number[]` (stdio slots, such as 3, that get `--keep-fd N`). `spawnSandboxed` refuses `groups` containing 0 with `FsError(500, "refusing to run a confined program as root")`.

- [ ] **Step 1: Write the failing tests** in `server/test/sandbox.test.ts`, after the existing live tests:
  - `socketpair needs the flag` (skip when `!info.seccomp`): `spawnSandboxed(process.execPath, ["-e", "require('child_process').execFileSync('true')"], { readExec: [<node prefix>] })` exits non-zero with `EACCES` in stderr. With `allowSocketpair: true` it exits 0. With the flag, `-e "require('net').connect('/nonexistent').on('error', e => { console.log(e.code); })"` prints `EACCES`.
  - `chroot needs the capability` (unprivileged only): `--chroot /` gives exit 71 and `chroot` in stderr.
  - `groups and chroot` (`ROOT_ONLY`): `{ uid: 1234, gid: 1234, groups: [1234, 2345], landlock: false }` running `id -G` prints `1234 2345`. Copy `box.staticBin` to `<tmp>/probe`, run `--chroot <tmp> --no-landlock -- /probe --probe`: exit 0 or 70 (it ran inside the chroot). `groups: [0]` rejects with `/root/`.
  - `keepStdio`: with `stdio: ["ignore","pipe","pipe","pipe"], keepStdio: [3]` the child can write to descriptor 3 (`node -e "require('fs').writeSync(3,'x')"`) and the parent reads `x` from `child.stdio[3]`.
- [ ] **Step 2: Run** `cd server && node --import tsx --test test/sandbox.test.ts`. Expected: the new tests FAIL (unknown option).
- [ ] **Step 3: Implement** the three options in the C file (update the file comment's option list, the step order line and the usage string), and the new fields in `spawnSandboxed` in both branches (Landlock and `--no-landlock`). Add `/^worker live: skipped \(not running as root\)$/` to the allowed skips.
- [ ] **Step 4: Run** the test file, then the root pass: `sudo env "PATH=$PATH" FILEDECK_REQUIRE_SANDBOX=1 node --import tsx --test test/sandbox.test.ts`. Expected: PASS in both.
- [ ] **Step 5: Commit** with `git commit -m "feat(sandbox): supplementary groups, chroot and socketpair-only options"`.

### Task 2: `filedeck-id` on the host, and local account lookup

**Files:**
- Create: `server/native/host/filedeck-id.c`, `server/src/host-helpers.ts`, `server/src/local-accounts.ts`
- Modify: `server/scripts/build-native.mjs` (builds `native/host/*.c`), `Dockerfile` (a glibc build stage), `server/src/config.ts`, `.github/workflows/ci.yml` (`FILEDECK_REQUIRE_HOST_HELPERS=1` on the root step), `scripts/check-test-skips.mjs`
- Test: `server/test/local-accounts.test.ts`, `server/test/host-helpers.test.ts`

**Interfaces:**
- `filedeck-id NAME`: dynamic glibc program. `getpwnam_r` then `getgrouplist` (buffer grown up to 65536). Prints exactly four lines: uid, gid, home, then the group ids separated by spaces. Exit 0; exit 2 with no output for an unknown name; 64 on usage errors.
- `host-helpers.ts`:
  - `hostHelperDir(): Promise<string | null>`: `FILEDECK_HOST_HELPERS`, else `/usr/local/lib/filedeck/host` (image), else `BUILT_NATIVE_DIR/host`; null when `filedeck-id` is not there.
  - (Changed in review, ruling R1.) Nothing is copied to the host: the host's `/run` is `noexec` on Debian and Ubuntu. The launcher option `--exec-outside` (with `--chroot` and `--no-landlock`) opens the program from the image before the chroot and runs it by descriptor (`execveat` with `AT_EMPTY_PATH`), so its ELF loader and NSS modules come from the host.
  - `runHostHelper(root: string, dir: string, name: string, args: string[], o: { stdin?: Buffer; timeoutMs?: number; keepCaps?: Capability[]; allowMetadata?: boolean }): Promise<{ code: number | null; stdout: string }>`. Runs through `spawnSandboxed` with `chroot: root`, `execOutside: true`, `landlock: false`, `filedeck-id` as uid and gid 65534, `allowSockets: true` (NSS may use SSSD or nscd sockets), an empty environment except `PATH=/usr/bin:/bin`, default timeout 10 s (then `SIGKILL`, code null). Output capped at 64 KiB.
- `local-accounts.ts`:
  - `interface LocalAccount { name: string; uid: number; gid: number; groups: number[]; home: string }`
  - `interface AccountResolver { resolve(name: string, fresh?: boolean): Promise<LocalAccount | null> }`. Null for unknown names (exit 2, no output), invalid names and uid 0 or gid 0; every other failure rejects, so callers answer 503 (ruling R3). `fresh` skips the cache.
  - `validSystemName(name: string): boolean`: `^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,63}$`.
  - `class HostAccounts implements AccountResolver { constructor(o: { run: (name: string) => Promise<{ code: number | null; stdout: string }>; ttlMs?: number; now?: () => number }) }`. Caches each answer (also "unknown") for `ttlMs` (default 60 s); a worker start always calls `resolve(name, true)`, so group changes are picked up when a worker starts.
  - `class FilesAccounts implements AccountResolver { constructor(root: string) }`. Reads `<root>/etc/passwd` and `<root>/etc/group` (local accounts only). Used when the host helper cannot run, so virtual accounts' `runAs` still resolve.
  - `makeResolver(cfg: Config, log: (s: string) => void): Promise<{ resolver: AccountResolver; helpers?: { root: string; dir: string } }>`: auth on only. `helpers` is set only when the host helpers run (part 2b starts PAM with it). Tries one `filedeck-id root` call through the image-side helper folder; on success it logs `system accounts: resolved through the host (NSS)`, else `system accounts: host lookup unavailable (<reason>); only local /etc/passwd accounts resolve, and system sign-in is refused` and returns `FilesAccounts` without `helpers`.
- `Config`: `hostHelpers: string | undefined` (`FILEDECK_HOST_HELPERS`).

- [ ] **Step 1: Write the failing tests:**
  - `local-accounts.test.ts` (no root): a fake `run` giving `"1000\n1000\n/home/a b\n1000 27\n"` resolves to `{uid:1000,gid:1000,home:"/home/a b",groups:[1000,27]}`. Output with uid 0, gid 0 or a malformed line gives null. Exit 2 gives null. `-x`, `a/b` and a 65-character name give null and `run` is never called. A second `resolve` within the TTL does not call `run`; `resolve(name, true)` does. `FilesAccounts` on a temp root with an `etc/passwd` and `etc/group` finds groups by member lists and refuses `root` and a `toor` line with uid 0.
  - `host-helpers.test.ts` (`ROOT_ONLY`, and skip with `host helpers live: skipped (no glibc here)` when `ldd --version` does not say glibc or GNU): Live against `/`: `nobody` resolves to uid 65534, `root` gives null, `no-such-user-xyz` gives null. With `FILEDECK_REQUIRE_HOST_HELPERS=1` the glibc skip is a failure.
- [ ] **Step 2: Run** `cd server && node --import tsx --test test/local-accounts.test.ts test/host-helpers.test.ts`. Expected: FAIL, modules not found.
- [ ] **Step 3: Implement.** `build-native.mjs` builds `native/host/*.c` into `dist/native/host/` with `cc -O2 -Wall -o OUT SRC`, only when `cc -dumpmachine` ends in `-gnu` (else one line `host helpers: skipped (not a glibc toolchain)`). `Dockerfile`: a stage `FROM debian:bullseye-slim@sha256:... AS hostbuild` (pinned by digest like the other stages) that installs `gcc libc6-dev libpam0g-dev` and builds `server/native/host/*.c` into `/out`, then `objdump -T /out/* | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1` must be at most `GLIBC_2.17` (fail the build otherwise); the final stage copies `/out` to `/usr/local/lib/filedeck/host/`. Add the two skip texts to the gate.
- [ ] **Step 4: Run** the two files, then the root pass with `sudo env "PATH=$PATH" FILEDECK_REQUIRE_HOST_HELPERS=1 node --import tsx --test test/host-helpers.test.ts`. Expected: PASS. Then `docker build .` builds the `hostbuild` stage and passes the symbol check.
- [ ] **Step 5: Commit** with `git commit -m "feat(agent): resolve local accounts through the host's NSS (filedeck-id)"`.

### Task 3: The worker socket protocol

**Files:**
- Create: `server/src/worker-proto.ts`
- Test: `server/test/worker-proto.test.ts`

**Interfaces:**
- Frame: `u32 BE` length of what follows, `u8` type, `u32 BE` stream id, payload. Types: `HELLO 1`, `READY 2`, `REQ_HEAD 3`, `BODY 4`, `END 5`, `ABORT 6`, `RES_HEAD 7`, `ERROR 8`, `WINDOW 9`, `BYE 10`. Stream ids: odd from the side that called `new Mux(..., "root")`, even from `"worker"`, 0 for `HELLO`, `READY` and `BYE`. Heads and errors are JSON: `REQ_HEAD {method, url, headers: [string, string][]}`, `RES_HEAD {status, headers: [string, string][]}`, `ERROR {message}`.
- `class Mux { constructor(sock: Duplex, side: "root" | "worker", o?: { onRequest?: (req: Request) => Promise<Response>; window?: number }) }` with:
  - `fetch(req: Request): Promise<Response>`. Streams `req.body`; `req.signal` sends `ABORT`; cancelling the returned body sends `ABORT`. Rejects with `WorkerGone` when the socket closes before `RES_HEAD`; after it, the body stream errors with `WorkerGone`.
  - `hello(init: unknown): void`, `onHello(fn: (init: unknown) => void): void`, `ready(): void`, `whenReady(): Promise<void>`
  - `inFlight(): number` (streams open in either direction), `close(): void`, `closed: Promise<void>`
- `class WorkerGone extends Error` (message `worker stopped`). A frame over 64 KiB of payload, an unknown type or bad JSON closes the mux.
- Flow control: a sender keeps at most `window` (default 1 MiB) bytes sent and not yet granted per stream; the receiver sends `WINDOW n` as the consumer pulls `n` bytes.
- `onRequest` gets a `Request` with `http://worker` + url, a streaming body (`duplex: "half"`) and a signal that `ABORT` fires.

- [ ] **Step 1: Write the failing tests**, each over `duplexPair()` from `node:stream`:
  - `round trip`: a GET with a header comes back as `{status: 201, header, JSON body}`.
  - `bounded buffering`: a 64 MiB POST body echoed back, read slowly by the test, while neither side ever has more than 2 MiB + 64 KiB queued (count bytes written to the socket minus bytes the far handler read).
  - `abort reaches the handler`: aborting the caller's signal fires the handler's `req.signal` within 100 ms; cancelling the response body does the same.
  - `socket closes`: destroying one end rejects a pending `fetch` with `WorkerGone`, and a body already streaming errors.
  - `bad frames close the mux`: a frame claiming 1 MiB of payload, and a `REQ_HEAD` with invalid JSON.
  - `both directions`: the worker side can `fetch` the root side (used by Task 8).
- [ ] **Step 2: Run** `cd server && node --import tsx --test test/worker-proto.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `worker-proto.ts`.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(agent): framed request protocol for worker processes"`.

### Task 4: File routes in one place, and the worker entry point

**Files:**
- Create: `server/src/agent-routes.ts`, `server/src/worker.ts`
- Modify: `server/src/agent.ts`, `server/src/archive-routes.ts`, `server/src/props.ts`, `server/src/search.ts`, `server/src/config.ts`
- Test: `server/test/worker-app.test.ts`

**Interfaces:**
- `agent-routes.ts`: `registerFileRoutes(app: Hono, cfg: Config, jobs: Jobs): { index: IndexCache; close(): void }`. It holds every route that touches files: `/api/mounts`, `/api/fs/*` (list, stat, read, download, text, write, upload, mkdir, symlink, rename, move, copy, trash, delete, props, perms, hash, lsdir, index-changes, index-stats, walk, search, thumb, mediainfo, transcode, zip, zip-ticket, fid), `/api/upload/*`, `/api/trash/*`, `/api/archive/list`, `/api/jobs/compress`, `/api/jobs/extract`, `/api/pdf/*`, `/api/git/*` and `/api/events`.
- `archive-routes.ts`: `makeAgentJobs(cfg: Config): Jobs` (today's construction, with the shared store when `cfg.jobsFile`), and `registerJobRoutes(app: Hono, jobs: Jobs): void` for `GET /api/jobs`, `GET /api/jobs/:id`, `POST /api/jobs/:id/cancel`, `DELETE /api/jobs/:id`. `registerArchiveRoutes(app, cfg, jobs)` no longer makes or lists jobs.
- `props.ts`: `registerSizeRoutes(app, cfg, jobs): SizeStore` (`/api/jobs/size`, `/api/du`) and `registerPropsRoutes(app, cfg, jobs): void` (`/api/fs/props`, `/api/fs/perms`).
- `Config.worker: boolean` (false from `loadConfig`). `clientKey(c, trusted: boolean)` and `clientIdentity(c, trusted: boolean)`: callers pass `!!cfg.agentToken || cfg.worker`.
- `worker.ts`:
  - `interface WorkerInit { cfg: Config; account: { kind: "sys" | "virt"; name: string; uid: number }; trashFolder: string }`
  - `createWorkerApp(cfg: Config): Hono`: `withReadOnly` and `readOnlyGuard` as in the agent, the error handler of `createAgent`, `registerFileRoutes`, and `registerJobRoutes` over an in-memory `Jobs` (`cfg.jobsFile` is empty in a worker). No `/healthz`, `/metrics`, `/api/info`, `/api/du` or `/api/jobs/size`.
  - The module's main (when run as a script): `new net.Socket({ fd: 3, readable: true, writable: true })`, a `Mux(sock, "worker", { onRequest: (r) => app.fetch(r) })`, wait for `HELLO`, build the app from `init.cfg`, send `READY`. Exit 0 when the socket ends; exit 1 on an uncaught error after writing one line to stderr.
- `createAgent` with auth off: `makeAgentJobs`, `registerFileRoutes`, `registerSizeRoutes`, `registerJobRoutes` on the same `jobs`, so the behaviour is as today.

- [ ] **Step 1: Write the failing tests** in `server/test/worker-app.test.ts`:
  - `worker app routes`: `createWorkerApp({...loadConfig({FILEDECK_ROOT: tmp}), worker: true})` answers `/api/fs/list?path=/` 200, `/api/fs/search?path=/&q=a` 200 (no socket behind the request), `/api/du` 404, `/healthz` 404.
  - `worker process`: spawn `worker.ts` (`[process.execPath, "--import", "tsx", <src/worker.ts>]`, `stdio: ["ignore","pipe","pipe","pipe"]`), wrap `child.stdio[3]` in a root `Mux`, send `HELLO`, wait for `READY`, and `GET /api/fs/stat?path=/` gives 200. Ending the socket makes the child exit with code 0 within 2 s.
- [ ] **Step 2: Run** `cd server && node --import tsx --test test/worker-app.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the split (moving code, no behaviour change) and `worker.ts`. Add `worker.ts` to the build so `dist/worker.js` exists.
- [ ] **Step 4: Run** the new test, then the whole server suite with a private `TMPDIR`: `cd server && npm test`. Expected: all PASS, no existing test changed.
- [ ] **Step 5: Commit** with `git commit -m "refactor(agent): file routes in one function; worker entry point"`.

### Task 5: Worker pool: start, reuse, limits, lifetime

**Files:**
- Create: `server/src/worker-pool.ts`
- Modify: `server/src/config.ts`
- Test: `server/test/worker-pool.test.ts`, `server/test/worker-live.test.ts`, `server/test/worker-env.ts` (helpers)

**Interfaces:**
- Consumes: `Mux`, `WorkerGone` (Task 3), `WorkerInit` (Task 4), `spawnSandboxed` options (Task 1), `LocalAccount` (Task 2).
- `Config`: `maxWorkers: number` (`FILEDECK_MAX_WORKERS`, 6), `workerIdleMs: number` (`FILEDECK_WORKER_IDLE_SECONDS`, 600 s).
- `worker-pool.ts`:
  - `interface WorkerSpec { key: string; kind: "sys" | "virt"; name: string; epoch: number; account: LocalAccount; landlock?: { readOnly: Root[]; readWrite: Root[]; readExec: Root[] }; init: WorkerInit; release?: () => void }` (`release` closes descriptor roots after the start)
  - `type StartWorker = (spec: WorkerSpec) => Promise<ChildProcess>`
  - `startWorkerProcess: StartWorker`: `spawnSandboxed(process.execPath, ["--max-old-space-size=96", ...workerEntry()], { uid, gid, groups, allowMetadata: true, allowSocketpair: true, landlock: spec.landlock ? undefined : false, readOnly, readWrite, readExec, stdio: ["ignore", "pipe", "pipe", "pipe"], keepStdio: [3], env: workerEnv(spec) })`. `workerEntry()` is `[<dist>/worker.js]`, or `["--import", "tsx", <src>/worker.ts]` when this module runs from `.ts`. `workerEnv` holds only `PATH`, `LANG`, `TZ`, `TMPDIR` (the account's tmp folder from Task 7, else `os.tmpdir()`), `HOME` (same as `TMPDIR`), `UV_THREADPOOL_SIZE=16`, `FILEDECK_SANDBOX` and `FILEDECK_SANDBOX_HELPER` when set. Each stderr line is logged as `worker <key>: <line>`.
  - Start rules: a uid change needs the launcher (`launcherAvailable()`), else 503 `{"error":"workers need filedeck-sandbox"}`; `spec.landlock` needs `sandboxInfo().state === "landlock"`, else 503 `{"error":"virtual accounts need Landlock on this machine"}`.
  - `class WorkerPool { constructor(o: { max: number; idleMs: number; start?: StartWorker; now?: () => number; log?: (s: string) => void }) }` with:
    - `fetch(spec: WorkerSpec, req: Request): Promise<Response>`: reuses the live worker for `spec.key` (one start at a time per key), else starts one and waits for `READY` (10 s, else 503). When `max` are running it stops the least recently used idle one; when none is idle it throws `PoolFull`.
    - `stopKey(key: string): Promise<void>`, `stopAccount(kind, name): Promise<void>`, `list(): { key: string; pid: number; busy: boolean; lastUsed: number }[]`, `close(): Promise<void>`
    - Stopping sends `BYE`, waits up to 5 s, then `SIGKILL`. An idle check runs every `min(idleMs, 30 s)`.
    - Busy: `mux.inFlight() > 0`, or the worker said it has live jobs (a `x-filedeck-jobs: <n>` header on every response from the worker, set by `createWorkerApp`).
  - `class PoolFull extends Error`.
- `worker-env.ts`: `testAccount(): LocalAccount` (the test's own uid, or 65534 with groups `[65534]` when the suite runs as root), `chownForTest(dir: string)` (recursive chown to that account when root), `fakeResolver(map?: Record<string, Partial<LocalAccount>>): AccountResolver`.

- [ ] **Step 1: Write the failing tests:**
  - `worker-pool.test.ts` (real worker processes, as `testAccount()`): `reuse` (two requests, one pid); `LRU` (`max: 2`, three keys in turn, the first one's process has exited); `pool full` (`max: 1`, one worker held busy by an open `/api/events` stream, a second key throws `PoolFull`); `idle` (`idleMs: 200`, the worker exits within 1 s, a new request starts a new pid); `worker killed mid-request` (`process.kill(pid, "SIGKILL")` while `/api/events` is open: the body errors; a request before the head arrives rejects with `WorkerGone`; the next request works with a new pid); `no secrets` (with `FILEDECK_AGENT_TOKEN=t0k3n` and `FILEDECK_VAULT_KEY=v4ult` in the agent's config, neither value appears in the child's `/proc/<pid>/environ`, `/proc/<pid>/cmdline`, or the JSON `init`).
  - `worker-live.test.ts` (`ROOT_ONLY`): a worker for `{uid: 1234, gid: 1234, groups: [1234, 2345]}` has, in `/proc/<pid>/status`, `Uid: 1234`, `Groups: 1234 2345`, `CapEff: 0000000000000000`, `NoNewPrivs: 1` and `Seccomp: 2`.
- [ ] **Step 2: Run** `cd server && node --import tsx --test test/worker-pool.test.ts test/worker-live.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `worker-pool.ts` and the settings.
- [ ] **Step 4: Run** the tests, and `worker-live.test.ts` again with `sudo env "PATH=$PATH" FILEDECK_REQUIRE_SANDBOX=1`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(agent): worker pool with limits, idle exit and restart"`.

### Task 6: The agent sends each signed-in request to the account's worker

**Files:**
- Create: `server/src/agent-workers.ts`
- Modify: `server/src/agent.ts` (`createAgent(cfg, auditSink?, opts?)`), `server/test/auth-agent.test.ts`, `server/test/auth-forwarding.test.ts`, `server/test/audit.test.ts` (they now pass a resolver)
- Test: `server/test/agent-workers.test.ts`

**Interfaces:**
- Consumes: `UserClaim` (part 1), `AccountResolver` (Task 2), `WorkerPool`, `WorkerSpec` (Task 5).
- `createAgent(cfg: Config, auditSink?: AuditSink, opts?: { accounts?: AccountResolver; startWorker?: StartWorker })`. With auth on it makes the resolver (`opts.accounts`, else `(await makeResolver(cfg, console.error)).resolver`, started when the agent starts and awaited by the first request that needs it) and a `WorkerPool`, closed in `app.close` and `app.leave`.
- `agent-workers.ts`:
  - `ROOT_ROUTES`: `/healthz`, `/metrics`, `/api/info`, `/api/du`, `/api/jobs/size`, and the job routes (Task 9 merges them). Part 2b adds `/api/auth/*`.
  - `workerKey(claim: UserClaim): string`: `sys:<name>`, or `virt:<name>:<first 16 hex of sha256(JSON of runAs and grants sorted by path)>`.
  - `workerGate(cfg: Config, o: { pool: WorkerPool; accounts: AccountResolver; spec: (claim: UserClaim, account: LocalAccount) => Promise<WorkerSpec> }): MiddlewareHandler`, mounted after `audit` and before the routes. Auth off: not mounted. For a path not in `ROOT_ROUTES` it resolves the local account (`claim.name` for `sys`, `claim.runAs` for `virt`; `resolve(name, true)` when no worker is running for the key), forwards the request with `authorization`, `cookie` and `x-filedeck-user` removed, and returns the worker's response.
  - Epochs: the gate keeps the highest epoch seen per `kind:name`. A higher one calls `pool.stopAccount` first. A lower one answers 401 `{"error":"account changed"}`.
  - Answers: unknown account or uid 0, 403 `{"error":"no account on this machine"}`. `PoolFull`, 503 `{"error":"too many people are using this machine; try again"}` with `Retry-After: 5`. `WorkerGone` before the head, 503 `{"error":"worker stopped"}`.

- [ ] **Step 1: Write the failing tests** in `server/test/agent-workers.test.ts`, with `fakeResolver({ alice: {}, guest: {}, toor: { uid: 0 } })` and `useSandboxOrOff()`:
  - `sys request runs in a worker`: `GET /api/fs/stat?path=/` with a `sys:alice` claim gives 200, and the pool lists key `sys:alice`.
  - `unknown and uid 0`: `sys:bob` and `sys:toor` each give 403 `no account on this machine` and start no worker.
  - `root routes stay`: `/healthz` and `/api/info` with a claim start no worker.
  - `same runAs, other grants`: two `virt` claims with `runAs: "guest"` and different grants give two keys and two pids (needs Landlock: skip with `sandbox live: skipped (...)` when the state is not `landlock`).
  - `epoch change`: a request at epoch 1, then one at epoch 2 gets another pid, and the epoch-1 pid has exited; a later epoch-1 request gives 401 `account changed`.
  - `auth off`: no pool exists (`opts.startWorker` is never called).
- [ ] **Step 2: Run** `cd server && node --import tsx --test test/agent-workers.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `agent-workers.ts` and the wiring. `spec` here builds `WorkerSpec` without Landlock or account folders (Task 7 adds them). Update the three part 1 test files to pass `{ accounts: fakeResolver(...) }` and call `useSandboxOrOff()` where they do file work as a virtual account.
- [ ] **Step 4: Run** the new test and the whole server suite. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(agent): signed-in requests run in the account's worker"`.

### Task 7: Landlock for virtual accounts, per-account folders, helpers inside workers

**Files:**
- Create: `server/src/account-dirs.ts`
- Modify: `server/src/agent-workers.ts` (the `spec` function), `server/src/diff-routes.ts` (index path from `cfg.indexDir` as given, no `node` subfolder change), `server/src/thumbs.ts` (no change expected; the test proves it)
- Test: `server/test/worker-confine.test.ts`, extend `server/test/worker-live.test.ts`

**Interfaces:**
- `account-dirs.ts`:
  - `ensureOwnedDir(p: string, uid: number, gid: number): Promise<void>`: `mkdir` (parents root-owned 0711), then `lstat` must be a real folder, then `chown` and `chmod 0700`. Refuses a link with `FsError(500, "account folder is a link")`.
  - `interface AccountDirs { tmp: string; thumbs: string; index: string }`. `accountDirs(cfg: Config, claim: UserClaim, account: LocalAccount, key: string): Promise<AccountDirs>`: `tmp` = `<os.tmpdir()>/filedeck-workers/<dir>`, `thumbs` = `<cfg.thumbDir>/u<uid>`, `index` = `<cfg.indexDir>/accounts/<dir>` (empty when `cfg.indexDir` is empty), where `dir` is `u<uid>` for `sys` and `v-<name>-<grants hash>` for `virt`. Other `v-<name>-*` index folders of the same name are removed.
  - `landlockRoots(cfg: Config, claim: UserClaim, dirs: AccountDirs): Promise<{ readOnly: Root[]; readWrite: Root[]; readExec: Root[]; release(): void }>`: each grant resolved with `resolveRead(cfg.root, g.path)` and opened with `openDir` (no link at the last step), passed as descriptor roots, `readWrite` when `g.write`; a missing grant is left out and logged. Plus `readWrite` for the three `dirs`, `readOnly` for `cfg.procMounts`, the server package folder and the `node_modules` it loads from, and `readExec` for the Node install prefix when it is outside `/usr`.
- The worker's `init.cfg`: `workerConfig(cfg, dirs)` = `cfg` with `worker: true`, `auth: false`, `agentToken`, `apiToken` and `vaultKey` undefined, `jobsFile: ""`, `fanwatch: ""`, `trashSweepMs: 0`, `thumbDir: dirs.thumbs`, `indexDir: dirs.index`.
- Helpers inside workers: no code change is expected (each rule that switches to uid 65533 or 65534 or keeps a capability already checks `process.getuid() === 0`). The tests prove it.

- [ ] **Step 1: Write the failing tests** in `server/test/worker-confine.test.ts` (Landlock needed, no root; tree under `tmp`: `/a` with a git repository, an image and text files, `/b/f.txt`, `/c/secret`), as a virtual account with grants `/a` write and `/b` read-only:
  - `grants`: write `/a/new.txt` 201; write `/b/x` fails with 403 or 500 (`EACCES`); `GET /api/fs/text?path=/c/secret` fails; listing `/` shows nothing that is not a grant path or its parent.
  - `link out of a grant`: `/a/out` linking to `../c/secret`, and `/a/up` to `/c`: reading, search with content, thumbnail, `zip` and `git status` through them all fail or show no content of `/c`.
  - `helpers inside`: `GET /api/git/status?path=/a/repo` 200; compress `/a/t.txt` into `/a` finishes; extract it into `/a/x` finishes; a thumbnail of `/a/img.png` is 200 and a file appears under `<thumbDir>/u<uid>/`.
  - `index per account`: after `GET /api/fs/lsdir?path=/a`, a database exists under `<indexDir>/accounts/v-guest1-<16 hex>/`; changing the grants and asking again uses a new folder and the old one is gone.
  - In `worker-live.test.ts` (`ROOT_ONLY`): `<thumbDir>/u1234` is owned by 1234 and mode 0700; files that a worker for uid 1234 extracts are owned by 1234.
- [ ] **Step 2: Run** `cd server && node --import tsx --test test/worker-confine.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `account-dirs.ts` and use it in `spec`. Fix whatever the tests show in the helpers' run-as rules.
- [ ] **Step 4: Run** the tests (also the root pass for `worker-live.test.ts`) and the whole suite. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(agent): Landlock for virtual accounts, per-account caches and index"`.

### Task 8: Trash per account

**Files:**
- Modify: `server/src/trash.ts`, `server/src/fsops.ts` (`trash`), `server/src/paths.ts` (folder name test), `server/src/agent-workers.ts` (the root side of the trash request), `server/src/worker.ts` (sets the scope), `server/src/account-dirs.ts` (virtual accounts' trash roots)
- Test: `server/test/trash-owners.test.ts`

**Interfaces:**
- `paths.ts`: `TRASH_OWNER = /^(u\d{1,10}|v-[a-z_][a-z0-9_.-]{0,31})$/`.
- `trash.ts`: `interface TrashScope { folder: string; ensure(volumeReal: string): Promise<string> }` and `setTrashScope(s: TrashScope | null): void` (one per process: a worker serves one account). With a scope, `trash`, `listTrash`, `restoreItems`, `deleteItems` and `emptyTrash` use `<volume>/.filedeck-trash/<folder>/`. Without one (auth off, the root process, act-as-root in 2b), `listTrash` returns the top-level items and the items of every `TRASH_OWNER` folder, the latter with ids `<folder>/<uuid>`, and the id check accepts that form. `applyRetention` covers every folder.
- Root side: the worker's `ensure` calls the root over its `Mux` (`POST /_root/trash-dir {volume}`). The root checks that `volume` is a volume root (`volumeRoot` of itself), then makes `.filedeck-trash` (mode 0711, root-owned, `lstat` checked), moves top-level legacy items into `u0/` (0700, root) the first time, and makes the account's folder with `ensureOwnedDir`. The answer is the folder's path. Requests to `/_root/*` exist only on the worker's mux, never on the HTTP app.
- A virtual account's worker gets its trash folders ahead of time: `landlockRoots` adds `readWrite` for `<volume>/.filedeck-trash/v-<name>` of each volume that holds a write grant.

- [ ] **Step 1: Write the failing tests** in `server/test/trash-owners.test.ts` (through `createAgent` with auth on and workers):
  - `own folder`: `sys:alice` trashes `/a/x`; it is under `.filedeck-trash/u<uid>/`, `.filedeck-trash` is 0711, `u<uid>` is 0700; `alice` lists and restores it.
  - `legacy items`: an item made with auth off moves to `u0/` and is not listed for `alice`.
  - `virtual accounts sharing a runAs`: `guest1` and `guest2` (`runAs: "guest"`) each trash a file; each lists only its own; `guest2` cannot restore `guest1`'s id (404).
  - `root view`: `listTrash` without a scope shows all three items with `u.../` and `v-.../` ids, and retention removes old items in every folder.
  - (`ROOT_ONLY`) `u1234` is owned by 1234.
- [ ] **Step 2: Run** `cd server && node --import tsx --test test/trash-owners.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the scope, the root route and the Landlock roots. Run `trash.test.ts`, `trash-fixes.test.ts` and `trash-retention.test.ts` to confirm auth-off behaviour is unchanged.
- [ ] **Step 4: Run** those four files and the whole suite. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(trash): one trash folder per account"`.

### Task 9: Agent jobs carry and check the account; `/api/du` follows the account

**Files:**
- Create: `server/src/agent-jobs.ts`
- Modify: `server/src/jobs.ts` (`owner` on a job), `server/src/props.ts` (`registerSizeRoutes`), `server/src/agent-routes.ts` (the `/_worker/can-list` route), `server/src/agent.ts`
- Test: `server/test/agent-jobs-auth.test.ts`, `server/test/du-auth.test.ts`

**Interfaces:**
- `jobs.ts`: `Jobs.create(..., meta?: { ...; owner?: string })`, kept in `params.owner` so the shared store and an adopted job keep it. `Jobs.ownerOf(id: string): string | undefined`.
- `agent-jobs.ts`: `registerOwnedJobRoutes(app: Hono, jobs: Jobs, o: { pool: WorkerPool; specFor: (c: Context) => Promise<WorkerSpec | null> })`, used instead of `registerJobRoutes` with auth on. The owner of a request is `<kind>:<name>` of its claim. `GET /api/jobs` lists the root process's jobs with that owner, plus the account's worker's `GET /api/jobs` when that worker is running (never starts one). `GET`, `cancel` and `DELETE` on an id: a root job with another owner answers 404 `{"error":"not found"}`, an id the root does not know goes to the worker (404 when none runs).
- Size and `du` jobs started with auth on get `owner`. Joining a live scan (`liveScan`) still works across owners, because the answer is filtered per person (below), but the job is listed only to the account that started it.
- The worker route `POST /_worker/can-list {paths: string[]}` (at most 512 virtual paths) answers `{ok: boolean[]}`; each path is `true` when `open(<real>, O_RDONLY | O_DIRECTORY)` works in the worker. Like `/_root/*`, it is served only on the mux: `workerGate` refuses any HTTP request whose path starts with `/_`.
- `registerSizeRoutes(app, cfg, jobs, o?: { canList?: (c: Context, paths: string[]) => Promise<boolean[]> })`. With `canList`: `/api/du` and `/api/jobs/size` first check the requested path (false gives 403 `{"error":"permission denied"}`); `answerTree` sends entries in batches of 256 and drops each folder entry whose path is not listable and each file entry whose parent is not.

- [ ] **Step 1: Write the failing tests:**
  - `agent-jobs-auth.test.ts`: `alice` starts a size job; `bob` does not see it in `GET /api/jobs`, and `GET`, `cancel` and `DELETE` on its id give 404; `alice` sees and cancels it. `alice` starts a compress job (in her worker); it appears in her `GET /api/jobs` and not in `bob`'s. A size job stored in a `JobStore` file and adopted by a new agent keeps `owner`.
  - `du-auth.test.ts` (Landlock): a virtual account with a grant on `/a` asks `/api/du?path=/` with depth 2: every entry is `/`, `/a` or under `/a`; `/api/du?path=/c` gives 403. (`ROOT_ONLY`) a `sys` account whose uid cannot read `/p` (mode 0700, root) gets no entry for `/p` in `/api/du?path=/`, and 403 for `path=/p`.
- [ ] **Step 2: Run** `cd server && node --import tsx --test test/agent-jobs-auth.test.ts test/du-auth.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the owner, the merged job routes, `can-list` and the filter.
- [ ] **Step 4: Run** the tests, the size-store test files (`node --import tsx --test test/size-store*.test.ts`) and the whole suite. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(agent): jobs and folder sizes follow the signed-in account"`.

### Task 10: Chart and docs for workers

**Files:**
- Modify: `k8s/values.yaml`, `k8s/templates/agents.yaml`, `k8s/templates/hub.yaml`, `docs/security.md` ("Sign-in and sessions"), `docs/configuration.md`, `docs/install.md`
- Test: `server/test/sandbox-chart-caps.test.ts` (reads the capability list; must still parse)

**Interfaces:**
- `values.yaml`: a new top-level block

  ```yaml
  auth:
    # Sign-in (FILEDECK_AUTH). Not ready to turn on until the docs say so.
    enabled: false
    workers:
      max: 6
      idleSeconds: 600
    # agent memory limit while sign-in is on (each worker adds up to about 96Mi of heap)
    agentMemoryLimit: 1Gi
  ```

- `agents.yaml`: when `auth.enabled`: env `FILEDECK_AUTH=on`, `FILEDECK_MAX_WORKERS`, `FILEDECK_WORKER_IDLE_SECONDS`; `SYS_CHROOT` added to the capability list (`{{ if $.Values.auth.enabled }}, "SYS_CHROOT"{{ end }}`); the memory limit replaced by `auth.agentMemoryLimit`; and `{{ fail "auth.enabled needs agentToken" }}` when `filedeck.agentTokenSecret` is empty (neither `agentToken.secretName` nor `agentToken.generate`). `hub.yaml`: env `FILEDECK_AUTH=on` when `auth.enabled`.

- [ ] **Step 1:** Make the chart changes. Run `helm lint k8s` and `helm template k8s --set auth.enabled=true --set agentToken.generate=true | grep -E 'FILEDECK_AUTH|SYS_CHROOT|memory: 1Gi'`. Expected: lint clean and the three lines present. Without `agentToken` the render fails with the message above. `helm template k8s` with defaults has none of them.
- [ ] **Step 2:** Run `cd server && node --import tsx --test test/sandbox-chart-caps.test.ts` (and its root pass). Expected: PASS.
- [ ] **Step 3:** Docs. `security.md`: replace the part 1 statements that agents work as root with what workers do (user, groups, capabilities, seccomp, Landlock for virtual accounts, limits, trash and index per account, `/api/du`, jobs), list the deviations above that users see (trash folder names, archive jobs after a restart), and keep "not ready to turn on" until 2b. `configuration.md`: `FILEDECK_MAX_WORKERS`, `FILEDECK_WORKER_IDLE_SECONDS`, `FILEDECK_HOST_HELPERS`. `install.md`: a "Turning sign-in on" paragraph that says the agent's memory limit rises from 512Mi to 1Gi and the agent gets `SYS_CHROOT`.
- [ ] **Step 4:** Run `npm run check:neutral`. Expected: it passes.
- [ ] **Step 5: Commit** with `git commit -m "chore(chart): sign-in values for agent workers; docs (part 2a)"`.
