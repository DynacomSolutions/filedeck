# Sign-in and sessions at the hub: implementation plan (part 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With `FILEDECK_AUTH=on`, the hub admits nobody without a session. Virtual accounts sign in with a password or an SSH key file. Every request a hub makes to an agent carries a signed statement of who is asking, and agents refuse requests without one.

**Architecture:** The new folder `server/src/auth/` holds the identity type and the signed header (shared by hub and agent), an SQLite store for accounts and sessions, the SSH key check, the login limiter, and the hub routes and gate. Each hub request runs inside an `AsyncLocalStorage` that holds the caller's `Identity`. `withAgentToken` reads it to add `x-filedeck-user` for the target node, and hub jobs store their owner and run inside that owner's context. The web app gets a sign-in screen and an account menu. In this part agents still do all file work as root (part 2 adds per-user workers and PAM), so the docs mark `FILEDECK_AUTH` as not ready to turn on, and this part is not released on its own.

**Tech Stack:** Node 22, TypeScript, Hono, `node:sqlite`, `node:crypto` (scrypt, HMAC, Ed25519 and ECDSA verify), `node:test`; React 19 and WebCrypto in the web app; `bcrypt-pbkdf` (already in the lockfile through `ssh2`) for encrypted key files.

**Spec:** `docs/superpowers/specs/2026-11-17-authentication-design.md`. This plan covers "Order of work" step 1, plus jobs carrying their owner, which step 1 needs so that jobs keep working once agents demand the header. Part 2 covers the workers, PAM, `filedeck-id`, system-user key sign-in, act-as-root, trash, the compare index, the `du` filtering and the chart. Part 3 covers the admin API and screens, and grants on network sources.

## Global Constraints

- Everything new is inert unless `FILEDECK_AUTH=on`. With it off, every existing test passes unchanged and no response changes, except that `GET /api/auth/me` answers `{"auth":false}`.
- With auth on: the agent refuses to start without `FILEDECK_AGENT_TOKEN`, and so does the hub.
- A password, private key, signature, session id, challenge or header MAC never appears in a log line, an audit line, a URL or an error body.
- Cookie: `__Host-filedeck`, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, value 32 random bytes as base64url. The store keeps only its SHA-256.
- Session idle timeout default 8 hours (`FILEDECK_SESSION_IDLE_SECONDS`), absolute lifetime 7 days (`FILEDECK_SESSION_MAX_SECONDS`).
- Challenge: 32 random bytes, valid 60 seconds, one use, bound to the name.
- Signed user header: valid 60 seconds after `iat`. Refused if `iat` is more than 5 seconds in the future.
- Login limits: 5 failures per minute per name and per client address. After that, a block of `2^(failures-5)` seconds, capped at 15 minutes. Answer 429 with `Retry-After`.
- Every failed sign-in gives `{"error":"sign-in failed"}` with status 401, and no failed attempt answers sooner than 500 ms after it arrived.
- Sign-in is refused on plain HTTP (403 `{"error":"sign-in needs HTTPS"}`), except when the socket peer is a loopback address. HTTPS means the request URL is `https:`, or `FILEDECK_TRUSTED_PROXIES > 0` and the last `X-Forwarded-Proto` value is `https`.
- Virtual account names match `^[a-z_][a-z0-9_.-]{0,31}$`. `root` is refused.
- Files follow the repo's British English prose and comment style. New docs go in `docs/configuration.md` and `docs/security.md`, not the README.

## Review Focus

1. **A 401 that is not about sign-in.** Agents already answer 401 for "password_required" on encrypted archives. The web app must not take that for "signed out", and the signed-out signal must not swallow the archive password prompt. Test owner: Task 8, `signedOut` only reacts to the `x-filedeck-auth: signed-out` header.
2. **A job started before a restart, resumed after it.** A job that `JobStore` brings back must run as its stored owner, not as nobody and not as the first person to make a request. Test owner: Task 6, `resumed job keeps its owner`.
3. **A request for a node the account has no grant on**, including through `/api/transfer`, `/api/ops`, and `/api/diff/jobs` naming that node. Expect 403, never a forwarded request. Test owner: Task 6, `no grant, no forwarding`.
4. **A client that sends its own `x-filedeck-user`**, to the hub (it must be dropped) or straight to an agent (it must fail the MAC check). Test owners: Task 6 `client copy dropped` and Task 7 `forged or stale header refused`.
5. **The `du` token with auth on and no `FILEDECK_API_TOKEN_ACCOUNT`.** It must be refused with 403 and a message naming the setting, not let through with no identity. Test owner: Task 5, `du token needs an account`.

---

### Task 1: Identity type, signed user header, auth settings

**Files:**
- Create: `server/src/auth/identity.ts`
- Modify: `server/src/config.ts` (the `Config` interface and `loadConfig`)
- Modify: `server/src/main.ts` (start-up refusal)
- Test: `server/test/auth-identity.test.ts`

**Interfaces:**
- Produces, in `auth/identity.ts`:
  - `interface Grant { path: string; write: boolean }`
  - `interface NodeAccess { runAs: string; grants: Grant[] }`
  - `type Identity = { kind: "sys"; name: string; admin: boolean; epoch: number } | { kind: "virt"; name: string; admin: boolean; epoch: number; nodes: Record<string, NodeAccess> }`
  - `interface UserClaim { kind: "sys" | "virt"; name: string; epoch: number; runAs?: string; grants?: Grant[]; iat: number }`
  - `claimFor(id: Identity, node: string, now: number): UserClaim | null`. Returns null for a virtual account with no entry for `node`. For `sys` it has no `runAs` or `grants`.
  - `signClaim(claim: UserClaim, agentToken: string): string`. The value is `base64url(JSON) + "." + base64url(HMAC-SHA256(key, base64url(JSON)))`, with `key = hkdfSync("sha256", agentToken, "", "filedeck-user-header-v1", 32)`.
  - `verifyClaim(value: string, agentToken: string, now: number): UserClaim | null`. Uses `timingSafeEqual`, then checks `now - iat <= 60_000` and `iat - now <= 5_000`.
  - `USER_HEADER = "x-filedeck-user"`
- Produces, on `Config`: `auth: boolean`, `admins: string[]`, `bootstrapAdminFile: string | undefined`, `authFile: string`, `sessionIdleMs: number`, `sessionMaxMs: number`, `apiTokenAccount: string | undefined`.

- [ ] **Step 1: Write the failing tests** in `server/test/auth-identity.test.ts`:
  - `round trip`: `verifyClaim(signClaim(c, T), T, c.iat)` deep-equals `c`.
  - `wrong token`: verifying with another token gives `null`.
  - `tampered payload`: changing one character of the JSON part gives `null`.
  - `stale and future`: `now = iat + 60_001` gives `null`, `now = iat + 60_000` gives the claim, and `now = iat - 5_001` gives `null`.
  - `claimFor virt without node is null`, and `claimFor virt` copies `runAs` and `grants` for that node only.
  - `config`: `loadConfig({FILEDECK_AUTH:"on", FILEDECK_ADMINS:"alice, bob"})` gives `auth === true`, `admins` deep-equals `["alice","bob"]`, `sessionIdleMs === 8*3600_000` and `sessionMaxMs === 7*86400_000`. `loadConfig({})` gives `auth === false`. `authFile` is `path.join(dirname(FILEDECK_VAULT_FILE), "auth.sqlite")` when `FILEDECK_VAULT_FILE` is set, else `":memory:"`. `FILEDECK_AUTH_FILE` overrides it.
- [ ] **Step 2: Run** `cd server && node --import tsx --test test/auth-identity.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `auth/identity.ts` and the config fields. Read `FILEDECK_BOOTSTRAP_ADMIN_FILE` and `FILEDECK_API_TOKEN_ACCOUNT` as plain values. In `main.ts`, before `createHub` or `createAgent`: if `cfg.auth && !cfg.agentToken`, print `FILEDECK_AUTH=on needs FILEDECK_AGENT_TOKEN` and exit with code 2.
- [ ] **Step 4: Run** the same command. Expected: PASS. Then run `npm run typecheck -w server`. Expected: no errors.
- [ ] **Step 5: Commit** with `git commit -m "feat(auth): identity, signed user header, settings"`.

### Task 2: Account store

**Files:**
- Create: `server/src/auth/store.ts`
- Modify: `server/src/cli.ts` (adds `filedeck hash-password`)
- Test: `server/test/auth-store.test.ts`

**Interfaces:**
- Consumes: `Identity`, `NodeAccess` (Task 1).
- Produces, in `auth/store.ts`:
  - `class AuthDb { constructor(file: string); readonly db: DatabaseSync; readonly hubId: string; close(): void }`. It opens the file with the vault's pragmas (WAL, `busy_timeout` 5000), mode 0600, and its folder 0700. It creates the tables `meta(hub_id)`, `accounts`, `account_keys` and `sys_users` (name, epoch). `hubId` is 16 random bytes as hex, made once and kept in the file.
  - `hashPassword(pw: string): string`. Format: `scrypt$15$8$1$<salt b64>$<hash b64>`, salt 16 bytes, key 32 bytes, `maxmem` 64 MiB.
  - `checkPassword(pw: string, stored: string | null): boolean`. With `stored === null` it hashes against a fixed dummy so the time is the same, then returns false.
  - `class Accounts { constructor(db: AuthDb) }` with these methods:
    - `create(a: { name: string; password?: string; passwordHash?: string; admin: boolean; nodes: Record<string, NodeAccess> }): void`. It throws `AccountError("invalid name")` on a bad name or `root`, and `AccountError("exists")` on a duplicate.
    - `get(name: string): { name; admin; epoch; nodes; passwordHash: string | null } | undefined`
    - `addKey(name: string, publicKeyLine: string): void` and `keys(name: string): string[]`
    - `bumpEpoch(kind: "sys" | "virt", name: string): number`
    - `epochOf(kind: "sys" | "virt", name: string): number`. For `sys` it creates the `sys_users` row at 0 on first use.
    - `identity(kind: "virt", name: string): Identity | undefined`
  - `bootstrapAdmin(acc: Accounts, file: string | undefined): void`. The file is JSON `{ "name": string, "passwordHash": string }`. It creates the admin, with `admin: true` and `nodes: {}`, only if that name does not exist. It never changes an existing account.
- CLI: `filedeck hash-password` reads a password from stdin (one line, no echo when stdin is a TTY) and prints `hashPassword(...)`.

- [ ] **Step 1: Write the failing tests:**
  - `hash and check`: `checkPassword("pw", hashPassword("pw"))` is true. A wrong password is false. `checkPassword("x", null)` is false.
  - `names`: `create` with `"Root"`, `"root"`, `"a b"` and `"x".repeat(33)` each throws `invalid name`. `"guest1"` works. A second `"guest1"` throws `exists`.
  - `epoch`: `bumpEpoch("virt","guest1")` returns 1, then 2. `epochOf("sys","alice")` is 0, then 1 after `bumpEpoch("sys","alice")`.
  - `hubId stable`: reopening the same file gives the same `hubId`.
  - `bootstrap`: a file with name `admin` creates an admin. Running it again after `bumpEpoch` leaves the epoch unchanged.
  - `file mode`: on a real temp file, `statSync(file).mode & 0o777 === 0o600`.
- [ ] **Step 2: Run** `node --import tsx --test test/auth-store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `AuthDb`, `Accounts`, the hashing and `bootstrapAdmin`. Store `nodes` as JSON text. Add the `hash-password` branch to `cli.ts` beside `du`, and update `USAGE`.
- [ ] **Step 4: Run** the tests and `npm run typecheck -w server`. Expected: PASS, clean.
- [ ] **Step 5: Commit** with `git commit -m "feat(auth): account store, scrypt hashes, bootstrap admin"`.

### Task 3: Session store

**Files:**
- Create: `server/src/auth/sessions.ts`
- Test: `server/test/auth-sessions.test.ts`

**Interfaces:**
- Consumes: `AuthDb`, `Accounts.epochOf` (Task 2).
- Produces: `class Sessions { constructor(db: AuthDb, acc: Accounts, o: { idleMs: number; maxMs: number; now?: () => number }) }` with these methods:
  - `create(kind: "sys" | "virt", name: string): string`. Returns the raw cookie value and stores only its SHA-256 hex with kind, name, `created`, `last_used` and the account's current epoch.
  - `lookup(raw: string): { kind; name } | undefined`. It returns undefined when the session is past idle or max, or when the account's epoch is now higher than the stored one, and deletes the row in those cases. It writes `last_used` at most once per 60 seconds.
  - `destroy(raw: string): void`
  - `endAll(kind, name): void`. Bumps the epoch and deletes that account's rows.

- [ ] **Step 1: Write the failing tests**, using an injected `now`:
  - `lookup after create` gives the account.
  - `idle`: at `now + idleMs + 1` the session is gone. A lookup at `now + idleMs - 1` slides it.
  - `max`: sliding lookups every hour still end at `created + maxMs`.
  - `endAll` makes an earlier session fail, and a session created after it works.
  - `stored hash only`: `SELECT * FROM sessions` holds no column equal to the raw value.
- [ ] **Step 2: Run** `node --import tsx --test test/auth-sessions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `Sessions`.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(auth): sessions with idle and absolute expiry"`.

### Task 4: SSH key check and challenges

**Files:**
- Create: `server/src/auth/sshkey.ts`
- Test: `server/test/auth-sshkey.test.ts`

**Interfaces:**
- Produces:
  - `parsePublicKey(line: string): { type: "ssh-ed25519" | "ecdsa-sha2-nistp256"; key: KeyObject; blob: Buffer } | null`. Reads an `authorized_keys`-style line. A line with options before the type, or any other type, gives null.
  - `loginMessage(hubId: string, name: string, challenge: Buffer): Buffer`. The SSH-wire concatenation of four `string` fields (uint32 big-endian length, then bytes): `"filedeck-login-v1"`, `hubId`, `name`, `challenge`. The web app builds the same bytes (Task 8).
  - `verifyLogin(pub: ReturnType<typeof parsePublicKey>, msg: Buffer, sig: Buffer): boolean`. Ed25519 uses `crypto.verify(null, ...)`. ECDSA uses `crypto.verify("sha256", msg, { key, dsaEncoding: "ieee-p1363" }, sig)`, matching what WebCrypto produces.
  - `class Challenges { issue(name: string): Buffer; take(name: string, c: Buffer): boolean }`. Each challenge is good for 60 s and one use. Keep at most 10,000 outstanding, dropping the oldest first.

- [ ] **Step 1: Write the failing tests.** Generate keys with `generateKeyPairSync("ed25519")` and `("ec", {namedCurve:"P-256"})`, and write the public half as an OpenSSH line (build the wire blob in the test helper).
  - `ed25519 good`: a signature over `loginMessage` verifies.
  - `ecdsa good`: sign with `dsaEncoding:"ieee-p1363"` and it verifies.
  - `wrong name`: a signature over a message for another name fails.
  - `options refused`: `'command="x" ssh-ed25519 AAAA...'` gives null. So does `ssh-rsa`.
  - `challenge once`: `take` is true, then false. After 60,001 ms it is false (inject the clock).
- [ ] **Step 2: Run** `node --import tsx --test test/auth-sshkey.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `sshkey.ts`. For ECDSA, build a JWK from the 65-byte uncompressed point. For Ed25519, use a JWK with `crv:"Ed25519"`.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(auth): SSH key login check and challenges"`.

### Task 5: Sign-in routes and the gate on the hub

**Files:**
- Create: `server/src/auth/limiter.ts`, `server/src/auth/routes.ts`, `server/src/auth/context.ts`
- Modify: `server/src/hub.ts` (wiring, after `apiTokenAuth`), `server/src/api-token.ts` (identity for the token)
- Test: `server/test/auth-routes.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 4.
- Produces:
  - In `auth/context.ts`: `const userContext: AsyncLocalStorage<Identity>`, `currentUser(): Identity | undefined`, and `runAs<T>(id: Identity, fn: () => T): T`.
  - In `auth/limiter.ts`: `class LoginLimiter { constructor(now?: () => number); check(name: string, ip: string): { ok: true } | { ok: false; retryAfterMs: number }; fail(name: string, ip: string): void; succeed(name: string): void }`
  - `interface SystemAuth { password(name: string, pw: string): Promise<boolean>; key(name: string, pub: string, msg: Buffer, sig: Buffer): Promise<boolean> }`. In this part `createHub` passes `unavailableSystemAuth`, whose methods resolve false. Part 2 supplies the real one.
  - `registerAuth(app: Hono, deps: { cfg: Config; db: AuthDb; accounts: Accounts; sessions: Sessions; challenges: Challenges; limiter: LoginLimiter; system: SystemAuth })` adds these routes:
    - `GET /api/auth/me` returns `{auth:false}` when auth is off. With auth on it returns `{auth:true, kind, name, admin}`, or 401 with the signed-out header.
    - `POST /api/auth/login` `{name, password}`: a virtual account is checked by `checkPassword`. Any other name goes to `system.password`.
    - `POST /api/auth/challenge` `{name}` returns `{challenge: b64, hubId}`. It always answers 200, also for an unknown name.
    - `POST /api/auth/login-key` `{name, publicKey, challenge, signature}`: a virtual account must have `publicKey` among its keys. Any other name goes to `system.key`.
    - `POST /api/auth/logout` destroys the session and clears the cookie.
  - The gate middleware (inside `registerAuth`, auth on only). It allows `/healthz`, `GET` of the SPA shell and `/assets/*`, `/favicon.svg`, and the five auth routes. For every other request it needs a valid session cookie or a token identity. Without one it answers 401 `{"error":"signed out"}` with the header `x-filedeck-auth: signed-out`. With one it calls `runAs(identity, next)`.
  - Admin flag: a `sys` identity is admin when its name is in `cfg.admins`. A `virt` identity uses the stored flag.
  - `api-token.ts`: when auth is on and the token matches, run `next` inside `runAs` for `cfg.apiTokenAccount` (resolved as virtual if it exists, else system). If that setting is unset, answer 403 `{"error":"FILEDECK_API_TOKEN_ACCOUNT is not set"}`.

- [ ] **Step 1: Write the failing tests**, using `createHub(loadConfig({...FILEDECK_AUTH:"on", FILEDECK_AGENT_TOKEN, FILEDECK_STATIC: tmp, NODES}))` and `app.request`, seeding accounts through the hub's `AuthDb`. Expose it as `app.auth` for tests, as `app.vault` is exposed today.
  - `auth off`: `GET /api/auth/me` gives `{auth:false}`, and `/api/nodes` is 200 with no cookie.
  - `gate`: with auth on, `/api/nodes` is 401 with the header `x-filedeck-auth: signed-out`. `/healthz` and `/` are 200.
  - `password sign-in`: a correct password sets a cookie that matches `^__Host-filedeck=[A-Za-z0-9_-]{43}; .*HttpOnly.*Secure.*SameSite=Lax`, and `/api/auth/me` with it gives the name. Sign-in comes from `http://localhost` with the loopback peer simulated. Use `env: { incoming: { socket: { remoteAddress: "127.0.0.1" } } }` in `app.request` the way `clientOf` reads it, or an HTTPS URL.
  - `uniform failure`: a wrong password, an unknown name and a system name (unavailable) each give 401 `{"error":"sign-in failed"}`, each taking at least 500 ms.
  - `https required`: `http://files.example/api/auth/login` from peer `10.0.0.5` gives 403 `sign-in needs HTTPS`. With `FILEDECK_TRUSTED_PROXIES=1` and `X-Forwarded-Proto: https` it is accepted.
  - `limiter`: 5 bad attempts then a good one gives 429 with `Retry-After`. With an injected clock 2 s later it works. `succeed` resets the name.
  - `key sign-in`: challenge, sign in the test with an Ed25519 key that was added to the account, and `login-key` gives a cookie. Reusing the same challenge gives 401.
  - `logout`: after it, the old cookie gives 401.
  - `du token needs an account`: with `FILEDECK_API_TOKEN` set and no `FILEDECK_API_TOKEN_ACCOUNT`, `GET /api/nodes/t/api/du` with `X-Filedeck-Token` gives 403 with that message.
  - `no secrets in audit`: capture the audit sink during a failed and a good login, and no line contains the password or the cookie value.
- [ ] **Step 2: Run** `node --import tsx --test test/auth-routes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `limiter.ts`, `context.ts` and `routes.ts`, and wire them in `createHub`: open `AuthDb(cfg.authFile)`, call `bootstrapAdmin`, `registerAuth` right after `apiTokenAuth`, and close the db in `app.close`. Hold failed answers to the 500 ms floor with a `setTimeout` measured from the start of the request.
- [ ] **Step 4: Run** the new tests and then the whole server suite, `npm test`, with a private `TMPDIR` (see the repo's local test notes). Expected: all PASS, and no existing test changed.
- [ ] **Step 5: Commit** with `git commit -m "feat(auth): sign-in routes, sessions cookie and gate on the hub"`.

### Task 6: Identity on every hub-to-agent call, and job owners

**Files:**
- Modify: `server/src/agent-auth.ts` (`withAgentToken`), `server/src/hub.ts` (`/api/nodes` filtering, the proxy, `/api/transfer`, the hop list), `server/src/ops-queue.ts`, `server/src/ops-routes.ts`, `server/src/job-store.ts`, `server/src/diff-hub.ts`, `server/src/vault-proxy.ts` (only if it builds its own headers)
- Test: `server/test/auth-forwarding.test.ts`

**Interfaces:**
- Consumes: `currentUser`, `runAs` (Task 5), and `claimFor` and `signClaim` (Task 1).
- Produces:
  - `withAgentToken(init, token, node: string)`. When `currentUser()` is set it also sets `x-filedeck-user` to `signClaim(claimFor(id, node, Date.now()), token)`. When `claimFor` is null it throws `NoAccessError` (exported), which the proxy, transfer, ops and diff routes turn into 403 `{"error":"no access to this machine"}` before anything is sent. The `agents` map passes the node name.
  - `canUseNode(id: Identity | undefined, node: string): boolean`. True for `sys` (part 2 narrows this to machines where the account exists), and for `virt` only when `node in id.nodes`. Network sources stay open to every signed-in account until part 3 adds source grants. That is stated in the docs as a temporary limit of this part.
  - `GET /api/nodes` lists only nodes for which `canUseNode` is true.
  - `"x-filedeck-user"` is added to the hub's `HOP` set, so a client's copy is never forwarded.
  - Jobs: `OpQueue.create(spec, owner?: Identity)`. The owner is stored in `JobRow.owner` as JSON (a new nullable column `owner TEXT`, added with `ALTER TABLE ... ADD COLUMN` when it is missing). `exec(j)` runs inside `runAs(j.owner)` when an owner is set. List and get routes show only jobs whose owner has the caller's kind and name, or every job for an admin. Diff jobs in `diff-hub.ts` get the same owner field, run under `runAs`, and are filtered the same way. A job with no owner (auth off) behaves as today.

- [ ] **Step 1: Write the failing tests.** A real agent (`createAgent`) with a small handler that records the `x-filedeck-user` header it receives (wrap `app.fetch`), and a hub with auth on.
  - `header per node`: a signed-in virtual account with access to `A` lists `A`, and the agent gets a header that `verifyClaim` accepts, with `name`, `runAs` and `grants` for `A`.
  - `no grant, no forwarding`: the same account asking for node `B` through the proxy, `POST /api/transfer` and `POST /api/ops` gets 403, and agent `B` records no request.
  - `client copy dropped`: a client sending `x-filedeck-user: forged` still gets the agent the hub's own signed value.
  - `job owner`: a copy job started by `guest1` sends `guest1`'s header on every agent call, and `GET /api/ops` as another account does not list it.
  - `resumed job keeps its owner`: create a job with a `JobStore` file, close the queue mid-job (`interrupt`), start a new hub on the same file, and the resumed calls carry the original owner's header.
- [ ] **Step 2: Run** `node --import tsx --test test/auth-forwarding.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the changes above. Every `Target.fetch` for an agent goes through `withAgentToken`, so a call made outside any user context with auth on is a bug. Add an assertion that throws `"agent call without an identity"` when `cfg.auth` is set and `currentUser()` is undefined, so a missed path fails loudly in tests.
- [ ] **Step 4: Run** the new tests and the whole server suite. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(auth): signed identity on hub-to-agent calls, job owners"`.

### Task 7: The agent checks the header; the audit names the account

**Files:**
- Modify: `server/src/agent-auth.ts` (new `agentUser` middleware), `server/src/agent.ts` (wiring), `server/src/audit.ts` (the `user` field), `server/src/hub.ts` (passes the user to the audit)
- Test: `server/test/auth-agent.test.ts`; extend `server/test/audit.test.ts`

**Interfaces:**
- Consumes: `verifyClaim` and `USER_HEADER` (Task 1), and `currentUser` (Task 5).
- Produces:
  - `agentUser(cfg: Config): MiddlewareHandler`, mounted right after `agentAuth`. It is off when `!cfg.auth`. Otherwise `/healthz` and `/metrics` pass, and any other request without a valid claim gets 401 `{"error":"no user"}`. A valid claim is stored with `c.set("user", claim)`.
  - In the audit lines: `user: "sys:<name>"` or `"virt:<name>"`. The hub takes it from `currentUser()` and the agent from `c.get("user")`. The field is left out when there is no user.

- [ ] **Step 1: Write the failing tests:**
  - `forged or stale header refused`: an agent with auth on gives 401 for no header, for a header signed with another token, and for one with `iat` 61 s old. It gives 200 for a fresh one.
  - `auth off unchanged`: an agent without `FILEDECK_AUTH` ignores the header entirely.
  - `audit user`: a state-changing request through a hub with auth on writes `"user":"virt:guest1"` on both the hub line and the agent line.
- [ ] **Step 2: Run** `node --import tsx --test test/auth-agent.test.ts test/audit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the middleware and the audit field.
- [ ] **Step 4: Run** those tests and the whole server suite. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(auth): agents demand a signed user; audit names the account"`.

### Task 8: Sign-in screen, key files and account menu (web)

**Files:**
- Create: `web/src/auth.ts` (API calls and the signed-out signal), `web/src/sshkey.ts` (key file parsing and signing), `web/src/SignIn.tsx`, `web/src/AccountMenu.tsx`
- Modify: `web/src/main.tsx` (wraps `fetch` and gates `App`), `web/src/App.tsx` (the account menu in `site-header__inner`), `web/package.json` (adds `bcrypt-pbkdf`), `web/test/browser/acceptance.mjs` (fixtures for `/api/auth/me` and sign-in checks)
- Test: `web/test/sshkey.test.ts`, `web/test/auth.test.ts`

**Interfaces:**
- Consumes: the routes from Task 5, and the `loginMessage` byte layout from Task 4.
- Produces:
  - `web/src/sshkey.ts`:
    - `parsePrivateKey(text: string): { encrypted: boolean; type: "ssh-ed25519" | "ecdsa-sha2-nistp256"; publicLine: string }`. It throws `KeyFileError` with one of the messages `"not an OpenSSH private key"`, `"RSA keys are not supported yet"` or `"key type not supported"`.
    - `signLogin(text: string, passphrase: string | undefined, hubId: string, name: string, challenge: Uint8Array): Promise<{ publicKey: string; signature: Uint8Array }>`. Decryption uses `bcrypt-pbkdf` and AES-256-CTR through WebCrypto. A wrong passphrase throws `KeyFileError("wrong passphrase")`, detected by the two check integers. Ed25519 signs with WebCrypto `Ed25519` after building a PKCS#8 from the seed. ECDSA builds a JWK from the private scalar and point.
  - `web/src/auth.ts`: `me(): Promise<{auth:false} | {auth:true; kind; name; admin}>`, `login(name, password)`, `loginKey(name, file text, passphrase?)`, `logout()`, and `installSignedOutWatch(onSignedOut: () => void)`, which wraps `window.fetch` and calls `onSignedOut` only when a response has `x-filedeck-auth: signed-out`.
  - `SignIn`: a form with name, a tab or toggle between "Password" and "Key file" (a file input reading the text locally, and a passphrase field shown only for an encrypted key), and one error line. It shows the server's message for 401 ("Sign-in failed"), 429 ("Too many attempts. Try again in N seconds") and 403 (shown as given). It uses the existing dialog and input styles, and meets the WCAG checks the acceptance run applies.
  - `AccountMenu`: the name, then "Sign out". It is shown only when `me().auth` is true.
  - `main.tsx`: renders `App` when `me()` gives `{auth:false}` or a signed-in account. Otherwise it renders `SignIn`, and after sign-in it reloads the page. `installSignedOutWatch` switches to `SignIn`.

- [ ] **Step 1: Write the failing tests.** Fixture keys are made once with `ssh-keygen -t ed25519` and `-t ecdsa -b 256`, each unencrypted and with passphrase `pw`, and stored as strings in `web/test/fixtures/keys.ts`. Each fixture has a comment saying it is a test key.
  - `parse`: each fixture gives the right `type`, `encrypted` and a `publicLine` equal to the matching `.pub` line. An RSA key throws `RSA keys are not supported yet`.
  - `sign verifies on the server side`: `signLogin(...)` output verifies with `node:crypto` in the test, using the same calls as the server's `verifyLogin`: Ed25519 with `crypto.verify(null, ...)`, ECDSA with `dsaEncoding: "ieee-p1363"`. The message is built in the test with the four-field layout from Task 4. Check both types, plain and encrypted. The web package does not import server code.
  - `wrong passphrase` throws `wrong passphrase`.
  - `signed-out watch`: a 401 without the header (archive password) does not call `onSignedOut`, and a 401 with it does.
- [ ] **Step 2: Run** `npm test -w web`. Expected: FAIL.
- [ ] **Step 3: Implement** the modules and components. In `acceptance.mjs`, answer `/api/auth/me` with `{auth:false}` by default, and add one check that loads the app with `me` answering 401 plus the signed-out header. That check expects the sign-in form, runs axe on it in light and dark, and checks no overflow at 390x844 and 320x568.
- [ ] **Step 4: Run** `npm test -w web`, `npm run typecheck`, and the browser acceptance run as its README says (Chromium and Firefox). Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(auth): sign-in screen with password and key file, account menu"`.

### Task 9: Docs and board

**Files:**
- Modify: `docs/configuration.md` (a new "Sign-in (not finished)" paragraph covering every new setting from Task 1, `FILEDECK_TRUSTED_PROXIES` and `X-Forwarded-Proto`, and the `hash-password` command), `docs/security.md` (a new "Sign-in and sessions" section: cookie, challenge, signed header, limits, what part 1 does not do yet), `TASKS.md` (epic 20 rows)

- [ ] **Step 1:** Write both docs in the repo's plain style. State clearly that with `FILEDECK_AUTH=on` agents still work as root until part 2, and that network sources are open to every signed-in account until part 3.
- [ ] **Step 2:** Run `npm run check:neutral`. Expected: it passes.
- [ ] **Step 3:** Commit with `git commit -m "docs(auth): sign-in settings and security notes (part 1)"`.
