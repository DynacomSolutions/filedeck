# Tailscale sign-in: design

Status: draft for approval, 18 Nov 2026.

## Intent

Filedeck v0.4.0 has sign-in: system accounts (PAM password, SSH key) and virtual accounts (password, key), all at the hub. Many people reach Filedeck over a tailnet, where Tailscale already knows who they are. This adds a third way to prove who you are: the person's tailnet login (for example `alice@github`), linked by an administrator to a Filedeck account. The session, worker, epoch and audit model of `2026-11-17-authentication-design.md` does not change; Tailscale is only a new way to start a session.

## Goals

- A person on a tailnet device signs in with one click, with no password, when an administrator has linked their tailnet login to a virtual account or a system user.
- Two identity sources, both off by default:
  - **socket**: the hub asks tailscaled through its LocalAPI unix socket (`/localapi/v0/whois`) who owns the client's tailnet address;
  - **headers**: the hub reads the Tailscale Serve identity headers (`Tailscale-User-Login`, `Tailscale-User-Name`) that `tailscale serve` or the Kubernetes operator's ingress set.
- Nothing a client sends can fake a tailnet identity.
- A linked system user passes the same checks as at a password sign-in: never root (uid 0, gid 0, group 0), only machines where the account exists, epochs.
- Administrators link and unlink tailnet logins in the Accounts view, for virtual accounts and system users.
- The audit log records the tailnet login, the device (when known) and the identity source of each Tailscale sign-in and of each request made with such a session.

## Non-goals

- Signing in with a tailnet identity when Filedeck's sign-in is off (`FILEDECK_AUTH` not `on`). Nothing changes then.
- Automatic accounts: an unlinked tailnet login is refused. There is no "every member of the tailnet is a guest" mode.
- Links for tagged devices (see decision 3).
- Mapping Tailscale ACL groups or capabilities (`CapMap`) to Filedeck admin rights or grants.
- Acting as root with a tailnet identity alone (see decision 6).
- Tailscale Funnel: Funnel requests carry no identity, so they can only use the existing sign-in.

## Anti-goals (a failure even if it works)

- A client that sends `Tailscale-User-Login` itself, from any path, is signed in as that login.
- A request that reaches the hub through a public ingress is signed in by a tailnet identity.
- A tailnet sign-in reaches root's rights, or a name that is root on a machine.
- A visit to the page signs someone in without an action of theirs (a shared or borrowed device).
- When the identity source fails, the hub quietly uses another one (the socket fails, so the headers are believed).
- A Tailscale link is the only way left for the last virtual administrator to sign in.

## Constraints from the current code

- The hub serves plain HTTP only. Sign-in needs HTTPS (`secure()` in `server/src/auth/routes.ts`: a TLS socket, or `X-Forwarded-Proto: https` with `FILEDECK_TRUSTED_PROXIES` above 0), and the cookie is `__Host-filedeck` with `Secure`. So every real deployment has a TLS proxy in front of the hub, also on the tailnet. The hub never sees a tailnet device as its socket peer in a working sign-in; it sees the proxy.
- `FILEDECK_TRUSTED_PROXIES` is a count of hops. It decides which `X-Forwarded-For` entry is the client address for the audit log and the limits. It does not check that the socket peer really is a proxy: a client that reaches the hub directly can write any `X-Forwarded-For` it likes. That is acceptable for an audit address and not acceptable for an identity.
- The gate (`registerAuth`) admits a request by its session cookie and puts the identity in `userContext`. Sessions (`sessions.ts`) store kind, name, times, epoch, act-as-root end and address.
- The agents' `POST /api/auth/lookup {name}` answers `{exists}`, and `{exists:false, refused:true}` for uid 0, gid 0 or group 0 (`agent-auth-routes.ts`). The hub calls it with the agent token only (`AgentSystemAuth.exists`).
- Every change to an account goes through `accountChanged` (epoch raised, sessions, streams, proxied calls and jobs ended). The admin routes hold each check and its writes in one store transaction (`accounts.tx`) with no `await` inside.
- `lockOut` counts a virtual administrator as "can sign in" when it has a password or a key.

## Approaches considered

**A. Explicit button, a normal session bound to the tailnet identity (chosen).** The sign-in page shows "Sign in with Tailscale as alice@github" when the hub sees a tailnet identity for the request. A click starts a normal session with the usual limits. On every later request the hub checks that the request still comes with the same tailnet identity.

**B. Automatic sign-in on page load.** Simplest for the person, and what many tailnet tools do. Rejected: signing out would not hold (the next load signs in again), a borrowed or shared device signs in whoever owns it in the tailnet without them knowing, and any page that can make the browser load the hub can start a session. A button costs one click.

**C. No session: the tailnet identity on every request is the session.** No cookie at all, the tailnet decides everything. Rejected: it needs a different gate, does not fit sign-out, the act-as-root switch (kept per session), the "Signed in" tab or the event stream checks, and each request would pay an identity lookup with no cache.

## Decisions

1. **Sign-in starts with a button.** The sign-in page asks `GET /api/auth/tailnet`. When it gives a login, the page shows a "Sign in with Tailscale" button with the login, above the name and password form. Nothing happens until the person presses it. The button sends `POST /api/auth/login-tailscale` with an empty JSON body: the state-changing request goes through the request guard's origin checks (`SameSite=Lax` plus `Sec-Fetch-Site`/`Origin`), so another site cannot start it. A cross-site sign-in would anyway only sign the victim in as their own tailnet login.
2. **The session is a normal session, bound to the tailnet identity.** It has the same idle and absolute limits, the same epoch and the same end on sign-out. It also stores the method (`tailscale`), the login and, with the socket source, the device's stable id. On every request admitted with such a session, the gate reads the tailnet identity again (with the cache below) and:
   - same login (and, with the socket, same device): admitted;
   - a different login or device: the session ends and the request answers 401 signed out (the device changed hands, or the address was given to another device);
   - no tailnet identity (the request came another way, for example through a public ingress with the same host name): 401 signed out, and the session is kept for when the person comes back over the tailnet;
   - the source cannot answer (socket down): 503 `{"error":"tailnet identity unavailable"}`, and the session is kept.

   So a login that is unlinked ends at once (the link change raises the epoch), and a device that leaves the tailnet loses access at its next request: its address no longer resolves (socket), or the proxy no longer sends headers for it. Hub jobs that the account started keep running, as for any session that ends; they belong to the account (unlinking raises the epoch, which cancels them).
3. **No tag links in this version.** A tagged device (whois gives `Node.Tags`, or no user) is always refused, and the admin routes refuse a login that starts with `tag:` or is `tagged-devices`. Why: a tag names a machine role, not a person, so the audit log would lose who acted; anyone who may apply the tag (its tag owners, or anyone with an auth key for it) can make new devices with it, so the link would give the account to a group that Filedeck cannot see; and the headers source never gets an identity for tagged devices (Tailscale Serve sends no identity headers for them), so tag links would work with one source only. The link table keeps a `kind` column so tag links can be added later without a migration.
4. **Links are made by administrators and kept in the auth database.** Table `tailnet_links (login TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL)`. The primary key makes a login linked to at most one account: a second link is refused with 409 `this tailnet login is linked to <kind>:<name>`. At most 16 logins per account. Every change to an account's links runs in the store transaction with the other writes, raises the account's epoch and then runs `accountChanged`, like every other account change. Deleting a virtual account deletes its links in the same transaction. A virtual account and a system user of the same name have separate links.
5. **A linked system user is checked by the machines at every Tailscale sign-in.** The hub asks the agents' lookup in the sign-in order (`FILEDECK_AUTH_NODES`, else `NODES`), with the same 20-second total limit as a password sign-in: the first `exists:true` signs in; `refused` (uid 0, gid 0 or group 0) ends the attempt as a failure, whatever later machines say; `exists:false` or no answer goes on to the next machine; no machine said yes: failure. `root` is refused before any call, at link time and at sign-in. After sign-in the presence refresh starts as for a password sign-in, so machines without the account stay hidden. The agents still refuse uid 0 per request, and the epoch works as today.
6. **Act as root needs a password or a key.** `POST /api/auth/as-root` does not change: it asks for the system administrator's password (PAM) or a fresh key signature. A session started with Tailscale can turn the switch on only with that proof. A tailnet login proves who owns a device, and the device may be unlocked and unattended; root on every machine needs a fresh proof of the person.
7. **Lock-out: a Tailscale link does not count.** `lockOut` is unchanged: when `FILEDECK_ADMINS` is empty, at least one virtual administrator must keep a password or a key. A link depends on the tailnet, the proxy and the socket staying up and configured; a broken sidecar must not lock every administrator out. Administrators who sign in with Tailscale keep their rights (the admin flag and `FILEDECK_ADMINS` decide, not the method). The first administrator still comes from `FILEDECK_ADMINS` or `FILEDECK_BOOTSTRAP_ADMIN_FILE`; there is no Tailscale bootstrap setting.
8. **Validation of logins.** A login is trimmed and lowercased, then must match `` ^[a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*$ `` and be at most 254 characters. This takes the forms Tailscale gives (`alice@example.com`, `alice@github`, `alice@passkey`). `tagged-devices` and anything that starts with `tag:` are refused. The same rule cleans what the sources give before it is compared with the links: a value that does not pass is "no identity", never a near match.
9. **Errors at sign-in say little.** An unlinked login, a tagged device, a linked system user that no machine vouches for, and a refused name all answer 401 `{"error":"sign-in failed"}` after the usual 500 ms floor, under the sign-in limiter (name key `tailnet:<login>`, and the client address). The page then says "Tailscale sign-in failed. Your tailnet login may not be linked to an account here; ask an administrator." A person can only test their own login, so this hides nothing from others; it keeps the answer the same as the other methods.

## Design

### Identity sources

One module, `server/src/auth/tailnet.ts`, gives `tailnetIdentity(c): Promise<TailnetIdentity | "none" | "unavailable">` with `TailnetIdentity = { login: string; displayName?: string; node?: { name: string; stableId: string }; address?: string; source: "socket" | "headers" }`. It is the only code that reads the sources.

**Trusted Tailscale proxies.** `FILEDECK_TAILSCALE_PROXIES` is a list of IP addresses and CIDR ranges: the proxies that carry only tailnet traffic to the hub, for example a sidecar that runs `tailscale serve` (`127.0.0.1/32,::1/128`) or the operator's ingress proxy pods. A request is a tailnet request only when its socket peer (the TCP peer, `getConnInfo`, never a header) is in that list. Every other request has no tailnet identity, whatever it sends. This list is separate from `FILEDECK_TRUSTED_PROXIES`, because that one is a count and does not check the peer. It has no default: with a source on and an empty list the hub does not start, with `FILEDECK_TAILSCALE_PROXIES is needed when FILEDECK_TAILSCALE_SOCKET or FILEDECK_TAILSCALE_HEADERS is set`. A listed proxy must not also carry public traffic, and the docs say so: a proxy that passes a public client's own `Tailscale-User-Login` through would let anyone sign in.

**Headers source** (`FILEDECK_TAILSCALE_HEADERS=on`, used only when no socket is set): for a request from a listed proxy, `Tailscale-User-Login` is the login and `Tailscale-User-Name` the display name (an RFC 2047 encoded word is decoded; a value with control characters is dropped). A header that occurs more than once, or a login that fails decision 8, is "none". Tailscale Serve removes these headers from what the client sends and sets them only for user-owned devices, never for tagged devices or Funnel; the docs state that the hub depends on this for the listed proxies. There is no device information in this source.

**Socket source** (`FILEDECK_TAILSCALE_SOCKET=<path>`): for a request from a listed proxy, the client's tailnet address is the last `X-Forwarded-For` entry (the one the listed proxy wrote; `hopAddress` cleans it), whatever `FILEDECK_TRUSTED_PROXIES` says. An address outside the tailnet ranges (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) is "none". The hub then asks `GET /localapi/v0/whois?addr=<address>` on the socket (`Host: local-tailscaled.sock`, 2-second limit, at most 8 calls at once). From the answer it takes `UserProfile.LoginName`, `UserProfile.DisplayName`, `Node.Name`, `Node.StableID` and `Node.Tags`. A node with tags, or the `tagged-devices` user, is "none" with a `tagged` flag (the sign-in page can say why). A 404 (no such peer) is "none". A socket that cannot be reached, a timeout, a status other than 200 or 404, or a body that does not parse is "unavailable". The hub never then reads the headers: there is no fallback.

**Cache.** Socket answers are kept per address for 10 seconds (at most 1024 addresses; the oldest goes first). Never per connection: a proxy reuses one connection for many clients. A tailnet address that is given to another device is therefore seen within 10 seconds, and the session binding (decision 2) ends a session that sees a different device.

**Stripping.** On every request, the hub deletes the `Tailscale-User-*` headers before any route runs, after `tailnet.ts` has read them. They never reach an agent, a network source or a log line. (The hub already forwards only allowed headers to agents; this makes it explicit.)

**Both set.** When `FILEDECK_TAILSCALE_SOCKET` and `FILEDECK_TAILSCALE_HEADERS` are both set, the socket is used and the hub logs one line at start that the headers setting is ignored.

### Routes

- `GET /api/auth/tailnet` (no session needed; in `AUTH_ROUTES`): `{login, displayName?, node?}` when the request has a tailnet identity, `{tagged: true}` for a tagged device, `{}` otherwise, and 503 `{"error":"tailnet identity unavailable"}` when the source cannot answer. With no source configured it answers `{}` and makes no call. It never says whether the login is linked.
- `POST /api/auth/login-tailscale` (body `{}`): HTTPS as for the other sign-in routes (`secure()`), then the sign-in limiter, then the identity, the link, and for a system user the machines (decision 5). Success answers as `/api/auth/login` does and sets the cookie; the session stores `method = 'tailscale'`, `tailnet_login` and `tailnet_node` (the stable id, socket source only). A new sign-in in the same browser replaces the old session, as today.
- `GET /api/auth/me` adds `method` (`password`, `key` or `tailscale`) and, for a Tailscale session, `tailnet` (the login), so the account menu can show it.
- With sign-in off neither route exists, and `GET /api/auth/me` still answers `{"auth":false}`.

### Sessions

`sessions` gains three columns, added with `ALTER TABLE` when missing (as `address`): `method TEXT` (NULL for sessions made before this version, which count as password or key), `tailnet_login TEXT` and `tailnet_node TEXT`. `create` takes them. `lookup` returns them. The gate checks the binding (decision 2) after `lookup` and before `admit`, and only for `method = 'tailscale'`. `SessionInfo` (the "Signed in" tab) gains `method` and `tailnet`.

### Admin API and screens

- `AccountView` and `SystemView` gain `tailnet: string[]` (the linked logins, sorted).
- `POST /api/admin/accounts` and `PATCH /api/admin/accounts/:name` take `tailnet: string[]` (the whole list; `[]` removes every link). `PUT /api/admin/system/:name/tailnet {logins: string[]}` does the same for a system user. Each login goes through `account-input.ts` `tailnetLogin` (decision 8); a login linked to another account is 409; more than 16 is 400. The links are written in the same transaction as the other fields, and the epoch is raised there; `accountChanged` follows after the commit.
- Linking a system user asks the machines first (as for a run-as user): when at least one machine answers and every machine that answers says the name does not exist or is root, the change is refused with 400 `no machine has a system user <name>`. A machine that does not answer blocks nothing; decision 5 checks again at each sign-in.
- The system users list (`GET /api/admin/accounts`, `system`) also lists names that have a link.
- `GET /api/admin/overview` gains `tailscale: "socket" | "headers" | null`, so the screens can say when Tailscale sign-in is off on this hub. Links can be made while it is off (to prepare), with that note.
- The audit body of an admin call keeps `tailnet` and `logins` (logins are not secrets).
- Web: the account editor gets a "Tailscale" section (list of linked logins, a field to add one, Remove per login, the note when off). The System users tab gets the same section in its editor, and shows the logins in its list. The "Signed in" tab shows "Tailscale (alice@github)" as the method of such a session. The sign-in page gets the button (decision 1). The account menu shows "Signed in with Tailscale as alice@github" for such a session.

### Audit

- The sign-in line of `POST /api/auth/login-tailscale` has `tailnet: {login, source, node?, address?}` (node: the device name; address: its tailnet address, socket source only), the status and the client address as today. An unlinked or tagged attempt is written the same way, with the login (or `tagged: true`) so administrators can see who tried.
- Every audit line of a request admitted with a Tailscale session has `tailnet: {login, source}`.
- A 401 or 503 that the binding check gives is written with the session's login.
- Nothing about the socket path or the raw whois answer is logged. The hub logs one line, at most once a minute, when the socket is unavailable.

### Configuration and chart

| Setting | Where | Meaning |
|---|---|---|
| `FILEDECK_TAILSCALE_SOCKET` | hub | Path of tailscaled's LocalAPI socket; turns the socket source on |
| `FILEDECK_TAILSCALE_HEADERS` | hub | `on` turns the headers source on (ignored when the socket is set) |
| `FILEDECK_TAILSCALE_PROXIES` | hub | IPs and CIDR ranges of the proxies that carry tailnet traffic; needed when a source is on |

All three are read only with `FILEDECK_AUTH=on`; with sign-in off, a set value gives one log line at start and nothing else. A value of `FILEDECK_TAILSCALE_PROXIES` that is not a valid list stops the start.

Chart values, all off by default (`npm run check:neutral` gets a check that `auth.tailscale.sidecar.enabled` is false and `auth.tailscale.headers` is false):

```yaml
auth:
  tailscale:
    headers: false        # FILEDECK_TAILSCALE_HEADERS
    socket: ""            # FILEDECK_TAILSCALE_SOCKET; set by the sidecar when it is on
    proxies: []           # FILEDECK_TAILSCALE_PROXIES; the sidecar adds 127.0.0.1/32 and ::1/128
    sidecar:
      enabled: false      # a tailscaled container in the hub pod
      image: {repository: "", tag: "", digest: ""}
      authKey: {secretName: "", key: authkey}   # a Secret made out of band
      hostname: ""        # the device name on the tailnet
      serve: true         # tailscale serve: HTTPS on the tailnet to the hub's port
      stateSecret: ""     # optional Secret for tailscaled state (adds a Role for that Secret only); empty = an emptyDir
      extraArgs: []
      resources: {}
```

With the sidecar on, the chart: runs tailscaled in userspace mode (no `NET_ADMIN`, no `/dev/net/tun`), with its socket in an `emptyDir` shared with the hub container; sets `FILEDECK_TAILSCALE_SOCKET` to that socket; adds the loopback addresses to `FILEDECK_TAILSCALE_PROXIES`; and, with `serve: true`, gives tailscaled a serve configuration that sends HTTPS on port 443 of the device to the hub's port. It refuses to render with the sidecar on and sign-in off (`auth.tailscale needs auth.enabled`), or with no auth key Secret. The image has no default, so the operator picks and pins it. The docs note that `FILEDECK_TRUSTED_PROXIES` must count the sidecar (1) so that `X-Forwarded-Proto` is read, and that a hub reached also through a public ingress needs that ingress to use the same number of hops.

### Threats

- **Header spoofing.** Only a request whose TCP peer is a listed proxy can have an identity. Headers from any other peer are ignored and stripped. A repeated header is refused. The listed proxy must overwrite these headers (Tailscale Serve does) and must not carry public traffic; this is the one thing the operator must get right, and the docs say it in the install section and in `docs/security.md`.
- **Forged `X-Forwarded-For`.** The socket source takes the address only from a listed proxy's last entry, never by hop count, so a client that reaches the hub directly cannot pick an address. A listed proxy that appends the real peer (Tailscale Serve does) gives the true address.
- **Socket unavailable.** The routes answer 503 and the button says Tailscale sign-in is unavailable. Password and key sign-in work as before. There is no fallback to the headers. Tailscale sessions get 503 per request until it comes back.
- **A tailnet address reused.** whois is asked again at most 10 seconds after the last answer; a session stores the device's stable id and ends when another device answers for the address.
- **The hub reached over the tailnet and over a public ingress.** The ingress is not a listed proxy, so no request through it has a tailnet identity; the button does not show there. A Tailscale session's cookie used through the ingress (same host name) gets 401, because that request has no tailnet identity. Using separate host names for the two paths keeps the `__Host-` cookies apart, and `FILEDECK_ALLOWED_HOSTS` should list both.
- **Accidental sign-in on a shared device.** No automatic sign-in (decision 1); sign-out holds.
- **A stolen tailnet identity** (a lost unlocked device, a taken-over identity provider account) gives the linked account's normal rights until the device is removed from the tailnet or the link is removed, never root (decision 6).
- **A linked system user that is root on a machine** is refused at link time when a machine says so and at every sign-in (decision 5), and the agents refuse uid 0 per request.

### Behaviour with sign-in off

Nothing changes. The Tailscale settings are not read (one log line if set), the new routes do not exist, no header is stripped, and `GET /api/auth/me` answers `{"auth":false}`. The chart refuses the sidecar without `auth.enabled`.

## Order of work

1. Identity sources (`tailnet.ts`, config), with a check against a real `tailscale serve` of which headers it sends.
2. Link store and login validation.
3. Sign-in route, session binding, system user check, audit.
4. Admin API for links.
5. Sign-in page button.
6. Link management in the account editor, the System users tab and the Signed in tab.
7. Docs and chart.
8. Full verification and browser acceptance.

The plan is `docs/superpowers/plans/2026-11-18-tailscale-sign-in.md`.

## Decided by the builder

- The exact layout of `tailnet.ts` (one class or functions), and how the fake LocalAPI server in tests is built (a unix socket in the private `TMPDIR`).
- How RFC 2047 decoding is done (a small decoder for `=?utf-8?q?...?=` and `?b?`; anything else is kept as it is).
- The serve configuration format the sidecar gets (a ConfigMap with tailscale's serve JSON, or the `TS_SERVE_CONFIG` file), as long as it is generic and has no host names in the chart defaults.
- The wording of the screens, inside the decisions above.
