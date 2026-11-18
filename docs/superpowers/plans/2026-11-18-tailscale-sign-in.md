# Tailscale sign-in: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person on a tailnet device signs in with one click, as the virtual account or system user that an administrator linked to their tailnet login. The identity comes from tailscaled's LocalAPI socket or from the Tailscale Serve identity headers, only through listed proxies. The session is a normal session bound to that identity. Administrators link logins in the Accounts view. Nothing changes with sign-in off.

**Architecture:** A new hub module, `auth/tailnet.ts`, is the only reader of the two sources: it checks the TCP peer against `FILEDECK_TAILSCALE_PROXIES`, then reads the headers or asks `/localapi/v0/whois` for the last `X-Forwarded-For` entry (10-second cache per address), and strips the `Tailscale-User-*` headers from every request. Links live in a new auth database table, `tailnet_links`, written by the admin routes in the same store transaction as the other account fields, followed by `accountChanged`. `POST /api/auth/login-tailscale` signs in; the session stores `method`, `tailnet_login` and `tailnet_node`, and the gate checks that binding on every request. A linked system user is vouched for by the agents' existing lookup route in the sign-in order (`AgentSystemAuth.vouch`). The web app gets a button on the sign-in page and a "Tailscale" section in the account editor and the System users tab. The chart gets an optional tailscaled sidecar.

**Tech Stack:** Node 22, TypeScript, Hono, `node:sqlite`, `node:test`, `node:http` over a unix socket; React 19, Playwright and axe-core for the browser checks; Helm.

**Spec:** `docs/superpowers/specs/2026-11-18-tailscale-sign-in-design.md` (decisions 1 to 9, "Identity sources", "Routes", "Sessions", "Admin API and screens", "Audit", "Configuration and chart", "Threats"). Builds on v0.4.0 (`docs/superpowers/plans/2026-11-17-auth-*.md`, all done). Board row 20.163.

**State before this plan:** sign-in methods are password and key only (`server/src/auth/routes.ts`). `sessions` has `address` and `as_root_until` but no method. Nothing reads `Tailscale-User-*` headers, and nothing talks to tailscaled. `AgentSystemAuth` has `password`, `key` and `exists`; the agent's `/api/auth/lookup` already answers `{exists:false, refused:true}` for uid 0, gid 0 or group 0. `AccountView` and `SystemView` have no links. The chart has no sidecar.

## Global Constraints

- Everything new is inert unless `FILEDECK_AUTH=on`. With it off: the Tailscale settings give one log line if set and are not used; `/api/auth/tailnet` and `/api/auth/login-tailscale` do not exist; no header is stripped; `GET /api/auth/me` answers `{"auth":false}`; the existing tests pass unchanged.
- A tailnet identity exists only for a request whose TCP peer (`getConnInfo`, never a header) is in `FILEDECK_TAILSCALE_PROXIES`. `FILEDECK_TRUSTED_PROXIES` never decides it.
- The socket is used when set; otherwise the headers when on. No fallback from an unavailable socket to the headers.
- Tagged devices are refused. No tag links: `tag:*` and `tagged-devices` are refused as logins.
- Logins: trimmed, lowercased, `` ^[a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*$ ``, at most 254 characters. At most 16 per account. A login is linked to at most one account (409 otherwise).
- Every link change raises the account epoch in the store transaction and runs `accountChanged` after the commit.
- Act as root keeps needing a password or a key. `lockOut` does not count links.
- Failed Tailscale sign-ins answer 401 `{"error":"sign-in failed"}` after the 500 ms floor, under the sign-in limiter (name key `tailnet:<login>`).
- No log line, audit line or error body holds a socket path, a raw whois answer or a cookie. Logins may appear (they are not secrets).
- Run server tests with a private `TMPDIR` (a folder only you can change). British English. No real infrastructure names in code, tests, docs or chart defaults; `npm run check:neutral` passes.

## Review Focus

1. **A client that sends `Tailscale-User-Login` from a peer that is not listed**, also with `FILEDECK_TRUSTED_PROXIES` above 0 and a forged `X-Forwarded-For`. It must get no identity, and the header must not reach any route. Test owner: Task 1 `spoofed headers`, Task 3 `spoof through the gate`.
2. **The socket fails while the headers source is also on.** The hub must answer 503, never read the headers. Test owner: Task 1 `no fallback`.
3. **A linked system user that is root on the first machine and an ordinary user on the second.** Sign-in must fail. Test owner: Task 3 `refused stops the search`.
4. **Two administrators linking the same login to two accounts at the same moment.** Exactly one must succeed; the other gets 409. Test owner: Task 4 `same login, at once`.
5. **A Tailscale session used from a request with another login or device, or with none.** Other login or device: the session ends. None: 401 and the session stays. Test owner: Task 3 `binding`.

---

### Task 1: Identity sources: proxies, headers, LocalAPI whois

**Files:**
- Create: `server/src/auth/tailnet.ts`
- Modify: `server/src/config.ts` (`tailscaleSocket`, `tailscaleHeaders`, `tailscaleProxies`), `server/src/main.ts` (start-up lines and the refusal when a source is on without proxies)
- Test: `server/test/auth-tailnet.test.ts`, `server/test/config.test.ts` (add; create it if the config checks live elsewhere)

**Interfaces:**
- `config.ts`: `tailscaleSocket: string | undefined` (`FILEDECK_TAILSCALE_SOCKET`), `tailscaleHeaders: boolean` (`FILEDECK_TAILSCALE_HEADERS === "on"`), `tailscaleProxies: string[]` (`FILEDECK_TAILSCALE_PROXIES`, comma separated, each an IP or CIDR; an entry that is not one throws `FILEDECK_TAILSCALE_PROXIES: "<entry>" is not an IP address or range`).
- `tailnet.ts`:
  - `type TailnetIdentity = { login: string; displayName?: string; node?: { name: string; stableId: string }; address?: string; source: "socket" | "headers" }`
  - `type TailnetAnswer = TailnetIdentity | { none: true; tagged?: true } | { unavailable: true }`
  - `cleanLogin(v: string): string | null`: the login rule of the Global Constraints; null for `tagged-devices`, `tag:*` and anything that fails.
  - `class ProxyList { constructor(entries: string[]); has(ip: string): boolean }` (IPv4, IPv6, IPv4-mapped IPv6 through `plainAddress`, zone ids removed).
  - `class TailnetSource { constructor(o: { socket?: string; headers: boolean; proxies: ProxyList; timeoutMs?: number; cacheMs?: number; maxCache?: number; now?: () => number; log?: (s: string) => void }); readonly mode: "socket" | "headers" | null; identify(c: Context): Promise<TailnetAnswer> }`. Reads the request headers itself; never throws.
  - `stripTailnetHeaders(): MiddlewareHandler`: reads nothing, deletes every `tailscale-user-*` header from the request seen by later middleware and routes. The hub mounts it after `TailnetSource` has had its chance (Task 3 reads the identity first and keeps it on the context as `tailnet`).
  - whois: `GET /localapi/v0/whois?addr=<address>` with `Host: local-tailscaled.sock` over `socketPath`, at most 8 at once, `timeoutMs` default 2000, cache per address `cacheMs` default 10000 and `maxCache` default 1024 (oldest out first). The address is the last `X-Forwarded-For` entry through `hopAddress`; outside `100.64.0.0/10` and `fd7a:115c:a1e0::/48` it is `none` without a call. 404: `none`. Tags non-empty or `UserProfile.LoginName === "tagged-devices"`: `{none, tagged}`. Other failures: `unavailable`, with one log line at most once a minute (`tailnet: the tailscaled socket did not answer (<reason>)`, never the path).
  - headers: `Tailscale-User-Login` once (twice or more: `none`), through `cleanLogin`; `Tailscale-User-Name` decoded from RFC 2047 (`=?utf-8?q?…?=`, `=?utf-8?b?…?=`), control and format characters dropped, 128 characters at most.

- [ ] **Step 0: Check a real `tailscale serve`** (not committed as a test): run tailscaled in userspace mode with `tailscale serve --https=443 http://127.0.0.1:<port>` in front of a small server that prints request headers; call it from a user-owned tailnet device and from a tagged one, with a forged `Tailscale-User-Login` and `X-Forwarded-For`. Record in the task's commit message body: whether `X-Forwarded-For` ends with the device's tailnet address, whether `X-Forwarded-Proto: https` is sent, whether the forged identity header is removed, and that the tagged device gets no identity header. If `X-Forwarded-For` or the header removal is not as the spec assumes, stop and report to Thomas before going on.
- [ ] **Step 1: Write the failing tests** in `server/test/auth-tailnet.test.ts` (a fake LocalAPI: an `http.createServer` on a unix socket in the private `TMPDIR`; requests built with a fake `getConnInfo` peer through `app.request` with an `env.incoming.socket.remoteAddress`, as the existing auth tests do):
  - `cleanLogin`: `" Alice@GitHub "` gives `alice@github`; `alice@example.com` and `bob@passkey` pass; `tagged-devices`, `tag:server`, `alice`, `@github`, `alice@`, `alice@exa mple`, a 255-character login and one with a newline give null.
  - `proxy list`: `127.0.0.1/32,::1/128` has `127.0.0.1`, `::1` and `::ffff:127.0.0.1`, not `10.0.0.1`; `10.1.0.0/16` has `10.1.2.3`; a bad entry throws in `config`.
  - `headers`: peer `127.0.0.1` listed and `Tailscale-User-Login: Alice@GitHub`, `Tailscale-User-Name: =?utf-8?q?Al=C3=AFce?=` give `{login:"alice@github", displayName:"Alïce", source:"headers"}`; the header twice gives `none`.
  - `spoofed headers`: peer `192.0.2.9` (not listed) with the login header gives `none`, also with `FILEDECK_TRUSTED_PROXIES` 1 and `X-Forwarded-For: 127.0.0.1`.
  - `socket`: peer listed, `X-Forwarded-For: 198.51.100.4, 100.101.102.103`: the fake LocalAPI is asked for `addr=100.101.102.103` with `Host: local-tailscaled.sock` and its answer gives login, display name, node name and stable id, `address` and `source:"socket"`; a second request within 10 s makes no call; after 10 s (injected clock) it asks again.
  - `socket refusals`: an address outside the tailnet ranges makes no call and gives `none`; a 404 gives `none`; an answer with `Node.Tags: ["tag:ci"]` gives `{none, tagged}`; a peer that is not listed makes no call.
  - `no fallback`: socket set to a path with no server, headers on, the login header from a listed peer: `unavailable`; one log line in two calls within a minute; the line has no socket path.
  - `timeout`: a fake LocalAPI that never answers gives `unavailable` within 2.5 s.
  - `strip`: after `stripTailnetHeaders`, a route sees no `tailscale-user-login` header.
- [ ] **Step 2: Run** `cd server && TMPDIR=<private> node --import tsx --test test/auth-tailnet.test.ts test/config.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the config fields, `tailnet.ts` and the start-up rules in `main.ts`: with `FILEDECK_AUTH` off and a Tailscale setting set, one line `tailscale: sign-in is off, so FILEDECK_TAILSCALE_* is ignored`; with a source on and no proxies, stop with the spec's message; with both sources set, one line that the headers setting is ignored.
- [ ] **Step 4: Run** the same tests. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(auth): read a tailnet identity from listed proxies, by headers or tailscaled's whois"`.

### Task 2: Link store and login checks

**Files:**
- Create: `server/src/auth/tailnet-links.ts`
- Modify: `server/src/auth/account-input.ts` (`tailnetLogin`, `tailnetLogins`, `MAX_TAILNET_LOGINS`)
- Test: `server/test/auth-tailnet-links.test.ts`, `server/test/auth-account-input.test.ts` (add)

**Interfaces:**
- `tailnet-links.ts`: table `tailnet_links (login TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL)` with index `(kind, name)`.
  - `type LinkKind = "sys" | "virt"`
  - `class TailnetLinks { constructor(db: AuthDb, now?: () => number); owner(login: string): { kind: LinkKind; name: string } | undefined; forAccount(kind, name): string[] (sorted); setForAccount(kind, name, logins: string[]): void; accounts(kind): string[]; removeAccount(kind, name): void }`.
  - `setForAccount` replaces the account's rows in one transaction or a savepoint of the caller's (`inTransaction`), keeps `created` of a login it keeps, and throws `LinkTaken { login, kind, name }` when a login belongs to another account (the primary key decides, so two writers cannot both win).
- `account-input.ts`: `MAX_TAILNET_LOGINS = 16`; `tailnetLogin(v: unknown): string` (`cleanLogin`, else `InputError("tailnet login must look like name@domain, for example alice@github; tagged devices cannot be linked")`); `tailnetLogins(v: unknown): string[]` (a list, each cleaned, duplicates merged, at most 16).
- `store.ts` is not changed: the admin routes call `removeAccount` inside their delete transaction (Task 4).

- [ ] **Step 1: Write the failing tests:**
  - `auth-tailnet-links.test.ts`: `setForAccount("virt","guest",["alice@github","bob@example.com"])` then `owner("alice@github")` is `{kind:"virt",name:"guest"}` and `forAccount` is sorted; `setForAccount("sys","guest",["alice@github"])` throws `LinkTaken` naming `virt:guest` and changes nothing; `setForAccount("virt","guest",[])` removes both; `created` of a kept login does not change on a second set; `accounts("sys")` lists only names with rows; inside an outer `accounts.tx` that throws after `setForAccount`, nothing is kept.
  - `auth-account-input.test.ts`: `tailnetLogin(" Alice@GitHub ")` is `alice@github`; `tag:ci`, `tagged-devices`, `alice`, `5` and a 255-character login throw; `tailnetLogins` merges `["a@x","A@X"]` into one and throws for 17 logins and for a value that is not a list.
- [ ] **Step 2: Run** `cd server && TMPDIR=<private> node --import tsx --test test/auth-tailnet-links.test.ts test/auth-account-input.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `TailnetLinks` and the input checks.
- [ ] **Step 4: Run** the same tests and `test/auth-store.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(auth): store tailnet logins linked to accounts, one account per login"`.

### Task 3: Sign in with Tailscale; sessions bound to the tailnet identity; audit

**Files:**
- Modify: `server/src/auth/routes.ts` (`GET /api/auth/tailnet`, `POST /api/auth/login-tailscale`, the binding in the gate, `me` gives `method` and `tailnet`), `server/src/auth/sessions.ts` (columns and fields), `server/src/auth/system.ts` (`vouch`), `server/src/hub.ts` (build `TailnetSource` and `TailnetLinks`, mount the identity reader and `stripTailnetHeaders`, pass them to `registerAuth`), `server/src/audit.ts` (`tailnet` field)
- Test: `server/test/auth-tailnet-signin.test.ts`, `server/test/auth-system.test.ts` (add), `server/test/auth-sessions.test.ts` (add), `server/test/audit.test.ts` (add)

**Interfaces:**
- `sessions.ts`: columns `method TEXT`, `tailnet_login TEXT`, `tailnet_node TEXT`, added with `ALTER TABLE` when missing. `create(kind, name, address?, how?: { method: "password" | "key" | "tailscale"; tailnetLogin?: string; tailnetNode?: string })`. `lookup` returns `method?`, `tailnetLogin?`, `tailnetNode?`. `SessionInfo` gains `method?` and `tailnet?` (the login).
- `system.ts`: `AgentSystemAuth.vouch(name: string): Promise<boolean>`: `/api/auth/lookup` in the sign-in order under `TOTAL_MS`; `exists:true` is yes; `refused:true` ends with no; `exists:false`, non-200, a bad body or no answer go on; none: no. `SystemAuth` gains `vouch` (`unavailableSystemAuth.vouch` answers false).
- `routes.ts`:
  - `AuthDeps` gains `tailnet?: TailnetSource` and `links?: TailnetLinks`.
  - The identity is read once per request, before `stripTailnetHeaders` runs, and kept as `c.get("tailnet")` (`TailnetAnswer | undefined`); with no source it is never read.
  - `GET /api/auth/tailnet` (in `AUTH_ROUTES`): `{login, displayName?, node?: {name}}`, `{tagged:true}`, `{}`, or 503 `{"error":"tailnet identity unavailable"}`.
  - `POST /api/auth/login-tailscale` (in `AUTH_ROUTES`): `secure()` else 403 `sign-in needs HTTPS`; the limiter with name `tailnet:<login>` (or `tailnet:` when there is none) and the client address; unavailable: 503 (no floor, not counted as a failure); `none`, tagged, unlinked, `root`, or a system user `vouch` refuses: 401 `sign-in failed` after the floor; a virtual account that no longer exists: the same. Success: `signIn` with `{method:"tailscale", tailnetLogin, tailnetNode: node?.stableId}`, then `onSignIn` (presence refresh for a system user). `signIn` of the password and key routes passes `method: "password"` and `"key"`.
  - The gate, for a session with `method = "tailscale"`: same login (and, when the session has `tailnet_node`, the same `node.stableId`): admit; another login or node: `sessions.destroy` and 401 signed out; `none`: 401 signed out, session kept; `unavailable`: 503 `{"error":"tailnet identity unavailable"}`, session kept. Sessions without the method are not checked.
  - `GET /api/auth/me`: adds `method` (when known) and `tailnet` (the login) for a Tailscale session.
- `audit.ts`: a line gets `tailnet: {login, source, node?, address?}` when the context has a `tailnet` identity and the route is `/api/auth/login-tailscale` or the request was admitted with a Tailscale session (`{login, source}` only there); `{tagged: true}` for a tagged attempt.

- [ ] **Step 1: Write the failing tests** in `server/test/auth-tailnet-signin.test.ts` (a hub with auth on, `FILEDECK_TAILSCALE_HEADERS=on`, `FILEDECK_TAILSCALE_PROXIES=127.0.0.1/32`, `FILEDECK_TRUSTED_PROXIES=1`, `X-Forwarded-Proto: https`, a fake `SystemAuth`, and the same cases again with a fake LocalAPI socket):
  - `button data`: `GET /api/auth/tailnet` from the listed peer with a login gives the login; from another peer `{}`; a tagged device (socket) `{tagged:true}`; with no source configured `{}` and no socket call.
  - `virtual account`: `guest` linked to `alice@github`: `POST /api/auth/login-tailscale` sets `__Host-filedeck`; `me` gives `kind:"virt"`, `name:"guest"`, `method:"tailscale"`, `tailnet:"alice@github"`.
  - `unlinked and tagged`: an unlinked login, a tagged device and no identity each give 401 `sign-in failed` no sooner than 500 ms; the sixth failure in a minute for one login gives 429.
  - `system user`: `alice` (sys) linked to `alice@github`, `vouch` true: signed in as `sys:alice`, the presence refresh started; `vouch` false: 401. A link to `root` cannot exist (Task 4), and a hand-written row for `root` still gives 401 without a `vouch` call.
  - `needs HTTPS`: no `X-Forwarded-Proto`: 403 `sign-in needs HTTPS`.
  - `binding`: after a Tailscale sign-in, a request with the same login is admitted; one with `bob@github` gets 401 signed out and the session is gone (a later request with `alice@github` is 401 too); one with no identity (another peer, same cookie) gets 401 and a later request with `alice@github` is admitted; socket source: the same address answering with another `StableID` ends the session; socket unavailable: 503 and the session stays.
  - `spoof through the gate`: a password session of `guest` (no method) is not affected by any tailnet header; a peer that is not listed sends `Tailscale-User-Login: alice@github` to `login-tailscale`: 401; no route handler sees the header (a test route echoes request headers).
  - `link change ends sessions`: removing the link (store write plus `accountChanged`) makes the next request 401.
  - `as root`: a system administrator signed in with Tailscale: `POST /api/auth/as-root` with no proof is 401, with the right password (fake PAM) turns it on.
  - `auth off`: with `FILEDECK_AUTH` unset and the Tailscale settings set, `GET /api/auth/tailnet` and `POST /api/auth/login-tailscale` are not auth routes (`/api/auth/me` still `{"auth":false}`), and a request header `Tailscale-User-Login` reaches a test route unchanged.
  - `auth-system.test.ts`: `refused stops the search`: node A answers `{exists:false, refused:true}`, node B `{exists:true}`: `vouch` is false and B is not asked; A `{exists:false}`, B `{exists:true}`: true; A unreachable, B true: true; all false: false.
  - `auth-sessions.test.ts`: a session made with `{method:"tailscale", tailnetLogin:"alice@github", tailnetNode:"n1"}` comes back from `lookup` and `list` with them; an old database without the columns opens and gets them.
  - `audit.test.ts`: the `login-tailscale` line has `tailnet: {login, source:"headers"}`; a request of a Tailscale session has `tailnet: {login, source}`; a password session's lines have no `tailnet`; no line holds the socket path.
- [ ] **Step 2: Run** `cd server && TMPDIR=<private> node --import tsx --test test/auth-tailnet-signin.test.ts test/auth-system.test.ts test/auth-sessions.test.ts test/audit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the columns, `vouch`, the two routes, the binding, the wiring in `hub.ts` (identity read after `trustProxies` and before `requestGuard`; `stripTailnetHeaders` right after it) and the audit field.
- [ ] **Step 4: Run** the same tests, `test/auth-routes.test.ts`, `test/auth-as-root.test.ts` and the whole server suite with the private `TMPDIR`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(auth): sign in with Tailscale; sessions bound to the tailnet login; audit"`.

### Task 4: Admin API: link and unlink tailnet logins

**Files:**
- Modify: `server/src/auth/admin-routes.ts` (views, `tailnet` in POST and PATCH, `PUT /api/admin/system/:name/tailnet`, overview, delete removes links), `server/src/hub.ts` (pass `links` and `tailscale` mode), `server/src/audit.ts` (`adminBody` keeps `tailnet` and `logins`)
- Test: `server/test/auth-admin-tailnet.test.ts`, `server/test/audit.test.ts` (add)

**Interfaces:**
- `AdminDeps` gains `links: TailnetLinks` and `tailscale: "socket" | "headers" | null`.
- `AccountView.tailnet: string[]`, `SystemView.tailnet: string[]`; `GET /api/admin/accounts` lists system users that have links; `GET /api/admin/overview` gains `tailscale`.
- `POST /api/admin/accounts` and `PATCH /api/admin/accounts/:name` take `tailnet` (`tailnetLogins`); inside `accounts.tx`: `links.setForAccount("virt", name, list)`; `LinkTaken` becomes `Refused(409, "this tailnet login is linked to <kind>:<name>")`; PATCH raises the epoch as it does now and runs `changed` after the commit. A PATCH with only `tailnet` is a valid change.
- `PUT /api/admin/system/:name/tailnet {logins}`: `systemName` (never `root`); when the list is not empty, ask `systemExists` on every machine (2 s): at least one answer and none `true` gives 400 `no machine has a system user <name>`; then in `accounts.tx`: `callerHolds`, `links.setForAccount("sys", …)`, `bumpEpoch("sys", name)`; `changed` after; answers `systemView`.
- `DELETE /api/admin/accounts/:name` calls `links.removeAccount("virt", name)` inside its transaction.
- `lockOut` is not changed.
- `adminBody`: `tailnet` and `logins` as lists of clipped strings (at most 16).

- [ ] **Step 1: Write the failing tests** in `server/test/auth-admin-tailnet.test.ts` (a hub with auth on and a virtual administrator, as `auth-admin-accounts.test.ts` does):
  - `link a virtual account`: `PATCH /api/admin/accounts/guest {tailnet:["Alice@GitHub"]}` answers `tailnet:["alice@github"]`; the epoch rose; `accountChanged` ran once with the identity from before; `guest`'s password session is now 401.
  - `create with links`: `POST /api/admin/accounts` with `tailnet:["bob@github"]` and no password: 201, `hasPassword:false`, `tailnet:["bob@github"]`.
  - `duplicate`: linking `alice@github` to `other` while `guest` has it: 409 `this tailnet login is linked to virt:guest`, and nothing of that PATCH is written (the admin flag in the same body did not change).
  - `same login, at once`: two PATCH calls for two accounts with the same login, sent together: one 200, one 409; the table holds one row.
  - `bad logins`: `tag:ci`, `tagged-devices`, `alice`, 17 logins: 400; the message names the field and the rule.
  - `system user`: `PUT /api/admin/system/alice/tailnet {logins:["alice@github"]}` with fake machines `{a:true}`: 200 and `GET /api/admin/accounts` lists `alice` under `system` with `tailnet`; machines `{a:false, b:undefined}`: 400 `no machine has a system user alice`; machines all `undefined`: 200; `root`: 400; `alice`'s sessions end (epoch).
  - `delete removes links`: deleting `guest` frees `alice@github`, and a new account `guest` has `tailnet: []`.
  - `lock-out ignores links`: with `FILEDECK_ADMINS` empty and one virtual administrator with a password and a link, `PATCH {password:null}` is 409 `this would leave no administrator who can sign in`.
  - `overview`: `tailscale` is `"headers"` with the headers source, `"socket"` with a socket, `null` with none.
  - `audit.test.ts`: an admin line for `PATCH {tailnet:["alice@github"]}` keeps `tailnet:["alice@github"]`; a `PUT …/tailnet` line keeps `logins`.
- [ ] **Step 2: Run** `cd server && TMPDIR=<private> node --import tsx --test test/auth-admin-tailnet.test.ts test/audit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the view fields, the route changes, the new route, the delete change and `adminBody`.
- [ ] **Step 4: Run** the same tests, `test/auth-admin.test.ts`, `test/auth-admin-accounts.test.ts` and the whole server suite. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(auth): administrators link tailnet logins to virtual accounts and system users"`.

### Task 5: Sign-in page: "Sign in with Tailscale"

**Files:**
- Modify: `web/src/auth.ts` (`tailnet()`, `loginTailscale()`, `Account.method`, `Account.tailnet`), `web/src/SignIn.tsx` (the button), `web/src/AccountMenu.tsx` (the method line), `web/test/browser/acceptance.mjs` (extend `verifySignIn`)
- Test: `web/test/auth.test.ts` (add)

**Interfaces:**
- `auth.ts`: `type Tailnet = { login: string; displayName?: string; node?: string } | { tagged: true } | { unavailable: true } | null`; `tailnet(): Promise<Tailnet>` (`GET /api/auth/tailnet`, literal URL; 503 gives `{unavailable:true}`; any other failure gives null); `loginTailscale(): Promise<Account>` (`POST /api/auth/login-tailscale` with `{}`, through `reach` and `signedIn`; a 401 message is replaced by "Tailscale sign-in failed. Your tailnet login may not be linked to an account here; ask an administrator."). `whoFrom` keeps `method` and `tailnet` when they are strings.
- `SignIn.tsx`: asks `tailnet()` once on mount. With a login: a section above the form with a button "Sign in with Tailscale" and the text "as <login>" (and the device name when known), then a divider "or". It is never pressed for the person: no automatic sign-in, focus stays on the name field. With `{tagged}`: a note "This device is tagged in the tailnet; tagged devices cannot sign in with Tailscale." With `{unavailable}`: a note "Tailscale sign-in is not available now." With null: nothing. The button shares `useProofFields`' busy and error state, so the error shows in the same alert.
- `AccountMenu.tsx`: for a Tailscale session, a line "Signed in with Tailscale as <login>".

- [ ] **Step 1: Write the failing tests:**
  - `web/test/auth.test.ts` (fake `fetch`): `tailnet()` sends `GET /api/auth/tailnet` and returns the login; 503 gives `{unavailable:true}`; `{}` gives null; `loginTailscale()` sends `POST /api/auth/login-tailscale` with body `{}` and JSON content type; a 401 throws `SignInError` with the Tailscale text; `me()` keeps `method:"tailscale"` and `tailnet`.
  - `acceptance.mjs`, "Sign in" check: the fake hub answers `GET /api/auth/tailnet` with `{login:"alice@github"}`: the button shows the login, and no request to `login-tailscale` is made before the click; the click sends one POST and the app loads; with `{tagged:true}` the note shows and there is no button; with `{}` the page is as before; a 401 shows the Tailscale text in the alert; axe passes in light and dark; no horizontal overflow at 1365x900, 390x844 and 320x568; the account menu of a Tailscale session shows the method line.
- [ ] **Step 2: Run** `npm test -w web`. Expected: FAIL.
- [ ] **Step 3: Implement** the client calls, the section on the sign-in page and the menu line, with the existing button and modal styles.
- [ ] **Step 4: Run** `npm test -w web`, `npm run typecheck` and the browser acceptance run in Chromium and Firefox (`web/test/browser/README.md`). Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(web): sign in with Tailscale from the sign-in page"`.

### Task 6: Accounts view: links in the account editor, the System users tab and the Signed in tab

**Files:**
- Create: `web/src/TailnetLinks.tsx`
- Modify: `web/src/admin.ts` (types, `setSystemTailnet`), `web/src/accountForm.ts` (`tailnet` in the form, `toInput`, `fromView`, `formProblems`), `web/src/AccountEditor.tsx`, `web/src/SystemUsersTab.tsx`, `web/src/SessionsTab.tsx`, `web/src/AccountsView.tsx` (list column), `web/test/browser/acceptance.mjs` (extend `verifyAccounts`)
- Test: `web/test/admin.test.ts` (add), `web/test/accountForm.test.ts` (add)

**Interfaces:**
- `admin.ts`: `AccountView.tailnet: string[]`, `SystemView.tailnet: string[]`, `Overview.tailscale: "socket" | "headers" | null`, `SessionInfo.method?`, `SessionInfo.tailnet?`; `setSystemTailnet(name: string, logins: string[]): Promise<SystemView>` (`PUT /api/admin/system/<name>/tailnet`, name encoded).
- `accountForm.ts`: `AccountForm.tailnet: string[]`; `toInput` sends `tailnet` (trimmed, lowercased, empty entries dropped); `formProblems` names a login that fails the rule (`cleanLogin`'s twin) and more than 16.
- `TailnetLinks.tsx`: `({ logins, onChange, mode, disabled }: { logins: string[]; onChange(l: string[]): void; mode: Overview["tailscale"]; disabled?: boolean })`: a "Tailscale" heading (`h3`), the list of logins each with "Remove", a text field labelled "Tailnet login" with an "Add" button (Enter adds; a duplicate or a bad login shows an inline error tied with `aria-describedby`), and when `mode` is null the note "Tailscale sign-in is off on this hub. Links are kept and work once it is turned on." A help line: "For example alice@github. Tagged devices cannot be linked."
- `AccountEditor`: the section after "Keys"; saving sends `tailnet` with the other fields; a 409 from the hub shows its text in the editor's alert. The list in `AccountsView` shows "Tailscale" in the sign-in column when an account has links (and "can sign in" is true with links only).
- `SystemUsersTab`: the editor (today `SourcesEditor`) gets the same section and saves links with `setSystemTailnet` (and sources with `setSystemSources`, as now, only when they changed); the list shows the linked logins.
- `SessionsTab`: the method column shows "Password", "Key" or "Tailscale (<login>)".

- [ ] **Step 1: Write the failing tests:**
  - `web/test/admin.test.ts`: `setSystemTailnet("alice",["alice@github"])` sends `PUT /api/admin/system/alice/tailnet` with `{logins:["alice@github"]}`; a 409 with `{"error":"this tailnet login is linked to virt:guest"}` throws `AdminError` with that text.
  - `web/test/accountForm.test.ts`: `toInput` lowercases and trims logins and drops empty ones; `fromView` then `toInput` keeps them; `formProblems` names `tag:ci` and a 17th login, and nothing for `alice@github`.
  - `acceptance.mjs`, "Accounts" check: in the editor of a fixture account, "Tailnet login" plus Add puts `alice@github` in the list and Save sends one `PATCH` with `tailnet:["alice@github"]`; a fixture 409 shows its text in the alert; `tag:ci` shows the inline error and is not added; with `overview.tailscale: null` the note shows; the System users tab adds `alice@github` to `alice` and sends one `PUT …/tailnet`; the Signed in tab shows "Tailscale (alice@github)" for a fixture session; axe passes on the editor, the System users editor and the Signed in tab in light and dark; no horizontal overflow at 1365x900, 390x844 and 320x568; keyboard only: the field, Add and each Remove are reachable with Tab and work with Enter.
- [ ] **Step 2: Run** `npm test -w web`. Expected: FAIL.
- [ ] **Step 3: Implement** `TailnetLinks.tsx` and the changes, with the existing `acc-*` styles in `accounts.css`.
- [ ] **Step 4: Run** `npm test -w web`, `npm run typecheck` and the browser acceptance run in both browsers. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(web): administrators link tailnet logins in the Accounts view"`.

### Task 7: Docs and chart

**Files:**
- Modify: `docs/security.md` (new section "Tailscale sign-in" under "Sign-in and sessions"; the "What answers without a session" list; the audit paragraph), `docs/configuration.md` (the three settings), `docs/install.md` (values table row and a section "Tailscale sign-in"), `k8s/values.yaml` (`auth.tailscale`), `k8s/templates/hub.yaml` (env, sidecar container, shared socket volume, serve configuration), `k8s/templates/_helpers.tpl` (render checks), `scripts/check-chart-defaults.py` (two checks), `web/test/browser/README.md` (the new checks)
- Create: `k8s/templates/hub-tailscale.yaml` (the serve ConfigMap, and with `stateSecret` the ServiceAccount, Role and RoleBinding for that one Secret)

**Interfaces:**
- Chart values exactly as in the spec ("Configuration and chart"). Render refusals: `auth.tailscale needs auth.enabled`; `auth.tailscale.sidecar needs authKey.secretName`; `auth.tailscale.sidecar needs image.repository`; `auth.tailscale.headers or socket needs proxies` (the sidecar fills the loopback entries itself).
- Sidecar: userspace networking, no added capability, socket in an `emptyDir` mounted at the same path in both containers, `FILEDECK_TAILSCALE_SOCKET` set to it, and with `serve: true` HTTPS 443 on the device to `http://127.0.0.1:<hub port>`. Hostname and image come only from values; the defaults are empty.
- `check-chart-defaults.py`: "the tailscale sidecar is off by default" (`    sidecar:\n      enabled: false`), "tailscale headers are off by default" (`    headers: false`).

- [ ] **Step 1:** `docs/security.md`: who can sign in with Tailscale (linked logins only, no tags), the two sources and the listed proxies (with the warning that a listed proxy must carry only tailnet traffic and overwrite the identity headers), the button, the bound session and what ends it, act as root still needing a password or key, the lock-out rule, the audit fields, and the threats paragraph of the spec in the docs' style. Add the two routes to "What answers without a session".
- [ ] **Step 2:** `docs/configuration.md`: `FILEDECK_TAILSCALE_SOCKET`, `FILEDECK_TAILSCALE_HEADERS`, `FILEDECK_TAILSCALE_PROXIES`, their start-up refusals and log lines, and that they are read only with sign-in on. `docs/install.md`: the values row, a section "Tailscale sign-in" with the sidecar (auth key Secret, ephemeral key or `stateSecret`, `trustedProxies: 1` for the sidecar, a public ingress next to it needing the same hop count, separate host names and `hub.allowedHosts`), the operator ingress with the headers source (its proxy pods' addresses in `proxies`), and the first steps (link a login in Accounts, open the tailnet address, press the button). Use only example names (`files.example`, `alice@github`).
- [ ] **Step 3:** `k8s/values.yaml`, `k8s/templates/hub.yaml`, `k8s/templates/hub-tailscale.yaml`, `_helpers.tpl` and the neutral check, as above.
- [ ] **Step 4:** Run `npm run check:neutral`; `helm lint k8s`; `helm template t k8s` (no tailscale objects); `helm template t k8s --set auth.enabled=true --set agentToken.generate=true --set auth.tailscale.sidecar.enabled=true --set auth.tailscale.sidecar.image.repository=example/tailscale --set auth.tailscale.sidecar.image.tag=1 --set auth.tailscale.sidecar.authKey.secretName=ts` (a sidecar, the socket volume, `FILEDECK_TAILSCALE_SOCKET` and `FILEDECK_TAILSCALE_PROXIES` with the loopback entries); the same without `auth.enabled` fails with `auth.tailscale needs auth.enabled`. Expected: as stated.
- [ ] **Step 5:** Commit with `git commit -m "docs(auth): Tailscale sign-in; chart values for a tailscaled sidecar"`.

### Task 8: Full verification and browser acceptance

**Files:**
- Modify: `TASKS.md` (row 20.163 notes), nothing else unless a check fails

- [ ] **Step 1:** Run the whole server suite with a private `TMPDIR`, `npm test -w web`, `npm run typecheck`, `npm run check:neutral` and `helm lint k8s`. Expected: all pass.
- [ ] **Step 2:** Run the browser acceptance in Chromium and Firefox (`web/test/browser/README.md`), including "Sign in" and "Accounts". Expected: PASS, axe clean in light and dark.
- [ ] **Step 3:** End to end on a test tailnet (needs a tailnet and an auth key from Thomas; skip with a note on the board row if there is none): install the chart as a scratch release of your own with sign-in on, the sidecar on, one virtual account linked to a test login. Check in a real browser: the button shows over the tailnet address and not over a port-forward; pressing it signs in; sign-out holds after a reload; unlinking in Accounts signs the browser out at its next request; a tagged test device gets the tagged note; a request with a forged `Tailscale-User-Login` through the port-forward gets no identity; `kubectl logs` of the hub show the `tailnet` audit fields and no socket path.
- [ ] **Step 4:** Ask for a review of the whole branch (superpowers:requesting-code-review), with the Review Focus above as the brief. Fix what it finds and run Steps 1 and 2 again.
- [ ] **Step 5:** Update row 20.163 in `TASKS.md` (status, what was checked and how) and commit with `git commit -m "docs(tasks): 20.163 Tailscale sign-in verified"`.
