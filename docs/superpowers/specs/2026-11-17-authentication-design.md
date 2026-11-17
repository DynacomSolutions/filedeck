# Authentication and per-user access: design

Status: draft for approval, 17 Nov 2026.

## Intent

Today Filedeck has no accounts. Anyone who can reach the hub can do anything, and every agent does its file work as root (`docs/install.md`). This adds sign-in and makes each person's file work happen with that person's own rights, enforced by the kernel, not only by Filedeck.

Several kinds of people will use one deployment:

- **System users**: people with real accounts on the machines. They sign in with their machine password (PAM) or an SSH key, and see exactly what their account can see.
- **Virtual accounts**: accounts created in Filedeck, like virtual users on an FTP server. Each runs as a system user chosen by an admin and is limited to the folders it is granted.
- **Admins**: they manage virtual accounts and grants.

## Goals

- Nothing except `/healthz`, the sign-in page and its assets answers without a signed-in session (or the existing `du` API token for `/api/du`).
- Password sign-in, checked by PAM on the agents.
- SSH key sign-in: the browser signs a one-time challenge with a key file the user picks. The machine checks the signature against that user's `~/.ssh/authorized_keys`. The private key never leaves the browser.
- Virtual accounts with a password, a "run as" system user per machine, and folder grants per machine (read-only or read-write).
- File work for a signed-in person runs in a process with that person's uid, gid and supplementary groups. For virtual accounts it is also confined by Landlock to the granted folders, with write rights only where granted.
- The audit log records the account for every request.

## Non-goals (this design)

- Single sign-on (OIDC, SAML) or sign-in through a reverse proxy header. These can be added later as other ways of proving who you are. The session and worker model below does not change for them.
- Two-factor authentication beyond what PAM itself asks for. A PAM conversation with more than one prompt is out of scope for the first version (see "PAM").
- Quotas, bandwidth limits, and sharing links for people without an account.
- Mapping one Filedeck name to different local names on different machines. The same name is used on every machine.

## Anti-goals (a failure even if it works)

- A signed-in person can read or write anything their account could not read or write over SSH.
- A virtual account can reach anything outside its grants, through links, `..`, archives, git, search, thumbnails or jobs.
- A private key, password or session secret appears in a log, a URL, the audit log or an error message.
- Signing in as root, or a virtual account reaching root's rights in any way.
- Turning authentication on breaks a deployment that has no PAM accounts. There must be a working path with only virtual accounts.
- Every request gets noticeably slower. A worker is started once per user per machine and then reused.

## Constraints from the current code

- The hub (`server/src/hub.ts`) serves the web app, runs bulk jobs (`ops-queue.ts`), folder compare, transfers between machines and network sources (`sources/`). It reaches agents over HTTP with an optional shared bearer token (`agent-auth.ts`, `FILEDECK_AGENT_TOKEN`). The hub is in a container and has no machine accounts.
- An agent (`server/src/agent.ts`) runs as root with the machine's `/` at `FILEDECK_ROOT`. It does all file work inside its own Node process (`fsops.ts`, pinned descriptors, read-only prefixes). Helper programs (git, bsdtar, 7zz) are started through `filedeck-sandbox` (`server/native`), which can already change user, clear capabilities, and apply Landlock and seccomp.
- Node cannot change user for one request at a time. `process.setuid` changes the whole process.
- The hub already keeps an encrypted SQLite store, the vault (`vault.ts`, archive passwords), and a job store.
- Without `FILEDECK_AGENT_TOKEN`, an agent cannot tell the hub from any other caller. Per-user access requires the agent token, so turning authentication on makes the token required.

## Approaches considered

**A. A worker process per user on each agent (chosen).** The agent's root process keeps only what needs root: checking sign-ins and starting workers. For each signed-in person it starts a worker with their uid, gid and groups, no capabilities, and for virtual accounts a Landlock ruleset for their grants. All of that person's file routes run in the worker. The kernel enforces access, except while an admin has switched on "act as root". This is the biggest change, because every file route must work inside a worker.

**B. Root agent with its own permission checks.** The agent stays root and checks mode bits and ACLs before each operation. Much cheaper, but the kernel does not enforce it. ACLs, races between the check and the use, and the many helper paths make it leaky. Rejected: it does not give access at a system level.

**C. Go through the machine's own sshd.** Each person's files are reached over SFTP to localhost, reusing `sources/sftp.ts`. OpenSSH does sign-in and access. Rejected: git, archives, thumbnails, transcoding, search, watching and folder sizes would all be lost for these users.

## Design

### Accounts and identity

- **System user**: identified by a name. On each machine the agent looks the name up in that machine's account database (NSS, so `/etc/passwd`, LDAP or SSSD all work) and acts as that local account. If a machine has no account with that name, the machine is hidden from the person and every request to it answers 403.
- **Virtual account**: stored on the hub. It has a name (never equal to a system user's name on any machine; the hub refuses to create a clash it can see), a password hash (scrypt, from Node's `crypto`), an admin flag, and per machine either nothing (machine hidden) or:
  - `runAs`: a local user name on that machine. Root is refused. The admin chooses a dedicated user, or a shared guest-like user.
  - `grants`: a list of `{ path, write: boolean }`. Paths are absolute virtual paths, as `FILEDECK_READONLY` uses.
- **Acting as root (decided)**: nobody signs in as root (uid 0 and any name that resolves to uid 0 are refused at sign-in). A system user who is an admin can switch on "act as root" for their session, like `sudo`, after typing their password again (or signing a fresh key challenge). Their requests then run in the agent's root process exactly as Filedeck works today. The switch lasts 15 minutes or until switched off, is shown clearly in the header, and every request made with it is audited with `"asRoot":true`. Virtual accounts can never use it, even with the admin flag.
- **Admins**: system users named in `FILEDECK_ADMINS` (a comma-separated list), plus virtual accounts with the admin flag. The first admin must be a system user from that setting, or a virtual account seeded from a file (`FILEDECK_BOOTSTRAP_ADMIN_FILE`, holding name and password hash). That way a deployment without PAM can still be set up.
- **Network sources** (SFTP, WebDAV, S3, SMB) use the hub's own credentials. They are not tied to any machine account, so access to them is a grant on the hub: an admin lists which accounts may use each source, read-only or read-write. A system user has no source access unless granted. Enforcement for sources is Filedeck's own check, because the hub holds one set of credentials. This is stated in the docs as a weaker guarantee than for machines.

### Sign-in

All sign-in goes through the hub. The hub never checks a system password itself: it asks agents.

- **Password, system user**: the hub sends the name and password to one agent that knows the name (the "sign-in machine" order: `FILEDECK_AUTH_NODES`, else the order of `NODES`). The agent runs PAM with the service `filedeck` (`/etc/pam.d/filedeck`, which the image does not ship; the install docs show one that includes the machine's normal stack). It returns success or a fixed failure code. PAM runs in a small native helper, `filedeck-pam` (built in `server/native` beside `filedeck-sandbox`), started per attempt, so libpam and its modules never load into the agent's Node process.
- **The host's own PAM and NSS (decided)**: the agent image is Alpine (musl), which cannot load the machine's glibc PAM modules or use its NSS (LDAP, SSSD). So `filedeck-pam`, and a sibling `filedeck-id` that resolves a name to uid, gid and groups, `chroot` into the machine's root (`FILEDECK_ROOT`) and run there, against the machine's own libc, `libpam.so.0` and NSS modules. Whatever works for SSH on that machine (local files, LDAP, SSSD through its socket) works here. This needs the `SYS_CHROOT` capability on the agent container, added by the chart only when authentication is on. The helpers drop it, and every other capability, before they touch PAM. A machine without glibc, or where the helper cannot run, refuses system sign-in and says so at start-up. Virtual accounts still work there. *Left to the builder:* how a helper shipped in the image runs against the host's libc after the `chroot`, for example a static helper that `dlopen`s the host's libraries, or one copied into a private root-owned folder under the host's `/run` and built against an old glibc baseline. The one rule is that nothing from the host loads into the agent's own process. The password reaches the helper over a pipe, never on the command line or in the environment. Only single-prompt conversations (one password prompt) are supported. A module that asks more fails with a clear code.
- **Password, virtual account**: checked against the hash on the hub.
- **SSH key, system user**: the hub issues a random challenge (32 bytes, valid 60 seconds, one use) bound to the name. The browser reads the key file the user picks (OpenSSH format, Ed25519 or ECDSA P-256; RSA is out of scope for the first version, and an encrypted key asks for its passphrase in the page), signs `"filedeck-login-v1" || hub id || name || challenge` with WebCrypto, and sends the public key and signature. The hub asks the sign-in machine's agent to check that the public key is listed in that user's `authorized_keys` (read as that user, through a worker or the launcher, never as root; `from=`, `command=` and other options make the key not usable for Filedeck) and that the signature verifies. The key file is read in the browser only and is never uploaded.
- **SSH key, virtual account**: an admin may add public keys to a virtual account. The check is the same, against those keys on the hub.
- The page offers "Password" and "Key file". A failed attempt always gives the same message and takes the same time, whether the name exists or not. Attempts are limited per name and per client address (5 per minute, then a growing delay).

### Sessions

- **HTTPS is required (my call)**: with authentication on, the hub refuses sign-in on plain HTTP except from localhost. HTTPS is detected from the connection or, through `FILEDECK_TRUSTED_PROXIES`, from `X-Forwarded-Proto`. Browsers only offer `crypto.subtle` (needed for key sign-in) and `__Host-` cookies over HTTPS, and a password over plain HTTP is not acceptable anyway.
- On success the hub sets a session cookie (`__Host-filedeck`, `Secure`, `HttpOnly`, `SameSite=Lax`, random 32 bytes). The hub stores only its hash with the account, kind, created time and last-use time in a SQLite file beside the vault.
- Idle timeout is 8 hours and absolute lifetime 7 days (settings). Sign-out and an admin's "end sessions" remove rows.
- State-changing requests keep the existing `requestGuard` origin checks. No separate CSRF token is added, because `SameSite=Lax` plus the origin checks already cover it.
- The `du` API token (`api-token.ts`) keeps working as now, read-only. It acts as an admin-chosen account (`FILEDECK_API_TOKEN_ACCOUNT`) so it, too, only sees what that account sees.

### Hub to agent

- The agent token becomes required when authentication is on. The agent refuses to start with authentication on and no token.
- On every request the hub sends `x-filedeck-user`: a small signed object `{kind, name, runAs?, grants?, asRoot?, epoch}` for this machine. It is signed with HMAC under the agent token, with a timestamp. The agent rejects a missing, expired (over 60 seconds) or badly signed header. A client's own copy is dropped, like `x-filedeck-client`.
- Bulk jobs on the hub record the account that started them and send that account's header for every step. A copy between two machines therefore reads as the person on one and writes as the person on the other. Jobs are listed only to their owner and to admins.
- **Revocation takes effect at once (my call)**: `epoch` is a counter per account that the hub raises when the account is deleted, its password, keys or grants change, or an admin ends its sessions. An agent that sees a higher epoch stops that account's workers and starts new ones on the next request. Deleting an account or ending its sessions also cancels its running jobs on the hub and its archive jobs on agents. A change to a system user's groups on the machine is picked up when a worker starts, and workers stop after idling.

### Workers on the agent

- The agent's root process keeps routing, sign-in checks (PAM helper, key check) and worker management. Every file route is passed to the worker for the identity in the header.
- **Starting a worker**: the agent resolves the local account (uid, gid, supplementary groups from NSS on that machine) and starts `node dist/worker.js` through `filedeck-sandbox` with that user and groups. All capabilities are cleared, no-new-privileges is set and the seccomp filter is on. For a virtual account it also applies a Landlock ruleset: read under each grant, write only under grants with `write: true`, plus the read-only system folders Node needs to start. Two virtual accounts with the same `runAs` but different grants get separate workers.
- **Talking to a worker**: over a private unix socket pair the agent creates before starting the worker (no path on disk). The agent forwards the HTTP request (method, path, headers it allows, body as a stream) and streams the response back. The worker runs the same Hono routes the agent has today (`fsops`, archives, git, search, thumbnails, transcoding, props, diff, trash), with `root` and read-only prefixes as now.
- **Lifetime and memory (my call)**: a worker exits after 10 minutes without requests (setting), and at most `FILEDECK_MAX_WORKERS` (default 6) run at once. Each worker runs with `--max-old-space-size=96`. The agent's memory limit in the chart rises from 512Mi to 1Gi only when authentication is on, and the upgrade notes say so. Past that, the least recently used idle worker is stopped. A worker that dies is restarted on the next request. A request in flight on a dying worker gets a 503.
- **Helpers inside a worker**: git, bsdtar and 7zz are started from the worker through `filedeck-sandbox` as today, but they can never gain more than the worker has. The current rules that switch to the archive tools' user (65533) or the media user (65534), or keep `dac_read_search`, apply only to the root process. Inside a worker the tools run as the worker's own user, with the worker's Landlock rules narrowed further as today. Thumbnail and transcode caches are kept per uid (a cache file made from a file one user could read must not be served to another).
- **Size store, change watcher, trash sweep**: these stay in the root process because they cover whole volumes. `/api/du` results are filtered for the person: a path they cannot reach (checked with `faccessat` in their worker) answers 403, and sizes are only shown for folders they can list.
- **Trash (my call)**: each volume's `.filedeck-trash` gets one folder per uid (`.filedeck-trash/u<uid>/`, mode 0700, owned by that uid, created by the root process on a worker's first use). A worker moves deleted items into its own folder, so the kernel still decides, and a virtual account's Landlock rules get write access to that folder only. A person sees and restores only their own folder. With "act as root" an admin sees all of them. The sweep (root process) covers every folder as now. A grant on a different filesystem from the volume's trash deletes without a trash, with a warning, as volumes without a trash do today.
- **Compare index (my call)**: the hub's compare index stays on the hub. It holds only what the hub was given through a person's own requests, so the index key gains the account and a row is reused only for the account that produced it. This costs disk when several people compare the same trees.
- **Machines with authentication off**: the agent behaves exactly as today (all routes in the root process). Authentication is a hub setting (`FILEDECK_AUTH=on`) passed to agents through the agent setting `FILEDECK_AUTH=on`. An agent with it on refuses any request without a valid user header.

### Admin screens (web)

- A sign-in page, and an account menu in the header (name, sign out).
- An "Accounts" panel for admins: list, create and edit virtual accounts (name, password reset, keys, admin flag, per machine `runAs` and grants with a folder picker), see who is signed in, end sessions. Grants on network sources are set in the same panel.
- System users are not listed (the hub cannot list them). An admin can add a system user name to grant it network sources.

### Audit

Every audit line gets `user` (`"sys:alice"` or `"virt:guest1"`), on the hub and on the agent. Sign-in attempts are logged with name, method, result and address, never the password, key or signature.

### Configuration summary

| Setting | Where | Meaning |
|---|---|---|
| `FILEDECK_AUTH` | hub, agent | `on` turns everything above on. Default `off` for now, so existing installs keep working until they opt in |
| `FILEDECK_ADMINS` | hub | System user names that are admins |
| `FILEDECK_BOOTSTRAP_ADMIN_FILE` | hub | First virtual admin (name and scrypt hash) |
| `FILEDECK_AUTH_NODES` | hub | Order of machines asked to check system sign-ins |
| `FILEDECK_SESSION_IDLE`, `FILEDECK_SESSION_MAX` | hub | Session timeouts |
| `FILEDECK_API_TOKEN_ACCOUNT` | hub | Account the `du` token acts as |
| `FILEDECK_MAX_WORKERS`, `FILEDECK_WORKER_IDLE` | agent | Worker limits |

The chart gets matching values. The agent already sees the machine's `/` at `FILEDECK_ROOT`, so no extra mounts are needed.

## Order of work

1. **Sign-in and sessions at the hub**: account store, virtual accounts, sessions, sign-in page, a gate on every route, the user header to agents, the audit field. At this stage the agent checks the header but still works as root, so system users are signed in but not yet confined. This step is only released with step 2.
2. **Workers on the agents**: the worker entry point, socket forwarding, starting through the launcher with user, groups and Landlock, PAM and key checks, helpers inside workers, per-uid caches, trash owners, `du` filtering, jobs carrying the account.
3. **Admin screens**: the accounts panel, source grants, sessions.
4. Docs (`docs/security.md`, `docs/configuration.md`, `docs/install.md`), chart values, and a release.

## Decided by the builder

- How request forwarding to workers is done (raw HTTP over the socket pair, or a small framed protocol), as long as bodies stream in both directions and an aborted client aborts the worker's work.
- Whether the worker is the existing agent app started in a "worker" mode or a separate entry point.
- The table layout of the account and session stores.
- Exact rate-limit numbers and the delay curve.
- Test layout. Root-only tests follow the existing pattern for sandbox tests.
