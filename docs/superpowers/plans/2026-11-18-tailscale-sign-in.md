# Tailscale sign-in: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person on a tailnet device signs in with one click, as the virtual account or system user that an administrator linked to their tailnet login or to a tag of their device. The identity comes from tailscaled's LocalAPI socket (login and tags) or from the Tailscale Serve identity headers (login only), only through listed proxies. The session is a normal session bound to that identity. Administrators link logins and tags in the Accounts view, and a link counts for the last-administrator check while a Tailscale source is configured. Nothing changes with sign-in off.

**Architecture:** A new hub module, `auth/tailnet.ts`, is the only reader of the two sources: it checks the TCP peer against `FILEDECK_TAILSCALE_PROXIES`, then reads the headers or asks `/localapi/v0/whois` for the last `X-Forwarded-For` entry (10-second cache per address), and strips the `Tailscale-User-*` headers from every request. Links (kind `login` or `tag`) live in a new auth database table, `tailnet_links`, written by the admin routes in the same store transaction as the other account fields, followed by `accountChanged`. A pure function, `resolve`, turns an identity and the links into one account or a refusal reason (a linked login wins; else exactly one account among the linked tags). `POST /api/auth/login-tailscale` signs in; the session stores `method`, `tailnet_subject`, `tailnet_login` and `tailnet_node`, and the gate runs `resolve` again on every request. A linked system user is vouched for by the agents' existing lookup route in the sign-in order (`AgentSystemAuth.vouch`). `lockOut` counts links when a source is configured. The web app gets a button on the sign-in page and a "Tailscale" section in the account editor and the System users tab. The chart gets an optional tailscaled sidecar. The last task checks it all on Thomas's real tailnet with an ephemeral key.

**Tech Stack:** Node 22, TypeScript, Hono, `node:sqlite`, `node:test`, `node:http` over a unix socket; React 19, Playwright and axe-core for the browser checks; Helm.

**Spec:** `docs/superpowers/specs/2026-11-18-tailscale-sign-in-design.md` (decisions 1 to 9, "Identity sources", "Routes", "Sessions", "Admin API and screens", "Audit", "Configuration and chart", "Threats", "End-to-end check"). Builds on v0.4.0 (`docs/superpowers/plans/2026-11-17-auth-*.md`, all done). Board row 20.177.

**State before this plan:** sign-in methods are password and key only (`server/src/auth/routes.ts`). `sessions` has `address` and `as_root_until` but no method. Nothing reads `Tailscale-User-*` headers, and nothing talks to tailscaled. `AgentSystemAuth` has `password`, `key` and `exists`; the agent's `/api/auth/lookup` already answers `{exists:false, refused:true}` for uid 0, gid 0 or group 0. `lockOut` in `admin-routes.ts` counts a password or a key. `AccountView` and `SystemView` have no links. The chart has no sidecar.

## Global Constraints

- Everything new is inert unless `FILEDECK_AUTH=on`. With it off: the Tailscale settings give one log line if set and are not used; `/api/auth/tailnet` and `/api/auth/login-tailscale` do not exist; no header is stripped; `GET /api/auth/me` answers `{"auth":false}`; the existing tests pass unchanged.
- A tailnet identity exists only for a request whose TCP peer (`getConnInfo`, never a header) is in `FILEDECK_TAILSCALE_PROXIES`. `FILEDECK_TRUSTED_PROXIES` never decides it.
- The socket is used when set; otherwise the headers when on. No fallback from an unavailable socket to the headers.
- Tags come only from the socket. The headers source never has tags, so a tagged device has no identity there.
- Resolution: a linked login wins; else the linked tags of the device must all belong to one account; tags of two or more accounts refuse (`tag-conflict`). Every refusal is 401 `{"error":"sign-in failed"}` after the 500 ms floor, under the sign-in limiter (name key `tailnet:<login or sorted tags>`), and the audit line carries the reason.
- Links: trimmed and lowercased; a login matches `` ^[a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*$ `` (at most 254 characters, never `tagged-devices`); a tag matches `^tag:[a-z0-9-]{1,63}$`. At most 16 links per account, both kinds together. A login or tag is linked to at most one account (409 otherwise).
- Every link change raises the account epoch in the store transaction and runs `accountChanged` after the commit.
- Act as root keeps needing a password or a key.
- `lockOut` counts a link only while a Tailscale source is configured; with the headers source only login links count.
- No log line, audit line or error body holds a socket path, a raw whois answer, a cookie or an auth key. Logins and tags may appear (they are not secrets).
- Run server tests with a private `TMPDIR` (a folder only you can change). British English. No real infrastructure names in code, tests, docs or chart defaults; `npm run check:neutral` passes.

## Review Focus

1. **A client that sends `Tailscale-User-Login` from a peer that is not listed**, also with `FILEDECK_TRUSTED_PROXIES` above 0 and a forged `X-Forwarded-For`. It must get no identity, and the header must not reach any route. Test owner: Task 1 `spoofed headers`, Task 3 `spoof through the gate`.
2. **The socket fails while the headers source is also on.** The hub must answer 503, never read the headers. Test owner: Task 1 `no fallback`.
3. **A device with tags linked to two different accounts.** Sign-in must fail with reason `tag-conflict`, and a session made when only one tag was linked must end within 10 seconds of the second link (its epoch raise already ends it; a second tag added to the device must end it too). Test owner: Task 2 `resolve`, Task 3 `tag set changes`.
4. **A linked system user that is root on the first machine and an ordinary user on the second.** Sign-in must fail. Test owner: Task 3 `refused stops the search`.
5. **Lock-out with links.** With a source configured, an administrator with only a link counts; without one, it does not; with the headers source a tag link does not count. Test owner: Task 4 `lock-out counts links`.
6. **Two administrators linking the same login or tag to two accounts at the same moment.** Exactly one must succeed; the other gets 409. Test owner: Task 4 `same link, at once`.
7. **The auth key of the end-to-end check.** It must never reach chat, git, a log line or the repository, and the test node must be gone afterwards. Owner: Task 8 Step 3.

---

### Task 1: Identity sources: proxies, headers, LocalAPI whois

**Files:**
- Create: `server/src/auth/tailnet.ts`
- Modify: `server/src/config.ts` (`tailscaleSocket`, `tailscaleHeaders`, `tailscaleProxies`), `server/src/main.ts` (start-up lines and the refusal when a source is on without proxies)
- Test: `server/test/auth-tailnet.test.ts`, `server/test/config.test.ts` (add; create it if the config checks live elsewhere)

**Interfaces:**
- `config.ts`: `tailscaleSocket: string | undefined` (`FILEDECK_TAILSCALE_SOCKET`), `tailscaleHeaders: boolean` (`FILEDECK_TAILSCALE_HEADERS === "on"`), `tailscaleProxies: string[]` (`FILEDECK_TAILSCALE_PROXIES`, comma separated, each an IP or CIDR; an entry that is not one throws `FILEDECK_TAILSCALE_PROXIES: "<entry>" is not an IP address or range`).
- `tailnet.ts`:
  - `type TailnetIdentity = { login?: string; displayName?: string; tags: string[]; node?: { name: string; stableId: string }; address?: string; source: "socket" | "headers" }` (a login, or at least one tag, or both)
  - `type TailnetAnswer = TailnetIdentity | { none: true } | { unavailable: true }`
  - `cleanLogin(v: string): string | null` and `cleanTag(v: string): string | null`: the rules of the Global Constraints; `cleanLogin("tagged-devices")` is null.
  - `class ProxyList { constructor(entries: string[]); has(ip: string): boolean }` (IPv4, IPv6, IPv4-mapped IPv6 through `plainAddress`, zone ids removed).
  - `class TailnetSource { constructor(o: { socket?: string; headers: boolean; proxies: ProxyList; timeoutMs?: number; cacheMs?: number; maxCache?: number; now?: () => number; log?: (s: string) => void }); readonly mode: "socket" | "headers" | null; identify(c: Context): Promise<TailnetAnswer> }`. Reads the request headers itself; never throws.
  - `stripTailnetHeaders(): MiddlewareHandler`: deletes every `tailscale-user-*` header from the request seen by later middleware and routes. The hub mounts it after the identity has been read (Task 3 keeps it on the context as `tailnet`).
  - whois: `GET /localapi/v0/whois?addr=<address>` with `Host: local-tailscaled.sock` over `socketPath`, at most 8 at once, `timeoutMs` default 2000, cache per address `cacheMs` default 10000 and `maxCache` default 1024 (oldest out first). The address is the last `X-Forwarded-For` entry through `hopAddress`; outside `100.64.0.0/10` and `fd7a:115c:a1e0::/48` it is `none` without a call. 404: `none`. The login from `UserProfile.LoginName` through `cleanLogin`, the tags from `Node.Tags` through `cleanTag` (failing ones left out, the rest sorted); neither left: `none`. Other failures: `unavailable`, with one log line at most once a minute (`tailnet: the tailscaled socket did not answer (<reason>)`, never the path).
  - headers: `Tailscale-User-Login` once (twice or more: `none`), through `cleanLogin`; `Tailscale-User-Name` decoded from RFC 2047 (`=?utf-8?q?…?=`, `=?utf-8?b?…?=`), control and format characters dropped, 128 characters at most; `tags: []`.

- [ ] **Step 0: Check a real `tailscale serve`** (not committed as a test): run tailscaled in userspace mode with `tailscale serve --https=443 http://127.0.0.1:<port>` in front of a small server that prints request headers; call it from a user-owned tailnet device and from a tagged one, with a forged `Tailscale-User-Login` and `X-Forwarded-For`; and ask `tailscale whois` for both devices. Record in the task's commit message body: whether `X-Forwarded-For` ends with the device's tailnet address, whether `X-Forwarded-Proto: https` is sent, whether the forged identity header is removed, that the tagged device gets no identity header, and the whois fields for a tagged device (`Node.Tags`, `UserProfile.LoginName`). This needs a tailnet: use the same ephemeral-key process as Task 8 Step 3 (ask the coordinator), or move this step to the start of Task 8 if no key is available yet. If `X-Forwarded-For` or the header removal is not as the spec assumes, stop and report before going on.
- [ ] **Step 1: Write the failing tests** in `server/test/auth-tailnet.test.ts` (a fake LocalAPI: an `http.createServer` on a unix socket in the private `TMPDIR`; requests built with a fake `getConnInfo` peer through `app.request` with an `env.incoming.socket.remoteAddress`, as the existing auth tests do):
  - `clean`: `" Alice@GitHub "` gives `alice@github`; `alice@example.com` and `bob@passkey` pass; `tagged-devices`, `alice`, `@github`, `alice@`, `alice@exa mple`, a 255-character login and one with a newline give null. `cleanTag`: `" Tag:Server "` gives `tag:server`; `tag:web-1` passes; `tag:`, `tag:a_b`, `tag:a.b`, `server` and a 64-character name give null.
  - `proxy list`: `127.0.0.1/32,::1/128` has `127.0.0.1`, `::1` and `::ffff:127.0.0.1`, not `10.0.0.1`; `10.1.0.0/16` has `10.1.2.3`; a bad entry throws in `config`.
  - `headers`: peer `127.0.0.1` listed and `Tailscale-User-Login: Alice@GitHub`, `Tailscale-User-Name: =?utf-8?q?Al=C3=AFce?=` give `{login:"alice@github", displayName:"Alïce", tags:[], source:"headers"}`; the header twice gives `none`.
  - `spoofed headers`: peer `192.0.2.9` (not listed) with the login header gives `none`, also with `FILEDECK_TRUSTED_PROXIES` 1 and `X-Forwarded-For: 127.0.0.1`.
  - `socket`: peer listed, `X-Forwarded-For: 198.51.100.4, 100.101.102.103`: the fake LocalAPI is asked for `addr=100.101.102.103` with `Host: local-tailscaled.sock` and its answer gives login, display name, node name and stable id, `tags: []`, `address` and `source:"socket"`; a second request within 10 s makes no call; after 10 s (injected clock) it asks again.
  - `socket tags`: an answer with `UserProfile.LoginName: "tagged-devices"` and `Node.Tags: ["tag:web","tag:ci","tag:Bad_Name"]` gives no login and `tags: ["tag:ci","tag:web"]`; an answer with a user and tags gives both; tags changed in the fake LocalAPI show after 10 s.
  - `socket refusals`: an address outside the tailnet ranges makes no call and gives `none`; a 404 gives `none`; an answer with no valid login and no valid tag gives `none`; a peer that is not listed makes no call.
  - `no fallback`: socket set to a path with no server, headers on, the login header from a listed peer: `unavailable`; one log line in two calls within a minute; the line has no socket path.
  - `timeout`: a fake LocalAPI that never answers gives `unavailable` within 2.5 s.
  - `strip`: after `stripTailnetHeaders`, a route sees no `tailscale-user-login` header.
- [ ] **Step 2: Run** `cd server && TMPDIR=<private> node --import tsx --test test/auth-tailnet.test.ts test/config.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the config fields, `tailnet.ts` and the start-up rules in `main.ts`: with `FILEDECK_AUTH` off and a Tailscale setting set, one line `tailscale: sign-in is off, so FILEDECK_TAILSCALE_* is ignored`; with a source on and no proxies, stop with the spec's message; with both sources set, one line that the headers setting is ignored.
- [ ] **Step 4: Run** the same tests. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(auth): read a tailnet identity from listed proxies, by headers or tailscaled's whois"`.

### Task 2: Link store, link checks and resolution

**Files:**
- Create: `server/src/auth/tailnet-links.ts`
- Modify: `server/src/auth/account-input.ts` (`tailnetLink`, `tailnetLinks`, `MAX_TAILNET_LINKS`)
- Test: `server/test/auth-tailnet-links.test.ts`, `server/test/auth-account-input.test.ts` (add)

**Interfaces:**
- `tailnet-links.ts`: table `tailnet_links (subject TEXT PRIMARY KEY, kind TEXT NOT NULL, account_kind TEXT NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL)` with index `(account_kind, name)`; `kind` is `login` or `tag`.
  - `type LinkKind = "login" | "tag"`; `type AccountKind = "sys" | "virt"`; `type Link = { subject: string; kind: LinkKind }`
  - `class TailnetLinks { constructor(db: AuthDb, now?: () => number); owner(subject: string): { kind: AccountKind; name: string } | undefined; forAccount(kind, name): Link[] (sorted by subject); setForAccount(kind, name, links: Link[]): void; accounts(kind): string[]; removeAccount(kind, name): void; counts(kind, name, mode: "socket" | "headers" | null): boolean }`.
  - `setForAccount` replaces the account's rows in one transaction or a savepoint of the caller's (`inTransaction`), keeps `created` of a link it keeps, and throws `LinkTaken { subject, kind, accountKind, name }` when a subject belongs to another account (the primary key decides, so two writers cannot both win).
  - `counts`: whether the account has a link that can sign in now: false for `null`; any link for `socket`; a `login` link for `headers`.
  - `resolve(id: TailnetIdentity, links: Pick<TailnetLinks, "owner">): { ok: true; kind: AccountKind; name: string; subject: string; match: LinkKind } | { ok: false; reason: "unlinked" | "tag-conflict"; accounts?: string[] }`: a linked login wins; else the linked tags (in sorted order): none, `unlinked`; one account, that account with the first matching tag as subject; more, `tag-conflict` with the `kind:name` of each account.
- `account-input.ts`: `MAX_TAILNET_LINKS = 16`; `tailnetLink(v: unknown): Link` (`cleanTag` for a value that starts with `tag:` after trimming and lowercasing, else `cleanLogin`; failure: `InputError("a tailnet link must be a login such as alice@github or a tag such as tag:server (letters, digits and dashes)")`); `tailnetLinks(v: unknown): Link[]` (a list, each cleaned, duplicates merged, at most 16).
- `store.ts` is not changed: the admin routes call `removeAccount` inside their delete transaction (Task 4).

- [ ] **Step 1: Write the failing tests:**
  - `auth-tailnet-links.test.ts`: `setForAccount("virt","guest",[{subject:"alice@github",kind:"login"},{subject:"tag:server",kind:"tag"}])` then `owner("tag:server")` is `{kind:"virt",name:"guest"}` and `forAccount` is sorted with kinds; `setForAccount("sys","guest",[{subject:"tag:server",kind:"tag"}])` throws `LinkTaken` naming `virt:guest` and changes nothing; `setForAccount("virt","guest",[])` removes both; `created` of a kept link does not change on a second set; `accounts("sys")` lists only names with rows; inside an outer `accounts.tx` that throws after `setForAccount`, nothing is kept; `counts`: a login link counts for `socket` and `headers`, a tag link only for `socket`, nothing for `null`.
  - `resolve` (same file): links `alice@github` to `virt:a`, `tag:web` to `virt:b`, `tag:ci` to `virt:b`, `tag:db` to `sys:c`: `{login:"alice@github", tags:["tag:web"]}` gives `virt:a` (login wins, match `login`); `{login:"bob@github", tags:["tag:ci","tag:web"]}` gives `virt:b` with subject `tag:ci` (unlinked login, one account among tags); `{tags:["tag:db","tag:web"]}` gives `tag-conflict` with accounts `["sys:c","virt:b"]`; `{tags:["tag:x"]}` and `{login:"bob@github", tags:[]}` give `unlinked`.
  - `auth-account-input.test.ts`: `tailnetLink(" Alice@GitHub ")` is `{subject:"alice@github",kind:"login"}`; `tailnetLink("TAG:Server")` is `{subject:"tag:server",kind:"tag"}`; `tagged-devices`, `tag:`, `tag:a_b`, `alice`, `5` and a 255-character login throw; `tailnetLinks` merges `["a@x","A@X"]` into one and throws for 17 links and for a value that is not a list.
- [ ] **Step 2: Run** `cd server && TMPDIR=<private> node --import tsx --test test/auth-tailnet-links.test.ts test/auth-account-input.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `TailnetLinks`, `resolve` and the input checks.
- [ ] **Step 4: Run** the same tests and `test/auth-store.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(auth): store tailnet logins and tags linked to accounts; resolve an identity to one account"`.

### Task 3: Sign in with Tailscale; sessions bound to the tailnet identity; audit

**Files:**
- Modify: `server/src/auth/routes.ts` (`GET /api/auth/tailnet`, `POST /api/auth/login-tailscale`, the binding in the gate, `me` gives `method` and `tailnet`), `server/src/auth/sessions.ts` (columns and fields), `server/src/auth/system.ts` (`vouch`), `server/src/hub.ts` (build `TailnetSource` and `TailnetLinks`, mount the identity reader and `stripTailnetHeaders`, pass them to `registerAuth`), `server/src/audit.ts` (`tailnet` field)
- Test: `server/test/auth-tailnet-signin.test.ts`, `server/test/auth-system.test.ts` (add), `server/test/auth-sessions.test.ts` (add), `server/test/audit.test.ts` (add)

**Interfaces:**
- `sessions.ts`: columns `method TEXT`, `tailnet_subject TEXT`, `tailnet_login TEXT`, `tailnet_node TEXT`, added with `ALTER TABLE` when missing. `create(kind, name, address?, how?: { method: "password" | "key" | "tailscale"; tailnetSubject?: string; tailnetLogin?: string; tailnetNode?: string })`. `lookup` returns `method?`, `tailnetSubject?`, `tailnetLogin?`, `tailnetNode?`. `SessionInfo` gains `method?` and `tailnet?` (the subject).
- `system.ts`: `AgentSystemAuth.vouch(name: string): Promise<boolean>`: `/api/auth/lookup` in the sign-in order under `TOTAL_MS`; `exists:true` is yes; `refused:true` ends with no; `exists:false`, non-200, a bad body or no answer go on; none: no. `SystemAuth` gains `vouch` (`unavailableSystemAuth.vouch` answers false).
- `routes.ts`:
  - `AuthDeps` gains `tailnet?: TailnetSource` and `links?: TailnetLinks`.
  - The identity is read once per request, before `stripTailnetHeaders` runs, and kept as `c.get("tailnet")` (`TailnetAnswer | undefined`); with no source it is never read.
  - `GET /api/auth/tailnet` (in `AUTH_ROUTES`): `{login?, displayName?, tags?, node?: {name}}`, `{}`, or 503 `{"error":"tailnet identity unavailable"}`.
  - `POST /api/auth/login-tailscale` (in `AUTH_ROUTES`): `secure()` else 403 `sign-in needs HTTPS`; the limiter with name `tailnet:<login or sorted tags joined by ",">` (or `tailnet:` when there is no identity) and the client address; unavailable: 503 (no floor, not counted as a failure); `none`: 401 (reason `unlinked`); `resolve` refuses: 401 with its reason; `root`: 401 (`refused`) without a `vouch` call; a system user `vouch` refuses: 401 (`not-vouched`); a virtual account that no longer exists: 401 (`no-account`). Each 401 is `sign-in failed` after the floor. Success: `signIn` with `{method:"tailscale", tailnetSubject, tailnetLogin, tailnetNode: node?.stableId}`, then `onSignIn` (presence refresh for a system user). `signIn` of the password and key routes passes `method: "password"` and `"key"`.
  - The gate, for a session with `method = "tailscale"`: read the identity; `unavailable`: 503 `{"error":"tailnet identity unavailable"}`, session kept; `none`: 401 signed out, session kept; else run `resolve` again: same account and subject (and, when the session has `tailnet_node`, the same `node.stableId`): admit; anything else: `sessions.destroy` and 401 signed out, with the reason on the context for the audit line. Sessions without the method are not checked.
  - `GET /api/auth/me`: adds `method` (when known) and `tailnet` (the subject) for a Tailscale session.
- `audit.ts`: a line gets `tailnet: {login?, tags?, subject?, source, node?, address?, reason?, accounts?}` for `/api/auth/login-tailscale`, and `{subject, source}` (plus `reason` when the binding ended the session) for a request with a Tailscale session.

- [ ] **Step 1: Write the failing tests** in `server/test/auth-tailnet-signin.test.ts` (a hub with auth on, `FILEDECK_TAILSCALE_PROXIES=127.0.0.1/32`, `FILEDECK_TRUSTED_PROXIES=1`, `X-Forwarded-Proto: https`, a fake `SystemAuth`; the login cases run with `FILEDECK_TAILSCALE_HEADERS=on` and again with a fake LocalAPI socket; the tag cases with the socket only):
  - `button data`: `GET /api/auth/tailnet` from the listed peer with a login gives the login; a tagged device (socket) gives `tags`; from another peer `{}`; with no source configured `{}` and no socket call.
  - `virtual account by login`: `guest` linked to `alice@github`: `POST /api/auth/login-tailscale` sets `__Host-filedeck`; `me` gives `kind:"virt"`, `name:"guest"`, `method:"tailscale"`, `tailnet:"alice@github"`.
  - `by tag`: `ci` linked to `tag:ci`; a device with no user and `tags:["tag:ci"]` signs in as `virt:ci` with `tailnet:"tag:ci"`; a device with user `bob@github` (unlinked) and `tag:ci` signs in as `ci`; a device with user `alice@github` (linked to `guest`) and `tag:ci` signs in as `guest`.
  - `tag conflict`: `tag:db` linked to `sys:c` and `tag:ci` to `virt:ci`; a device with both tags gets 401 `sign-in failed`, and the audit line has `reason:"tag-conflict"` and both accounts.
  - `tags and headers`: with the headers source, a request from the listed peer with no login header (a tagged device behind Serve) gets 401 with `reason:"unlinked"`; `tag:ci` links make no difference.
  - `unlinked`: an unlinked login and no identity each give 401 `sign-in failed` no sooner than 500 ms, with the reason in the audit line; the sixth failure in a minute for one login gives 429.
  - `system user`: `alice` (sys) linked to `alice@github`, `vouch` true: signed in as `sys:alice`, the presence refresh started; `vouch` false: 401 (`not-vouched`). A hand-written link row for `root` gives 401 (`refused`) without a `vouch` call.
  - `needs HTTPS`: no `X-Forwarded-Proto`: 403 `sign-in needs HTTPS`.
  - `binding`: after a Tailscale sign-in, a request with the same login is admitted; one with `bob@github` gets 401 signed out and the session is gone (a later request with `alice@github` is 401 too); one with no identity (another peer, same cookie) gets 401 and a later request with `alice@github` is admitted; socket source: the same address answering with another `StableID` ends the session; socket unavailable: 503 and the session stays.
  - `tag set changes`: signed in by `tag:ci`; the fake LocalAPI drops `tag:ci` from the device: within 10 s (injected clock) the next request is 401 and the session is gone; again, but the device gains `tag:db` (linked to `sys:c`): the session ends with `reason:"tag-conflict"`; the device gains an unlinked tag: the session stays.
  - `spoof through the gate`: a password session of `guest` (no method) is not affected by any tailnet header; a peer that is not listed sends `Tailscale-User-Login: alice@github` to `login-tailscale`: 401; no route handler sees the header (a test route echoes request headers).
  - `link change ends sessions`: removing the link (store write plus `accountChanged`) makes the next request 401.
  - `as root`: a system administrator signed in with Tailscale: `POST /api/auth/as-root` with no proof is 401, with the right password (fake PAM) turns it on.
  - `auth off`: with `FILEDECK_AUTH` unset and the Tailscale settings set, `GET /api/auth/tailnet` and `POST /api/auth/login-tailscale` are not auth routes (`/api/auth/me` still `{"auth":false}`), and a request header `Tailscale-User-Login` reaches a test route unchanged.
  - `auth-system.test.ts`: `refused stops the search`: node A answers `{exists:false, refused:true}`, node B `{exists:true}`: `vouch` is false and B is not asked; A `{exists:false}`, B `{exists:true}`: true; A unreachable, B true: true; all false: false.
  - `auth-sessions.test.ts`: a session made with `{method:"tailscale", tailnetSubject:"tag:ci", tailnetNode:"n1"}` comes back from `lookup` and `list` with them; an old database without the columns opens and gets them.
  - `audit.test.ts`: the `login-tailscale` line has `tailnet: {login, source:"headers"}`; a tag sign-in line has `tags` and `subject`; a request of a Tailscale session has `tailnet: {subject, source}`; a password session's lines have no `tailnet`; no line holds the socket path.
- [ ] **Step 2: Run** `cd server && TMPDIR=<private> node --import tsx --test test/auth-tailnet-signin.test.ts test/auth-system.test.ts test/auth-sessions.test.ts test/audit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the columns, `vouch`, the two routes, the binding, the wiring in `hub.ts` (identity read after `trustProxies` and before `requestGuard`; `stripTailnetHeaders` right after it) and the audit field.
- [ ] **Step 4: Run** the same tests, `test/auth-routes.test.ts`, `test/auth-as-root.test.ts` and the whole server suite with the private `TMPDIR`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(auth): sign in with Tailscale by login or tag; sessions bound to the tailnet identity; audit"`.

### Task 4: Admin API: link and unlink logins and tags; lock-out counts links

**Files:**
- Modify: `server/src/auth/admin-routes.ts` (views, `tailnet` in POST and PATCH, `PUT /api/admin/system/:name/tailnet`, overview, delete removes links, `lockOut`), `server/src/hub.ts` (pass `links` and the Tailscale mode), `server/src/audit.ts` (`adminBody` keeps `tailnet` and `links`)
- Test: `server/test/auth-admin-tailnet.test.ts`, `server/test/auth-admin.test.ts` (add to the `lockOut` tests), `server/test/audit.test.ts` (add)

**Interfaces:**
- `AdminDeps` gains `links: TailnetLinks` and `tailscale: "socket" | "headers" | null`.
- `AccountView.tailnet: Link[]`, `SystemView.tailnet: Link[]`; `GET /api/admin/accounts` lists system users that have links; `GET /api/admin/overview` gains `tailscale`.
- `POST /api/admin/accounts` and `PATCH /api/admin/accounts/:name` take `tailnet` (`tailnetLinks`); inside `accounts.tx`: `links.setForAccount("virt", name, list)`; `LinkTaken` becomes `Refused(409, "this tailnet login is linked to <kind>:<name>")` (or `this tag is linked to …`); PATCH raises the epoch as it does now and runs `changed` after the commit. A PATCH with only `tailnet` is a valid change.
- `lockOut(cfg, accounts, links, mode, change)`: `change` gains `links?: Link[]` (the links the account keeps). A virtual administrator can sign in when it has a password, a key, or `links.counts(...)` for `mode` (for the changed account, counted on `change.links` when given). PATCH calls it when it removes the password, takes away the flag, or changes `tailnet`; the key removal and delete routes call it as now, with the links. It still applies only when `FILEDECK_ADMINS` is empty.
- `PUT /api/admin/system/:name/tailnet {links}`: `systemName` (never `root`); when the list is not empty, ask `systemExists` on every machine (2 s): at least one answer and none `true` gives 400 `no machine has a system user <name>`; then in `accounts.tx`: `callerHolds`, `links.setForAccount("sys", …)`, `bumpEpoch("sys", name)`; `changed` after; answers `systemView`.
- `DELETE /api/admin/accounts/:name` calls `links.removeAccount("virt", name)` inside its transaction.
- `adminBody`: `tailnet` and `links` as lists of clipped strings (at most 16).

- [ ] **Step 1: Write the failing tests** in `server/test/auth-admin-tailnet.test.ts` (a hub with auth on and a virtual administrator, as `auth-admin-accounts.test.ts` does):
  - `link a virtual account`: `PATCH /api/admin/accounts/guest {tailnet:["Alice@GitHub","TAG:Server"]}` answers `tailnet:[{subject:"alice@github",kind:"login"},{subject:"tag:server",kind:"tag"}]`; the epoch rose; `accountChanged` ran once with the identity from before; `guest`'s password session is now 401.
  - `create with links`: `POST /api/admin/accounts` with `tailnet:["bob@github"]` and no password: 201, `hasPassword:false`, one login link.
  - `duplicate`: linking `alice@github` to `other` while `guest` has it: 409 `this tailnet login is linked to virt:guest`; the same for `tag:server` with `this tag is linked to virt:guest`; nothing of that PATCH is written (the admin flag in the same body did not change).
  - `same link, at once`: two PATCH calls for two accounts with the same tag, sent together: one 200, one 409; the table holds one row.
  - `bad links`: `tag:a_b`, `tag:`, `tagged-devices`, `alice`, 17 links: 400; the message names the field and both forms.
  - `system user`: `PUT /api/admin/system/alice/tailnet {links:["alice@github","tag:ops"]}` with fake machines `{a:true}`: 200 and `GET /api/admin/accounts` lists `alice` under `system` with both links; machines `{a:false, b:undefined}`: 400 `no machine has a system user alice`; machines all `undefined`: 200; `root`: 400; `alice`'s sessions end (epoch).
  - `delete removes links`: deleting `guest` frees `alice@github` and `tag:server`, and a new account `guest` has `tailnet: []`.
  - `lock-out counts links`, with `FILEDECK_ADMINS` empty and one virtual administrator `boss` with a password and the link `boss@github`:
    - socket source: `PATCH boss {password:null}` is 200 (the link counts); then `PATCH boss {tailnet:[]}` is 409 `this would leave no administrator who can sign in`;
    - headers source: the same with link `boss@github` is 200; with only the link `tag:boss` it is 409 (a tag cannot sign in through headers);
    - no source: `PATCH boss {password:null}` is 409 (links do not count);
    - socket source, `boss` with only a link and no password or key: `DELETE` of another administrator that has a password is 200, because `boss` still counts.
  - `overview`: `tailscale` is `"headers"` with the headers source, `"socket"` with a socket, `null` with none.
  - `auth-admin.test.ts`: the existing `lockOut` unit tests pass with the new arguments (`mode: null` keeps the old answers).
  - `audit.test.ts`: an admin line for `PATCH {tailnet:["alice@github","tag:ci"]}` keeps both; a `PUT …/tailnet` line keeps `links`.
- [ ] **Step 2: Run** `cd server && TMPDIR=<private> node --import tsx --test test/auth-admin-tailnet.test.ts test/auth-admin.test.ts test/audit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the view fields, the route changes, the new route, the delete change, `lockOut` and `adminBody`.
- [ ] **Step 4: Run** the same tests, `test/auth-admin-accounts.test.ts` and the whole server suite. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(auth): administrators link tailnet logins and tags; links count for the last administrator while Tailscale is on"`.

### Task 5: Sign-in page: "Sign in with Tailscale"

**Files:**
- Modify: `web/src/auth.ts` (`tailnet()`, `loginTailscale()`, `Account.method`, `Account.tailnet`), `web/src/SignIn.tsx` (the button), `web/src/AccountMenu.tsx` (the method line), `web/test/browser/acceptance.mjs` (extend `verifySignIn`)
- Test: `web/test/auth.test.ts` (add)

**Interfaces:**
- `auth.ts`: `type Tailnet = { login?: string; displayName?: string; tags?: string[]; node?: string } | { unavailable: true } | null`; `tailnet(): Promise<Tailnet>` (`GET /api/auth/tailnet`, literal URL; the hub's tailnet 503, marked by `x-filedeck-auth: tailnet-unavailable`, gives `{unavailable:true}`; `{}` or any other failure gives null); `loginTailscale(): Promise<Account>` (`POST /api/auth/login-tailscale` with `{}`, through `reach` and `signedIn`; a 401 shows "Sign-in failed", the same text as a password failure). `whoFrom` keeps `method` and `tailnet` when they are strings.
- `SignIn.tsx`: asks `tailnet()` once on mount. With a login or tags: a section above the form with a button "Sign in with Tailscale" and the text "as <login>" (or "as this device: tag:ci, tag:web" when there is no login; the device name when known), then a divider "or". It is never pressed for the person: no automatic sign-in, focus stays on the name field. With `{unavailable}`: a note "Tailscale sign-in is not available now." With null: nothing. The button shares `useProofFields`' busy and error state, so the error shows in the same alert.
- `AccountMenu.tsx`: for a Tailscale session, a line "Signed in with Tailscale as <subject>".

- [ ] **Step 1: Write the failing tests:**
  - `web/test/auth.test.ts` (fake `fetch`): `tailnet()` sends `GET /api/auth/tailnet` and returns the login; `{tags:["tag:ci"]}` comes back as tags; 503 gives `{unavailable:true}`; `{}` gives null; `loginTailscale()` sends `POST /api/auth/login-tailscale` with body `{}` and JSON content type; a 401 throws `SignInError` with the Tailscale text; `me()` keeps `method:"tailscale"` and `tailnet`.
  - `acceptance.mjs`, "Sign in" check: the fake hub answers `GET /api/auth/tailnet` with `{login:"alice@github"}`: the button shows the login, and no request to `login-tailscale` is made before the click; the click sends one POST and the app loads; with `{tags:["tag:ci"]}` the button names the tag; with `{}` the page is as before; with 503 the note shows; a 401 shows the Tailscale text in the alert; axe passes in light and dark; no horizontal overflow at 1365x900, 390x844 and 320x568; the account menu of a Tailscale session shows the method line.
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
- `admin.ts`: `type TailnetLink = { subject: string; kind: "login" | "tag" }`; `AccountView.tailnet: TailnetLink[]`, `SystemView.tailnet: TailnetLink[]`, `Overview.tailscale: "socket" | "headers" | null`, `SessionInfo.method?`, `SessionInfo.tailnet?`; `setSystemTailnet(name: string, links: string[]): Promise<SystemView>` (`PUT /api/admin/system/<name>/tailnet`, name encoded).
- `accountForm.ts`: `AccountForm.tailnet: string[]`; `toInput` sends `tailnet` (trimmed, lowercased, empty entries dropped); `linkKind(v): "login" | "tag" | null` (the client twin of `tailnetLink`); `formProblems` names a value that is neither and more than 16.
- `TailnetLinks.tsx`: `({ links, onChange, mode, disabled }: { links: string[]; onChange(l: string[]): void; mode: Overview["tailscale"]; disabled?: boolean })`: a "Tailscale" heading (`h3`); the list of links, each with a "Login" or "Tag" label and "Remove"; one text field labelled "Tailnet login or tag" with an "Add" button (Enter adds; a duplicate or a bad value shows an inline error tied with `aria-describedby`); a help line "For example alice@github or tag:server."; while the field holds a tag, and next to each tag in the list, the warning "Anyone who may apply this tag in your tailnet can make a device that signs in as this account."; when `mode` is null the note "Tailscale sign-in is off on this hub. Links are kept and work once it is turned on."; when `mode` is `headers` and a tag is listed, the note "Tag links need the socket source; they do not work on this hub now."
- `AccountEditor`: the section after "Keys"; saving sends `tailnet` with the other fields; a 409 from the hub (a taken link, or the lock-out refusal) shows its text in the editor's alert. The list in `AccountsView` shows "Tailscale" in the sign-in column when an account has links (and "can sign in" is true with links only while `overview.tailscale` is not null).
- `SystemUsersTab`: the editor (today `SourcesEditor`) gets the same section and saves links with `setSystemTailnet` (and sources with `setSystemSources`, as now, only when they changed); the list shows the links with their kind.
- `SessionsTab`: the method column shows "Password", "Key" or "Tailscale (socket)" / "Tailscale (headers)" with the matched login or tag on its own line and, with the socket source, "on <device>".

- [ ] **Step 1: Write the failing tests:**
  - `web/test/admin.test.ts`: `setSystemTailnet("alice",["alice@github","tag:ops"])` sends `PUT /api/admin/system/alice/tailnet` with `{links:["alice@github","tag:ops"]}`; a 409 with `{"error":"this tag is linked to virt:guest"}` throws `AdminError` with that text.
  - `web/test/accountForm.test.ts`: `toInput` lowercases and trims links and drops empty ones; `fromView` then `toInput` keeps them; `linkKind` gives `login`, `tag` and null for `alice@github`, `tag:ci` and `tag:a_b`; `formProblems` names `tag:a_b` and a 17th link, and nothing for `alice@github` and `tag:ci`.
  - `acceptance.mjs`, "Accounts" check: in the editor of a fixture account, adding `alice@github` and `tag:ci` lists them labelled "Login" and "Tag", the tag shows the warning, and Save sends one `PATCH` with `tailnet:["alice@github","tag:ci"]`; a fixture 409 shows its text in the alert; `tag:a_b` shows the inline error and is not added; with `overview.tailscale: null` the off note shows; with `"headers"` and a tag listed the socket note shows; the System users tab adds `alice@github` to `alice` and sends one `PUT …/tailnet`; the Signed in tab shows "Tailscale (tag:ci)" for a fixture session; axe passes on the editor, the System users editor and the Signed in tab in light and dark; no horizontal overflow at 1365x900, 390x844 and 320x568; keyboard only: the field, Add and each Remove are reachable with Tab and work with Enter.
- [ ] **Step 2: Run** `npm test -w web`. Expected: FAIL.
- [ ] **Step 3: Implement** `TailnetLinks.tsx` and the changes, with the existing `acc-*` styles in `accounts.css`.
- [ ] **Step 4: Run** `npm test -w web`, `npm run typecheck` and the browser acceptance run in both browsers. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(web): administrators link tailnet logins and tags in the Accounts view"`.

### Task 7: Docs and chart

**Files:**
- Modify: `docs/security.md` (new section "Tailscale sign-in" under "Sign-in and sessions"; the "What answers without a session" list; the audit paragraph; the lock-out sentence in "Administrators"), `docs/configuration.md` (the three settings), `docs/install.md` (values table row, a section "Tailscale sign-in", and the recovery path in "First steps after turning sign-in on"), `k8s/values.yaml` (`auth.tailscale`), `k8s/templates/hub.yaml` (env, sidecar container, shared socket volume, serve configuration), `k8s/templates/_helpers.tpl` (render checks), `scripts/check-chart-defaults.py` (two checks), `web/test/browser/README.md` (the new checks)
- Create: `k8s/templates/hub-tailscale.yaml` (the serve ConfigMap, and with `stateSecret` the ServiceAccount, Role and RoleBinding for that one Secret)

**Interfaces:**
- Chart values exactly as in the spec ("Configuration and chart"). Render refusals: `auth.tailscale needs auth.enabled`; `auth.tailscale.sidecar needs authKey.secretName`; `auth.tailscale.sidecar needs image.repository`; `auth.tailscale.headers or socket needs proxies` (the sidecar fills the loopback entries itself).
- Sidecar: userspace networking, no added capability, socket in an `emptyDir` mounted at the same path in both containers, `FILEDECK_TAILSCALE_SOCKET` set to it, and with `serve: true` HTTPS 443 on the device to `http://127.0.0.1:<hub port>`. Hostname and image come only from values; the defaults are empty.
- `check-chart-defaults.py`: "the tailscale sidecar is off by default" (`    sidecar:\n      enabled: false`), "tailscale headers are off by default" (`    headers: false`).

- [ ] **Step 1:** `docs/security.md`: who can sign in with Tailscale (linked logins and tags only); the two sources and the listed proxies (with the warning that a listed proxy must carry only tailnet traffic and overwrite the identity headers); that tag sign-in works with the socket only, and a tagged device behind the headers source is refused; the resolution rule (login first, one account among tags, a conflict refuses); the tag risk in plain words: "Anyone who may apply a linked tag in your tailnet's ACLs, or who holds an auth key that carries it, can make a device that signs in as that account. The audit log then names the device and the tag, not a person."; the button, the bound session and what ends it (a tag taken off ends the session within 10 seconds); act as root still needing a password or key; the lock-out rule (links count only while a source is configured, tag links only with the socket) and the recovery path: the bootstrap file is used once, so add a system user to `FILEDECK_ADMINS` and restart the hub, or turn sign-in off for a moment, fix the configuration and turn it on again; the audit fields and reasons; and the threats paragraph of the spec in the docs' style. Add the two routes to "What answers without a session".
- [ ] **Step 2:** `docs/configuration.md`: `FILEDECK_TAILSCALE_SOCKET`, `FILEDECK_TAILSCALE_HEADERS`, `FILEDECK_TAILSCALE_PROXIES`, their start-up refusals and log lines, that they are read only with sign-in on, and that turning a source off can make links stop counting for the last administrator. `docs/install.md`: the values row, a section "Tailscale sign-in" with the sidecar (auth key Secret, ephemeral key or `stateSecret`, `trustedProxies: 1` for the sidecar, a public ingress next to it needing the same hop count, separate host names and `hub.allowedHosts`), the operator ingress with the headers source (its proxy pods' addresses in `proxies`; tag links do not work there), the first steps (link a login or tag in Accounts, open the tailnet address, press the button), and the recovery path in "First steps after turning sign-in on". Use only example names (`files.example`, `alice@github`, `tag:server`).
- [ ] **Step 3:** `k8s/values.yaml`, `k8s/templates/hub.yaml`, `k8s/templates/hub-tailscale.yaml`, `_helpers.tpl` and the neutral check, as above.
- [ ] **Step 4:** Run `npm run check:neutral`; `helm lint k8s`; `helm template t k8s` (no tailscale objects); `helm template t k8s --set auth.enabled=true --set agentToken.generate=true --set auth.tailscale.sidecar.enabled=true --set auth.tailscale.sidecar.image.repository=example/tailscale --set auth.tailscale.sidecar.image.tag=1 --set auth.tailscale.sidecar.authKey.secretName=ts` (a sidecar, the socket volume, `FILEDECK_TAILSCALE_SOCKET` and `FILEDECK_TAILSCALE_PROXIES` with the loopback entries); the same without `auth.enabled` fails with `auth.tailscale needs auth.enabled`. Expected: as stated.
- [ ] **Step 5:** Commit with `git commit -m "docs(auth): Tailscale sign-in with logins and tags; recovery path; chart values for a tailscaled sidecar"`.

### Task 8: Full verification, browser acceptance and the check on a real tailnet

**Files:**
- Modify: `TASKS.md` (row 20.177 notes), nothing else unless a check fails

- [ ] **Step 1:** Run the whole server suite with a private `TMPDIR`, `npm test -w web`, `npm run typecheck`, `npm run check:neutral` and `helm lint k8s`. Expected: all pass.
- [ ] **Step 2:** Run the browser acceptance in Chromium and Firefox (`web/test/browser/README.md`), including "Sign in" and "Accounts". Expected: PASS, axe clean in light and dark.
- [ ] **Step 3: End to end on Thomas's real tailnet, with an ephemeral key.**
  - **The key.** The agent that runs this task does not call `request_secret` itself. It asks the coordinator for a short-lived, ephemeral, single-use auth key. The coordinator gets it from Thomas through T3's `request_secret`, delivered to a file, and passes on only the file's path. The key is never in chat, in git, in a log line, in a command line that is logged, or in the repository: tailscaled reads it from the file (`--authkey=file:<path>`, or `TS_AUTHKEY` read from the file into the environment of that one process). Delete the file when the node has joined.
  - **The node.** Make a private temporary folder (`mktemp -d`, mode 0700) for tailscaled's state and socket. Run tailscaled in userspace mode with that state folder and socket, as an ephemeral node (the key is ephemeral), with `--statedir` and `--socket` inside that folder and never a shared path, with a test host name that has no real infrastructure name in it. Run the hub locally (a private `TMPDIR`, `FILEDECK_AUTH=on`, one local agent as in the development docs) with `FILEDECK_TAILSCALE_SOCKET=<the socket>`, `FILEDECK_TAILSCALE_PROXIES=127.0.0.1/32,::1/128`, `FILEDECK_TRUSTED_PROXIES=1`, and `tailscale serve --https=443 http://127.0.0.1:<hub port>` on the test node. Do Task 1 Step 0 here if it was not done yet.
  - **The checks**, in a real browser on a device of Thomas's tailnet (ask the coordinator which device and which test login to use; link that login to a test virtual account, and a tag that Thomas names to another): the button shows over the tailnet address and not over `http://127.0.0.1`; pressing it signs in; sign-out holds after a reload; removing the link in Accounts signs the browser out at its next request; a tagged device (if Thomas has one) signs in through the tag link, and the audit line names the tag; a request with a forged `Tailscale-User-Login` sent to the hub from an address that is not listed (for example the machine's own LAN address, not loopback) gets no identity; the hub log shows the `tailnet` audit fields and no socket path and no key. Then repeat the sign-in with `FILEDECK_TAILSCALE_HEADERS=on` instead of the socket and check that the tag link is refused with reason `unlinked`.
  - **Clean-up**, also when a check fails: `tailscale logout` on the test node (an ephemeral node is then removed from the tailnet), stop tailscaled and the hub, delete the temporary folder and any key file, and confirm with the coordinator that the node no longer shows in the tailnet. Record what was checked on the board row, without the key, the device's tailnet address or any infrastructure name.
- [ ] **Step 4:** Ask for a review of the whole branch (superpowers:requesting-code-review), with the Review Focus above as the brief. Fix what it finds and run Steps 1 and 2 again.
- [ ] **Step 5:** Update row 20.177 in `TASKS.md` (status, what was checked and how) and commit with `git commit -m "docs(tasks): 20.177 Tailscale sign-in verified"`.
