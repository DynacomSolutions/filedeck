# System sign-in, act as root, streams after sign-out: implementation plan (part 2b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** System users sign in with their machine password (PAM on an agent) or an SSH key listed in their own `authorized_keys`. No name that resolves to uid 0 signs in. A system user sees only the machines where the account exists. A system administrator can act as root for 15 minutes. Event streams end when their session ends, and the web app then shows the sign-in screen.

**Architecture:** Agents get three sign-in routes in the root process (`/api/auth/password`, `/api/auth/key`, `/api/auth/lookup`), behind the agent token but before any user exists. PAM runs in a new host helper, `filedeck-pam`, started per attempt through the launcher's `chroot` like `filedeck-id` (part 2a). The key check reads `authorized_keys` as the user through the launcher. On the hub, `AgentSystemAuth` replaces `unavailableSystemAuth` and asks the agents in the sign-in order. A presence cache narrows `canUseNode`. Act-as-root is a session field that puts `asRoot` in the signed claim; the agent then serves the request in its root process as before sign-in existed. The hub tracks its proxied event streams per session and ends them at sign-out.

**Tech Stack:** Node 22, TypeScript, Hono, `node:test`; C (glibc, dynamic) with `dlopen("libpam.so.0")`; React 19.

**Spec:** `docs/superpowers/specs/2026-11-17-authentication-design.md` ("Sign-in", "Acting as root", "Accounts and identity"). Needs part 2a (`docs/superpowers/plans/2026-11-17-auth-2-agent-workers.md`): `runHostHelper` (helpers run from the image by descriptor, `--exec-outside`; nothing is copied to the host), `AccountResolver` (failures other than "unknown" reject), `workerGate` and `ROOT_ROUTES`.

**State after 2b (not released):** part 2 is complete: system users and virtual accounts sign in and work with their own rights. Accounts, grants and sessions still have no admin screens (part 3), so the docs keep `FILEDECK_AUTH` marked "not ready" and the release is board row 20.160.

## Deviations from the spec

1. **`filedeck-pam` keeps `CAP_DAC_READ_SEARCH`.** The spec says the helpers drop every capability before they touch PAM. On some distributions `/etc/shadow` has mode 0000, and `pam_unix` running as uid 0 without that capability then cannot read it (its setuid fallback, `unix_chkpwd`, does not work under no-new-privileges). The helper keeps only read-search, never write (`dac_override`), and drops `SYS_CHROOT` and all others after the `chroot`. `filedeck-id` keeps nothing.
2. **The hub cannot see every machine's accounts.** "If a machine has no account with that name, the machine is hidden": the hub learns this from each agent (`/api/auth/lookup`) and caches it for 5 minutes. A machine that did not answer stays listed, and the agent's own 403 (part 2a) is what enforces it.
3. **Act as root and jobs.** A hub job started while acting as root keeps the time the switch ends, not the switch itself: steps after that time run as the user. A long copy started as root can therefore fail part way with permission errors. The alternative (root for the whole job) would make the 15-minute limit meaningless.

## Global Constraints

- Everything new is inert unless `FILEDECK_AUTH=on`.
- A password reaches `filedeck-pam` only on its stdin pipe: never in arguments, the environment, a log line, an audit line or an error body. The helper wipes its copy (`explicit_bzero`) after `pam_end`.
- PAM service: `FILEDECK_PAM_SERVICE`, default `filedeck` (`/etc/pam.d/filedeck` on the machine). Only one password prompt; a second prompt or any `PAM_PROMPT_ECHO_ON` fails the attempt.
- A name that resolves to uid 0, on any machine asked, fails sign-in exactly like a wrong password (same 401 body, same 500 ms floor).
- `authorized_keys` is read as the user (uid, gid and groups), never as root, at most 256 KiB. A key line with options (`from=`, `command=` and any other) never matches.
- Act as root: system administrators only (`FILEDECK_ADMINS`), never virtual accounts. It needs a fresh password or key signature, lasts 15 minutes or until switched off, and every audit line made under it, on hub and agent, has `"asRoot":true`.
- The sign-in order: `FILEDECK_AUTH_NODES` (comma-separated node names), else the order of `NODES`.
- Root-only tests use `ROOT_ONLY` as in part 2a; the glibc live tests skip with `host helpers live: skipped (no glibc here)`, which `FILEDECK_REQUIRE_HOST_HELPERS=1` turns into a failure.
- Run server tests with a private `TMPDIR`. British English. No real infrastructure names in code, tests or docs.

## Review Focus

1. **A second account with uid 0** (a `toor` line in `/etc/passwd`, or a directory user with uid 0). Sign-in by password and by key must fail as for a wrong password, on every machine. Test owner: Task 3, `uid 0 never signs in`.
2. **A PAM stack that asks for a one-time code after the password.** Expect the generic `sign-in failed`, a log line naming the reason on the agent, and no hang. Test owner: Task 1, `second prompt fails`.
3. **The right key, listed with `command=` or `from=` options.** It must not sign in. Test owner: Task 2, `options make a key unusable`.
4. **Act as root ending while a hub job runs.** Calls after the end carry no `asRoot`. Test owner: Task 5, `job outlives the switch`.
5. **Sign-out in another tab while a folder's event stream is open.** The stream ends within a second and the page shows the sign-in screen without a reload. Test owners: Task 7, `sign-out ends streams` (server) and `drop asks who is signed in` (web).

---

### Task 1: `filedeck-pam` and the agent's password route

**Files:**
- Create: `server/native/host/filedeck-pam.c`, `server/src/host-pam.ts`, `server/src/agent-auth-routes.ts`
- Modify: `server/src/agent-auth.ts` (`agentUser` lets `/api/auth/` through without a user, still behind `agentAuth`), `server/src/agent-workers.ts` (`ROOT_ROUTES` gains `/api/auth/`), `server/src/agent.ts` (`opts.pam`), `server/src/config.ts` (`pamService`)
- Test: `server/test/host-pam.test.ts`, `server/test/agent-auth-routes.test.ts`

**Interfaces:**
- `filedeck-pam SERVICE NAME`: reads the password from stdin (up to 1024 bytes, ending at the first newline or end of input), refuses a name whose `getpwnam` uid is 0, `dlopen`s `libpam.so.0`, runs `pam_start`, `pam_authenticate(PAM_SILENT | PAM_DISALLOW_NULL_AUTHTOK)` and `pam_acct_mgmt(PAM_SILENT, ...)`. Exit codes: 0 good, 1 wrong password, 2 refused by the account stage, 3 more than one prompt or an echo-on prompt, 4 unknown name or uid 0, 5 PAM not usable (no library, no service file), 64 usage.
- `host-pam.ts`:
  - `type PamResult = "ok" | "fail" | "unknown" | "unavailable"`
  - `class HostPam { constructor(o: { run: (name: string, stdin: Buffer) => Promise<{ code: number | null }>; log?: (s: string) => void }); check(name: string, password: string): Promise<PamResult> }`. Maps 0 to `ok`; 1, 2 and 3 to `fail` (3 logs `pam: the service asked more than one question; only one password prompt is supported`); 4 to `unknown`; anything else or a timeout to `unavailable`. Names failing `validSystemName` give `unknown` without running anything.
  - `hostPam(cfg: Config, helpers: { root: string; dir: string }): HostPam`: `run` is `runHostHelper(root, dir, "filedeck-pam", [cfg.pamService, name], { stdin, runs as root (no `uid`), keepCaps: ["dac_read_search"], allowMetadata: true })`.
- `agent-auth-routes.ts`: `registerAgentAuthRoutes(app: Hono, o: { pam?: HostPam; keys?: KeyCheck; accounts: () => Promise<AccountResolver> })` (`KeyCheck` is Task 2). `POST /api/auth/password {name, password}` answers 200 `{result: PamResult}`; `unavailable` when there is no `pam`. Auth off: the routes do not exist.
- `Config.pamService: string` (`FILEDECK_PAM_SERVICE`, default `filedeck`).
- `createAgent` opts gain `pam?: HostPam`. With auth on and no `opts.pam`, the agent makes one from `makeResolver(...).helpers` when that is set, and logs `system sign-in: unavailable (<reason>)` otherwise.

- [ ] **Step 1: Write the failing tests:**
  - `host-pam.test.ts` (no root): a fake `run` records its arguments and stdin: the password is in stdin only, never in `name` or the arguments; each exit code maps as above; `second prompt fails` (code 3) gives `fail` and one log line that does not hold the password; a 1025-byte password is cut by the helper, not by the caller (the caller sends it as is).
  - `host-pam.test.ts` live (`ROOT_ONLY`, glibc): write `/etc/pam.d/filedeck-test-ok` (`auth required pam_permit.so` and `account required pam_permit.so`) and `/etc/pam.d/filedeck-test-deny` (`pam_deny.so`), remove them in `after`. With `pamService` set to each: `nobody` gives `ok` and `fail`; `root` gives `unknown`; a missing service gives `fail` or `unavailable` (assert not `ok`).
  - `agent-auth-routes.test.ts`: with auth on and a fake `HostPam`, `POST /api/auth/password` with the agent token and no user header answers `{result:"ok"}`; without the token it is 401; with auth off it is 404; the audit line has no `password`.
- [ ] **Step 2: Run** `cd server && node --import tsx --test test/host-pam.test.ts test/agent-auth-routes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the helper (built by the `hostbuild` stage and `build-native.mjs` from part 2a; it needs `security/pam_appl.h` from `libpam0g-dev` but links only `-ldl`), `host-pam.ts` and the route.
- [ ] **Step 4: Run** the tests, the root pass with `sudo env "PATH=$PATH" FILEDECK_REQUIRE_HOST_HELPERS=1 node --import tsx --test test/host-pam.test.ts`, and `docker build .` (the symbol check covers the new helper). Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(agent): PAM password check through the host (filedeck-pam)"`.

### Task 2: System users' SSH keys, read as the user

**Files:**
- Create: `server/src/agent-keys.ts`
- Modify: `server/src/agent-auth-routes.ts`, `server/src/agent.ts` (`opts.keys`)
- Test: `server/test/agent-keys.test.ts`

**Interfaces:**
- Consumes: `parsePublicKey`, `verifyLogin` (part 1, `auth/sshkey.ts`), `LocalAccount`, `AccountResolver` (part 2a).
- `agent-keys.ts`:
  - `readAsUser(root: string, account: LocalAccount, file: string, maxBytes: number): Promise<string | null>`: `spawnSandboxed("/bin/cat", ["--", <root + file>], { uid, gid, groups, landlock: false })`; null on a non-zero exit, a timeout (5 s) or more than `maxBytes`.
  - `keyListed(authorizedKeys: string, publicKey: string): boolean`: true when some line parses with `parsePublicKey` (lines with options never do) and its `blob` equals the given key's.
  - `class KeyCheck { constructor(o: { root: string; accounts: AccountResolver; read?: typeof readAsUser }); check(name: string, publicKey: string, message: Buffer, signature: Buffer): Promise<"ok" | "fail" | "unknown"> }`. Resolves the account (null or uid 0: `unknown`), reads `<home>/.ssh/authorized_keys` (256 KiB), then `keyListed` and `verifyLogin`.
- Route: `POST /api/auth/key {name, publicKey, message, signature}` (`message` and `signature` base64) answers 200 `{result}`.

- [ ] **Step 1: Write the failing tests** in `server/test/agent-keys.test.ts`, with Ed25519 keys made in the test as in `auth-sshkey.test.ts`:
  - `listed key`: a fake `read` returning a file with a comment line, an ECDSA line and the Ed25519 line gives `ok` for a good signature and `fail` for a signature over another name's message.
  - `options make a key unusable`: the same key with `command="x" ` and with `from="10.0.0.0/8" ` before it gives `fail`.
  - `unknown`: an unknown name and a uid-0 account give `unknown`, and `read` is never called.
  - (`ROOT_ONLY`) `read as the user`: a home under `tmp` owned by 1234 with `.ssh/authorized_keys` 0600 owned by 1234 gives `ok`; the same file owned by root with mode 0600 gives `fail` (the user cannot read it).
- [ ] **Step 2: Run** `cd server && node --import tsx --test test/agent-keys.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `agent-keys.ts` and the route.
- [ ] **Step 4: Run** the test and its root pass. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(agent): check system users' keys against their own authorized_keys"`.

### Task 3: The hub asks the agents: real `SystemAuth`, no uid 0

**Files:**
- Create: `server/src/auth/system.ts`
- Modify: `server/src/agent-auth-routes.ts` (`/api/auth/lookup`), `server/src/hub.ts` (wiring, and agent calls without a user for `/api/auth/`), `server/src/config.ts` (`authNodes`), `server/src/auth/routes.ts` (keep `unavailableSystemAuth` only for a hub with no nodes)
- Test: `server/test/auth-system.test.ts`

**Interfaces:**
- Route: `POST /api/auth/lookup {name}` answers `{exists: boolean}` (`false` for uid 0).
- `Config.authNodes: string[]` (`FILEDECK_AUTH_NODES`; empty means the order of `NODES`). An unknown name in it stops the hub at start with `FILEDECK_AUTH_NODES names an unknown node: <name>`.
- `auth/system.ts`: `class AgentSystemAuth implements SystemAuth { constructor(o: { nodes: string[]; call: (node: string, path: string, body: unknown) => Promise<Response> }) }`.
  - `password(name, pw)` and `key(name, pub, msg, sig)`: ask the nodes in order. `ok` signs in; `fail` stops with false; `unknown`, `unavailable`, a non-200 answer or an unreachable node goes on to the next. All exhausted: false.
  - `exists(node: string, name: string): Promise<boolean | undefined>` (undefined when the node does not answer within 2 s).
- `hub.ts`: `call` posts to the agent with the agent token and **no** user header (`userContext.exit`, like the open probes), JSON body, timeout 15 s. `createHub` uses `opts.system ?? new AgentSystemAuth(...)` when auth is on.

- [ ] **Step 1: Write the failing tests** in `server/test/auth-system.test.ts`: two real agents (`createAgent` with auth on, `opts.pam` and `opts.keys` fakes, `opts.accounts` a `fakeResolver`) and a hub over them (inject the agents' `fetch` the way `auth-forwarding.test.ts` does):
  - `order`: `FILEDECK_AUTH_NODES=b,a`; `alice` is unknown on `b` and good on `a`: sign-in succeeds with a `sys` session, and `b` was asked first. A wrong password on `b` (`fail`) stops: `a` is never asked.
  - `unreachable node is skipped`: `b` down, `a` good: success.
  - `uid 0 never signs in`: `toor` resolves to uid 0 on both agents: password and key sign-in each give 401 `sign-in failed` after at least 500 ms, and `/api/auth/lookup` says `exists:false`.
  - `key sign-in`: challenge, then `login-key` with a key that `opts.keys` lists gives a `sys` session.
  - `no user header on sign-in calls`: the agents saw no `x-filedeck-user` on `/api/auth/*`, and the hub's audit lines hold no password.
- [ ] **Step 2: Run** `cd server && node --import tsx --test test/auth-system.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the route, `AgentSystemAuth` and the wiring.
- [ ] **Step 4: Run** the test, `test/auth-routes.test.ts` and the whole suite. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(auth): system sign-in through the agents; uid 0 never signs in"`.

### Task 4: System users see only machines where they exist

**Files:**
- Create: `server/src/auth/presence.ts`
- Modify: `server/src/agent-auth.ts` (`canUseNode`), `server/src/hub.ts` (`mayUse`, `/api/nodes`, sign-in hook), `server/src/auth/routes.ts` (calls `onSignIn`)
- Test: `server/test/auth-presence.test.ts`

**Interfaces:**
- `auth/presence.ts`: `class SysPresence { constructor(o: { check: (node: string, name: string) => Promise<boolean | undefined>; nodes: string[]; ttlMs?: number; now?: () => number }); known(name: string, node: string): boolean | undefined; refresh(name: string, timeoutMs?: number): Promise<void> }`. `ttlMs` default 300 000; `refresh` asks every node in parallel and keeps the answers that came (undefined answers are not stored).
- `canUseNode(id: Identity | undefined, node: string, present?: (name: string, node: string) => boolean | undefined): boolean`: for `sys`, `present?.(id.name, node) !== false`; `virt` unchanged.
- `AuthDeps.onSignIn?: (kind: "sys" | "virt", name: string) => void`: the hub passes one that starts `presence.refresh(name)` without waiting.
- `/api/nodes` for a `sys` caller awaits `presence.refresh(name, 2000)` when any node is unknown or expired.

- [ ] **Step 1: Write the failing tests:** `alice` exists on `a` only: after sign-in `/api/nodes` lists `a` only, `/api/nodes/b/api/fs/list` gives 403 `no access to this machine` and `b` receives no request; with `b` down, `b` is listed (unknown) and a request to it gives 502 as today; after `ttlMs` (injected clock) the presence is asked again.
- [ ] **Step 2: Run** `cd server && node --import tsx --test test/auth-presence.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the cache and the wiring.
- [ ] **Step 4: Run** the test and `test/auth-forwarding.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(auth): system users see only the machines where their account exists"`.

### Task 5: Act as root (server)

**Files:**
- Modify: `server/src/auth/sessions.ts` (column `as_root_until`), `server/src/auth/identity.ts` (`Identity`, `UserClaim`, `claimFor`, `verifyClaim`), `server/src/auth/routes.ts` (routes, `me`), `server/src/agent-workers.ts` (root path), `server/src/agent-jobs.ts` (sees every root job), `server/src/audit.ts` (`asRoot` field)
- Test: `server/test/auth-as-root.test.ts`

**Interfaces:**
- `Sessions`: `ALTER TABLE sessions ADD COLUMN as_root_until INTEGER` when missing; `setAsRoot(raw: string, until: number | null): void`; `lookup` also returns `asRootUntil?: number`.
- `Identity` (`sys` only) gains `asRootUntil?: number`, set by the gate when the session's value is in the future and the name is in `cfg.admins`.
- `UserClaim.asRoot?: true`. `claimFor` sets it when `id.kind === "sys" && (id.asRootUntil ?? 0) > now`. `verifyClaim` rejects `asRoot` that is not `true`, or on a `virt` claim.
- Hub routes:
  - `POST /api/auth/as-root` with `{password}` or `{publicKey, challenge, signature}`: a `virt` account or a `sys` name not in `cfg.admins` gets 403 `{"error":"only system administrators can act as root"}`. The proof is checked with `system.password` or with `challenges.take` and `system.key`, under the login limiter and the 500 ms floor; a failure answers 401 `sign-in failed`. Success sets `until = now + 15 min` and answers `{asRootUntil}`.
  - `DELETE /api/auth/as-root` clears it. `GET /api/auth/me` adds `asRootUntil` when set and in the future.
- Agent: a claim with `asRoot` skips `workerGate` (the request runs in the root process as with auth off), and `registerOwnedJobRoutes` shows it every root job.
- Audit: hub and agent lines made with `asRoot` have `"asRoot":true`; others have no such field.
- Hub jobs: the stored owner keeps `asRootUntil`, so a job's calls carry `asRoot` only until that time.

- [ ] **Step 1: Write the failing tests** in `server/test/auth-as-root.test.ts` (hub and agent, fake `SystemAuth` and resolver, injected clock):
  - `admins only`: a `virt` admin and a `sys` non-admin get 403; a wrong password gives 401 after at least 500 ms.
  - `root for 15 minutes`: after `POST /api/auth/as-root`, `GET /api/auth/me` has `asRootUntil`; an agent request runs without a worker (the pool stays empty) and reads a file mode 0600 owned by root (`ROOT_ONLY` part); at `until + 1` ms the next request goes to the worker again; `DELETE` ends it at once.
  - `audit`: lines under the switch have `"asRoot":true` on hub and agent; lines before it have none.
  - `forged asRoot`: a claim with `asRoot` for a `virt` account fails `verifyClaim`.
  - `job outlives the switch`: a copy job started under the switch: calls before `until` carry `asRoot`, calls after it do not.
- [ ] **Step 2: Run** `cd server && node --import tsx --test test/auth-as-root.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the column, identity fields, routes, the agent path and the audit field.
- [ ] **Step 4: Run** the test, `test/auth-*.test.ts` and the whole suite. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(auth): system administrators can act as root for 15 minutes"`.

### Task 6: Act as root (web)

**Files:**
- Create: `web/src/AsRootDialog.tsx`, `web/src/AsRootBanner.tsx`
- Modify: `web/src/auth.ts`, `web/src/AccountMenu.tsx`, `web/src/App.tsx` (banner in `site-header__inner`), `web/test/browser/acceptance.mjs`
- Test: `web/test/auth.test.ts`

**Interfaces:**
- `auth.ts`: `me()` result gains `asRootUntil?: number`; `startAsRoot(proof: { password: string } | { keyText: string; passphrase?: string; name: string }): Promise<{ asRootUntil: number }>` (the key path reuses `signLogin` and a fresh challenge); `stopAsRoot(): Promise<void>`.
- `AccountMenu`: an "Act as root…" item only for `kind === "sys" && admin`, which opens `AsRootDialog` (password or key file, the same fields and messages as `SignIn`).
- `AsRootBanner`: shown while `asRootUntil > Date.now()`: the text `Acting as root until HH:MM` and a "Stop" button; it hides itself at the time (one timer) and on "Stop".

- [ ] **Step 1: Write the failing tests** in `web/test/auth.test.ts`: `startAsRoot` posts the password body; the key path asks for a challenge first; `stopAsRoot` sends `DELETE`. In `acceptance.mjs`: a fixture where `me` answers a `sys` admin with `asRootUntil` 10 minutes ahead shows the banner; axe passes on it and on the open dialog in light and dark; no overflow at 390x844 and 320x568.
- [ ] **Step 2: Run** `npm test -w web`. Expected: FAIL.
- [ ] **Step 3: Implement** the components with the existing dialog, button and banner styles.
- [ ] **Step 4: Run** `npm test -w web`, `npm run typecheck` and the browser acceptance run (Chromium and Firefox, as its README says). Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(web): act as root from the account menu, with a header banner"`.

### Task 7: Event streams end with their session

**Files:**
- Create: `server/src/auth/streams.ts`
- Modify: `server/src/auth/sessions.ts` (`peek`, `onEnd`), `server/src/auth/routes.ts` (the gate stores the session key; logout ends its streams), `server/src/hub.ts` (the proxy wraps event streams), `web/src/eventStream.ts`
- Test: `server/test/auth-streams.test.ts`, `web/test/eventStream.test.ts`

**Interfaces:**
- `Sessions.keyOf(raw: string): string` (the stored SHA-256 hex), `Sessions.peek(key: string): boolean` (valid now, does not slide `last_used`), `Sessions.onEnd(fn: (e: { key?: string; kind?: "sys" | "virt"; name?: string }) => void): void`, called by `destroy` (with `key`) and `endAll` (with `kind` and `name`).
- `auth/streams.ts`: `class LiveStreams { constructor(o: { peek: (key: string) => boolean; checkMs?: number }); track(key: string, kind: "sys" | "virt", name: string, res: Response): Response; endSession(key: string): void; endAccount(kind, name): void; size(): number; close(): void }`. `track` returns a response whose body ends (closes) when told to, or when a check every `checkMs` (default 60 s) finds `peek(key)` false.
- Hub proxy: with auth on, a response whose `content-type` starts with `text/event-stream` goes through `track`. `onEnd` is wired to `endSession` and `endAccount`.
- `createChangeHub` option `onDrop?: () => void`, called when an `EventSource` reports an error without data (a dropped connection, which is also what a 401 looks like to `EventSource`), at most once per 10 s. `changeHub()` passes `() => void fetch("/api/auth/me")`; the signed-out watch from part 1 then shows the sign-in screen.

- [ ] **Step 1: Write the failing tests:**
  - `auth-streams.test.ts`: `sign-out ends streams`: open `/api/nodes/a/api/events?path=/` with a session, log out with the same cookie: the stream's body ends within 1 s, and a new request with the old cookie gets 401 with the signed-out header. `endAll` for the account ends its streams and leaves another account's stream open. A session that expires (injected clock and `checkMs: 50`) ends its stream.
  - `web/test/eventStream.test.ts`: `drop asks who is signed in`: an error without data calls `onDrop` once, two errors within 10 s call it once, and an `error` event with data does not call it.
- [ ] **Step 2: Run** `cd server && node --import tsx --test test/auth-streams.test.ts` and `npm test -w web`. Expected: FAIL.
- [ ] **Step 3: Implement** `LiveStreams`, the session hooks, the proxy wrap and `onDrop`.
- [ ] **Step 4: Run** both, then the whole server suite. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(auth): event streams end with their session; the page notices"`.

### Task 8: Chart sign-in values and docs (part 2)

**Files:**
- Modify: `k8s/values.yaml` (`auth` block), `k8s/templates/hub.yaml`, `k8s/templates/agents.yaml`, `docs/security.md`, `docs/configuration.md`, `docs/install.md`

**Interfaces:**
- `values.yaml`, added under `auth`:

  ```yaml
    # System user names that are administrators (FILEDECK_ADMINS)
    admins: []
    # Machines asked to check system sign-ins, in order (FILEDECK_AUTH_NODES); empty = the order of `nodes`
    authNodes: []
    # PAM service on the machines (FILEDECK_PAM_SERVICE); install /etc/pam.d/<service> yourself
    pamService: filedeck
    # First virtual administrator: a Secret holding {"name": ..., "passwordHash": ...} under `key` (FILEDECK_BOOTSTRAP_ADMIN_FILE)
    bootstrapAdmin: {secretName: "", key: admin.json}
    session: {idleSeconds: 28800, maxSeconds: 604800}
    # Account the `filedeck du` token acts as (FILEDECK_API_TOKEN_ACCOUNT)
    apiTokenAccount: ""
  ```

- `hub.yaml`: the matching env when `auth.enabled`, the bootstrap Secret mounted read-only at `/var/run/filedeck/bootstrap` with `FILEDECK_BOOTSTRAP_ADMIN_FILE` pointing at it. `agents.yaml`: `FILEDECK_PAM_SERVICE`.

- [ ] **Step 1:** Make the chart changes. Run `helm lint k8s` and `helm template k8s --set auth.enabled=true --set agentToken.generate=true --set 'auth.admins={alice}' | grep -E 'FILEDECK_(ADMINS|PAM_SERVICE|SESSION_IDLE_SECONDS)'`. Expected: lint clean and all three present.
- [ ] **Step 2:** Docs. `security.md` "Sign-in and sessions": system sign-in (PAM through the host with the chroot helper, one prompt, the kept read-search capability and why, keys read as the user, options refused), uid 0 refused everywhere, machines hidden where the account does not exist (and the 5-minute cache), act as root (who, how long, audit, jobs), event streams ending at sign-out; remove the "not in part 1" items now done. `configuration.md`: `FILEDECK_AUTH_NODES`, `FILEDECK_PAM_SERVICE`. `install.md`: an example `/etc/pam.d/filedeck` that includes the machine's normal `auth` and `account` stacks (one for the Debian layout with `@include common-auth` and `@include common-account`, one for the Red Hat layout with `auth include system-auth` and `account include system-auth`), and that the machine needs glibc for system sign-in. Keep "not ready to turn on" until part 3.
- [ ] **Step 3:** Run `npm run check:neutral`. Expected: it passes.
- [ ] **Step 4:** Commit with `git commit -m "docs(auth): system sign-in, act as root and chart values (part 2)"`.
