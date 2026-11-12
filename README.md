# Filedeck

<p align="center"><img src="web/public/logo-wordmark.svg" alt="Filedeck" height="48"></p>

The mark is a folder with a deck of two cards peeking out behind it, drawn as a single-colour line icon (`web/public/logo-mark.svg`, `logo-wordmark.svg`, `favicon.svg`).

A web file manager for a fleet of machines: dual (or more) panels, tabs, bookmarks, drag and drop between machines, bulk jobs with progress, folder compare and sync, search, archives, a Monaco editor and diff, previews (images, video with on-the-fly transcode, audio, PDF, Markdown, Word/Excel/PowerPoint/OpenDocument, hex), a trash per volume, permissions, symlinks and network sources (SFTP, WebDAV, S3, SMB).

One image, two modes:

- **agent** runs on each machine with the machine's filesystem mounted (`FILEDECK_ROOT`, `/host` in the chart). It serves a REST and SSE API under `/api`. Every client path is virtual and resolved chroot-style by `server/src/paths.ts`; file operations then run through descriptors so a symlink swapped in mid-request cannot leave the root.
- **hub** serves the single-page app and proxies `/api/nodes/<name>/...` to the agents. It also runs bulk jobs, folder diffs, cross-machine transfers and the network sources.

There are no user accounts: put it behind a trusted network boundary (a VPN, a private ingress). Agents can be locked to the hub with a network policy and an optional shared token (`FILEDECK_AGENT_TOKEN`), whole subtrees can be made read-only (`FILEDECK_READONLY`), and every state-changing request is written to stdout as a JSON audit line.

## Layout

| Path | What |
|---|---|
| `server/` | Agent and hub (TypeScript, Hono, Node 22) and its tests |
| `web/` | The app (React, Vite, Monaco) |
| `Dockerfile`, `package.json`, `tsconfig.base.json` | Image and workspace |
| `web/public/assets/theme.css`, `web/public/assets/fonts/` | Bundled theme tokens and fonts; Montserrat is SIL OFL 1.1 (`web/public/assets/fonts/OFL.txt`) |
| `k8s/` | Generic Helm chart with neutral defaults; `npm run check:neutral` checks chart defaults |

Deployment values (nodes, image, hosts, branding and sources) belong in a separate values file passed with `-f` or an Argo CD `valueFiles` source. The optional `brand.cssContent` value lets an installation mount its own stylesheet without changing the image.

The repository contains the application, generic Helm chart and public build workflows.

## Develop

```sh
npm ci
npm run typecheck && npm test        # server tests (some need ffmpeg, bsdtar and 7zz, and skip without them)
npm run build
FILEDECK_ROOT=$HOME npm run dev:agent      # agent on :8080
HUB_URL=http://127.0.0.1:8080 npm run dev:web   # Vite dev server, /api proxied
```

To run both modes locally: start an agent (`FILEDECK_MODE=agent FILEDECK_ROOT=/some/dir PORT=8081`) and a hub (`FILEDECK_MODE=hub NODES=local=http://127.0.0.1:8081 FILEDECK_STATIC=web/dist PORT=8080`).

## Install with Helm

Download the chart archive attached to the [latest GitHub release](https://github.com/DynacomSolutions/filedeck/releases), then install it without overrides to try the default configuration:

```sh
helm install filedeck ./filedeck-0.3.35.tgz -n filedeck --create-namespace
kubectl -n filedeck port-forward svc/filedeck 8080:80   # then open http://127.0.0.1:8080
```

Each published release also moves the `stable` git tag to the released commit, so Argo CD deployments can track `targetRevision: stable`.

The defaults give one agent (`local`, any node) that browses the node's filesystem. Values you will most likely set (all documented in `k8s/values.yaml`):

| Value | Meaning |
|---|---|
| `image.repository`, `image.tag`, `image.digest` | The image; a `digest` wins over `tag` |
| `nodes[]` | One agent each: `name` (shown in the UI) and `nodeName` (Kubernetes node; empty = any) |
| `agent.stagger` | Under Argo CD, roll agents one at a time (agent N in sync wave N+1, in `nodes` order); default on, ignored by plain Helm |
| `agent.readOnlyPaths` | Virtual paths no agent may change (default `/proc`, `/sys`) |
| `agentToken.secretName`, `agentToken.generate` | Shared hub-to-agent token: name an existing Secret, or set `generate: true` and a hook Job creates a random one (never rotated); empty and off = none |
| `hub.networkPolicy.enabled`, `hub.networkPolicy.from` | Optional NetworkPolicy for the hub: only the listed peers (for example your ingress controller) may connect; off by default |
| `apiToken.secretName` | Existing Secret holding the read-only token for `filedeck du` (empty = feature off) |
| `vault.*` | Saved-password vault: key Secret, volume size and class, entry lifetime. `vault.keyJob` creates the key before the hub starts; check vault health after installation |
| `hub.nodeSelector` | Pin the hub (its vault volume is ReadWriteOnce) |
| `hub.affinity`, `hub.tolerations` | Hub scheduling; the chart adds a required pod affinity so a rolling update keeps both hubs on one node |
| `hub.strategy` | Hub rollout, default `RollingUpdate` (surge 1, unavailable 0); `Recreate` stops the old hub first |
| `sources[]` | Network sources (SFTP, WebDAV, S3, SMB) and the Secrets holding their credentials |
| `brand` | `name`, `title`, `icon`, `css` and `themeKey`; `cssContent` is chart-only (neutral "Filedeck" when empty) |
| `mapping.enabled`, `mapping.host` | Optional Emissary / Ambassador Mapping to the hub; with another ingress route to the `filedeck` Service yourself |
| `testSources.*` | Scratch SFTP, WebDAV, S3 and SMB servers for trying the sources (off; needs SealedSecret ciphertext in `testSources.sealed`) |

Agents run as root with the node's `/` mounted read-write, and there are no user accounts: keep the hub on a trusted network and leave the agent NetworkPolicy in place. Anything that can reach the hub can use it, so on a shared cluster also set `agentToken.generate: true` and `hub.networkPolicy` (the chart default allows any pod to reach the hub, so that a plain install works behind any ingress). Each agent is selected by the label `app.kubernetes.io/instance: <release>-agent-<name>`.

## Configuration (environment)

Agent: `FILEDECK_ROOT`, `FILEDECK_NODE`, `PORT`, `FILEDECK_MAX_UPLOAD`, `FILEDECK_MAX_EDIT`, `FILEDECK_READONLY` (comma separated absolute virtual prefixes; `//`, `/./` and a trailing slash are cleaned, and an entry that is not an absolute path stops the start; a prefix that is a link protects the place it leads to as well; where the prefix lies on a case-insensitive filesystem, such as vfat, names are matched without regard to case, which is detected by probing the prefix, so a prefix that does not exist yet or has no letters in its last name is matched exactly). One limit: a hard link that already exists outside a read-only prefix to a file inside it lets a permissions or owner change reach that file (content changes go through rename and never touch the protected file; nothing in the API creates hard links), `FILEDECK_AGENT_TOKEN`, `FILEDECK_TRANSCODE_CONCURRENCY`, `FILEDECK_THUMB_DIR`, `FILEDECK_SEARCH_CONCURRENCY` (searches that run at once, default 3; one client, as the server sees its address, may hold at most that number minus one, never fewer than two, so with the default a second tab or a second user is not refused, and a client that reads slowly cannot take every slot), `FILEDECK_WORK_DIR` (see "Archives and passwords"), `FILEDECK_SANDBOX` (`auto`, `require`, `off`; see "Sandbox"), archive, search and hash limits (see `server/src/config.ts`).

Working folders: while a copy or a move across filesystems runs, the agent builds the result in a private folder named `.filedeck-work-<run id>-<id>` (mode 0700) inside the destination folder, and moves it into place with one rename. Names that start with `.filedeck-work-`, and the name `.filedeck-work`, are reserved: they are not listed, copied or accepted as a target. A copy that is interrupted by a crash can leave such a folder behind; when a copy next uses that folder, the agent removes a leftover that holds nothing but its one built entry and has not changed for a day (24 hours), whichever process made it. A leftover that holds anything else is never touched, and can be removed by an administrator on the host.

Hub: `FILEDECK_TRUSTED_PROXIES` (reverse proxies in front of the hub whose `X-Forwarded-For` is believed, counted from the hub's side; default 0 = none: the connection's own address is used for the audit log's `ip` and the per-client search limit, and the header is ignored; chart value `hub.trustedProxies`), `NODES` (`name=http://agent:8080,...`), `FILEDECK_STATIC`, `FILEDECK_AGENT_TOKEN`, `FILEDECK_ALLOWED_HOSTS` (comma separated host names the hub answers to; any other `Host` gets 421; unset accepts any. Write the bare name, such as `files.example`, to accept every port, or `files.example:8443` to accept that port only; a name with `:80` or `:443` also matches a `Host` header without a port. The same list names the sites whose `Origin` may change state when the browser sends no `Sec-Fetch-Site`, on the request's own scheme and port), `FILEDECK_API_TOKEN` or `FILEDECK_API_TOKEN_FILE` (read-only `filedeck du` token, see below), `FILEDECK_SOURCES` (network sources, credentials from mounted files in `FILEDECK_SOURCE_SECRETS`), `FILEDECK_BRAND`.

`FILEDECK_BRAND` is JSON: `{"name","title","icon","css","themeKey"}`. Unset, the page says "Filedeck", has no logo and no header links (the header never carries logos or links to other sites; only the name, selection actions, Compare panels, theme and help).

### Sandbox

Repositories and archives are other people's data, so the helper programs the agent runs on them go through a small launcher, `filedeck-sandbox` (built from `server/native`, installed beside `filedeck-fanwatch` in the image; `FILEDECK_SANDBOX_HELPER` names it). That is every Git command (status, details, diffs) and every start of `bsdtar` and `7zz` (compress, extract, list, password check, zip download). The launcher drops privileges, sets no-new-privileges and applies a Linux Landlock ruleset that handles every right the running kernel offers: the program can read files beneath the served folder and the system folders it needs to start, nothing else, and it can write nothing at all. A link inside a repository that leads outside the served folder therefore fails when Git opens it. On kernels with Landlock ABI 4 or newer TCP bind and connect are denied too, with ABI 6 or newer so are abstract unix sockets and signals to other processes; an older kernel simply lacks those rows. On every kernel the launcher also installs a seccomp filter that makes `socket()`, `socketpair()`, `connect()`, `bind()`, `listen()`, `accept()` and io_uring fail, so a confined program can reach neither UDP nor a pathname unix socket under the served folder (x32 system calls end the process); it uses only the descriptors it was given. This layer is best effort (x86-64 and arm64, kernels with seccomp filters); the agent logs the sandbox state at start-up (Landlock ABI, handled rights, whether the socket filter is on) and `/api/info` shows a summary under `sandbox` (the table is in `server/native/filedeck-sandbox.c`). Git's own error text is never sent to a client: failures are answered with fixed messages and the details stay in the agent's log.

`FILEDECK_SANDBOX` says what happens when Landlock is not usable (kernel older than 5.13, Landlock not enabled, or blocked by the container's seccomp profile):

- `require`: without Landlock the features that start helper programs answer a 503 error. **This is the default in the container image and in the chart** (`agent.sandbox`).
- `auto` (the default only for a plain development start, outside the image): Landlock when present. Without it Git still runs, but only for a repository whose git directory holds no symbolic link at any depth and no `include` or `includeIf` setting (at most 50,000 entries are checked; more is a refusal; the check is repeated before every Git command), and never as root. This is a weaker guarantee than Landlock: a link created between the check and Git's read is not stopped. The agent logs once at start-up that the sandbox is unavailable.
- `off`: no launcher and no extra checks, only the path checks in `server/src/git.ts`. For development.

What the archive tools may touch, with the sandbox in force (everything not listed, in particular everything else below the served folder, is closed to them by the kernel; the rules are attached to descriptors the agent holds, so renaming or replacing a name while a tool runs changes nothing, and a tool's working folder is passed to the launcher as a descriptor, never as a `/proc/self/fd` path):

| Tool start | Reads | Writes | Runs as (agent is root) |
|---|---|---|---|
| Compress, `bsdtar` | up to 4,000 selected items: each on its own, opened path-only; the folder holding the selection and its unselected siblings are closed. A selected link is stored as itself and needs no grant. **Above 4,000 items (the limit for one job or download is 10,000, for every route alike) the pinned source folder is granted instead**: bsdtar is still told the names explicitly and stores links as links, so only the selection is archived, but it *can* read unselected siblings; only the exclude patterns keep Filedeck's own folders out | a private scratch folder only: the archive being written (by name) and the temporary file the 7z writer keeps | the selected folder's owner (groups cleared) |
| Compress, 7-Zip | **the whole pinned source folder**, whatever the count: 7-Zip lists its working folder to find the names it is given, and with absolute paths or a list file it lists their parent instead (tried with the real tool: both fail without read access to that folder). It is told only the selected names, so it archives only those, but it *can* read every unselected sibling and everything else beneath that folder; only the exclude patterns keep Filedeck's own folders out | one private folder only (it writes by name): the archive being written and the exclude list | the selected folder's owner |
| Zip download, `bsdtar` | as for compress with `bsdtar`: each selected entry up to 4,000, the pinned folder above; started in the pinned folder by descriptor | nothing (the zip goes to a pipe) | the folder's owner |
| Extract, `bsdtar` | nothing below the served folder: the archive arrives on standard input | nothing (the tar stream goes to a pipe) | the archive tools' user |
| Extract, 7-Zip, one archive | the archive as an open read-only descriptor (read as `/dev/fd/3`; it needs no permission on the file), plus the kernel rule on that same file | the private staging folder only (owned by the tool user for the run) | the archive tools' user |
| Extract, 7-Zip, split set | its own private copies of the checked parts, in a reserved folder inside the staging folder, opened by a relative name from the staging folder (the working folder is a descriptor) | the private staging folder only (the copies are removed before the result is taken out) | the archive tools' user: the staging folder and the copies are owned by it (mode 0700) |
| List and password check, 7-Zip, one archive | the same open descriptor | nothing | the archive tools' user |
| List and password check, 7-Zip, split set | with Landlock: each part opened by name, one rule per part (up to 4,096); in `off` and fallback: the parts opened by name after the agent checked them (7-Zip finds the next part by changing the name, so a descriptor alone cannot work: "Cannot open the file as archive"; there is no kernel rule to hold the parts there, a weaker guarantee in modes where the tool is unconfined anyway) | nothing | the archive tools' user when it can read the first part and the folders above it by mode, else the agent |
| List, `bsdtar` | nothing below the served folder: the archive on standard input | nothing | the archive tools' user |

The archive tools' user is its own: a fixed uid and gid with no account needed (default 65533 for both; `FILEDECK_ARCHIVE_UID` and `FILEDECK_ARCHIVE_GID` change them; 0 is refused), different from the user the media tools use (65534), so a compromised media tool, which runs outside these sandbox domains, cannot signal or trace an archive tool on kernels without the newest Landlock scopes, nor reach its staging. A failure to list or password-check a split set is reported as an error and never skips the check.

Without Landlock (`off`, or `auto` where Landlock is unusable) there are no read or write rules at all; the tools differ only in how they reach the archive and who they run as: `bsdtar` reads the archive from standard input as before, and 7-Zip is handed a single archive as an inherited descriptor (kept open through the launcher with `--keep-fd`, read as `/dev/fd/3`), never by a name that could be swapped after it was checked. The user change and the working folder by descriptor go through the launcher in those modes too when it is installed, and every other descriptor above 2 is closed for the tool.

An archive is other people's data and the tools that parse it need no identity of their own, which is why they run as the archive tools' user. The agent opens the archive, and each part of a split set, without following links and without waiting on a pipe, and takes the produced archive out of the private folder through descriptors, with a size bound (see "Archives and passwords"). A launcher failure (too many folders, a step that failed, Landlock gone) is reported as an error ("the sandbox could not start the archive tool", the detail in the agent's log) and is never answered by trying another tool. Folders of Filedeck's own (the trash store, work and staging folders) found inside a selected entry are kept out of an archive by the tools' exclude patterns, not by the kernel: Landlock allows by hierarchy and cannot take a folder out of a granted tree. For `bsdtar` the patterns include the staging prefix, so such a folder that appears after the scan is left out too. For 7-Zip, whose wildcard matching stays off (so that names such as `a?b.txt` work), the exact names `.filedeck-trash` and `.filedeck-work` are excluded by name at any depth, and staging-prefix folders by the exact paths the scan found; a staging-prefix folder created inside a selected entry after the scan can be read by 7-Zip (it is private to the agent that made it, so a tool running as the selection's owner cannot read it either; only for a root-owned selection run as root is its content readable). With `FILEDECK_SANDBOX=require` and no usable Landlock the archive features answer the same 503 as Git; with `auto` and no Landlock they run with the path checks described in "Archives and passwords".

What stays outside the sandbox after this change:
- In `off` mode (and in `auto` when Landlock is not usable) every tool runs without kernel confinement: git, `bsdtar` and `7zz` have only the agent's own path checks and the privilege drop. The start-up log says so in a line, and `/api/info` shows `sandbox.archiveTools` as `confined`, `unconfined` or `disabled`. "No launcher" can only happen in a development start without the helper built or installed (`FILEDECK_SANDBOX_HELPER` missing, or `FILEDECK_SANDBOX=off`); the image always ships it. Then the working folder is given by its current path and the user change is Node's own: Node's process start (libuv) calls `setgroups(0)` whenever it is given a gid, so the supplementary groups are cleared there as well (a root-only test checks `id -G` in each mode).
- The `7zz --help` probe at start-up, which touches no archive.
- The `rm -rf` that removes a user's tool-output folder after a compression run as that user: it runs as that user, on that one folder, unconfined.
- What an older kernel's Landlock lacks (the table in `server/native/filedeck-sandbox.c`): below ABI 2 renames across folders are not controlled, below 3 truncation, below 4 the network, below 5 device ioctls, below 6 abstract unix sockets and signals, below 9 pathname unix sockets; the launcher's seccomp filter covers the sockets on the architectures that have it. Landlock never restricts a descriptor a process already holds, which is why the tools are handed only the descriptors they should use.
- A folder inside a granted selected entry (see above), and the shared unprivileged user: other helper programs that run as it can reach files it owns, which for the archive tools is only their own private staging folder while they run.

Who Git runs as when the agent runs as root: the owner of the git directory; for a root-owned git directory the unprivileged user the media tools use (uid and gid 65534) when that user can read it; a root-owned repository that user cannot read runs as root under Landlock (and is refused in the `auto` fallback). An agent that does not run as root changes nothing. When the served root is the whole machine, the system and process folders are inside it, and Landlock cannot take folders out of an allowed tree: a root-owned repository that the unprivileged user cannot read, served that way, can still read them through a hostile repository, but only someone who could already write a root-owned repository there can create one. For such a deployment serve a narrower root, or keep repositories readable by the unprivileged user so that they run unprivileged.

## `filedeck du`

A `du` for the folders on your nodes, answered from the hub's stored folder sizes instead of walking the disk each time.

```sh
filedeck du [-s] [-h] [-d N] [-a] [--apparent-size] [--fresh | --cached] [--json] [--timeout SECONDS] node:/path...
```

| Flag | Meaning |
|---|---|
| `-s`, `-d N` | Summary only, or entries up to N levels below the argument (like `du`) |
| `-h` | Sizes as `1.5K`, `23M` (powers of 1024, rounded up, like `du -h`) |
| `-a` | Also list files |
| `--apparent-size` | Bytes of content instead of disk usage |
| `--fresh` | Re-read every folder instead of reusing stored sizes |
| `--cached` | Answer from stored sizes only: never starts a scan, and says so when a folder is not stored (exit 1). Conflicts with `--fresh` |
| `--json` | Print the hub's answer as JSON (one object per argument) |
| `--timeout SECONDS` | Give up on an argument after this long in total (default: 600; `0` follows a live job with no cap; Ctrl-C or the timeout leaves the job running, rerun to rejoin) and exit 1 |

Without `-h` the unit is 1 KiB blocks, as in `du`. Children are printed before their parent. Paths are `node:/path`, where `node` is a node name from the sidebar. A long scan answers with a job; the CLI polls it and prints progress on stderr. When the answer comes from stored sizes it says so on stderr (with the age of the oldest folder), because changes since the last scan may be missing; `--fresh` avoids that. Exit status is 0 on success, 1 if any argument failed, 2 for a usage or configuration error, 130 when interrupted with Ctrl-C (the job keeps running on the server).

Environment: `FILEDECK_URL` (hub base URL, for example `https://filedeck.example.org`) and `FILEDECK_TOKEN` (the read-only token).

Token setup: create a Secret with a long random value (`kubectl create secret generic filedeck-api-token --from-literal=token="$(openssl rand -base64 48)"`) and set `apiToken.secretName: filedeck-api-token` in the chart values; the hub reads it as `FILEDECK_API_TOKEN` (or the file named by `FILEDECK_API_TOKEN_FILE`). The CLI sends the token in the header `X-Filedeck-Token: <token>`; `Authorization` is never read or changed, so an ingress or OIDC login in front of the hub keeps working. A request with a matching `X-Filedeck-Token` may call only `GET /api/nodes/<node>/api/du` and `GET /api/nodes/<node>/api/jobs/<id>` for du jobs; every other route answers 403. If the header is present with any other value (wrong, empty, repeated), or present while the feature is off, the answer is 401. The hub removes the header before it talks to an agent. Requests without the header are handled as before. Unset, the feature is off.

Ingress rule: skip login only when `X-Filedeck-Token` is present; the hub then enforces the token and the du-only scope itself, so a request carrying the header with anything else is refused.

Run it from the image (`filedeck du ...` is on the `PATH`), from a checkout after `npm run build` (`npx filedeck du ...` or `node server/dist/cli.js du ...`), or anywhere with Node 22 and the built `server/dist`.

### The stored sizes file

An agent keeps its stored folder sizes in a SQLite file. If only an index of that file is damaged the agent rebuilds it and logs one line. If the file is not SQLite or its tables are damaged, the agent never moves, changes or deletes it: it keeps answering without the cache (sizes are read from disk, `cached` is false), retries with a growing delay, and logs one line that names the file. The Prometheus text at `GET /metrics` on the agent port (no token, only these two 0/1 gauges) shows `filedeck_size_store_available` (0 while sizes are not cached) and `filedeck_size_store_damaged` (1 when the file cannot be repaired). To recover: stop the agent, rename the store file and its `-wal` and `-shm` files aside (keep them if you want to look at them), and start the agent again; it makes a new store and reads the folders once more.

## Archives and passwords

Compress offers zip, 7z, tar.gz, tar.zst and tar.xz with a compression level (store to ultra), exclude patterns (one glob per line), an archive name and a destination folder. Zip and 7z can also be password protected (zip uses AES-256; a 7z can additionally encrypt its file names) and split into volumes (`name.7z.001`, `.002`, ...; open the first part to browse or extract the set). Extract takes a destination, a subfolder switch, an overwrite policy (keep both, replace, skip) and, for password-protected archives, a password; the archive browser can extract just the ticked entries.

Extraction and compression stage their data in a private `.filedeck-work` folder at the root of the destination's volume (like `.filedeck-trash`, it is Filedeck's own: hidden from listings and scans, not readable through the file API, and its name cannot be created, uploaded, renamed to or extracted; compress and zip download leave both folders out of what they read). The result is then moved into the destination with a rename, so large jobs need no extra space and copy nothing. The folder is used only if it is a real directory owned by the agent with mode 0700 and every folder above it belongs to root or the agent and cannot be changed by others (a sticky folder such as `/tmp` is fine); this is what keeps users who can write to a served folder from redirecting 7-Zip or `bsdtar` while they work. When a volume cannot have such a folder (its root is writable by others, or it is read-only) the job stages in the temp work folder instead and the data is copied into place, so that folder needs room for the job: where the size is known the job fails at once, saying how much it needs, if the folder is too small. By default the temp work folder is a fresh `filedeck-work-XXXXXX` folder under the temp directory, made at each start; `FILEDECK_WORK_DIR` names a fixed one instead (it must pass the same private-folder test), which is what to set if your volume roots cannot hold the work folder and the temp volume is small. The archive being extracted is opened when the job starts and read from that open file; the parts of a split set are copied into the work folder first. Extracted files and folders belong to the destination folder's owner and group (when the agent runs as root). Compression of a folder owned by another user runs `bsdtar` and 7-Zip as that user. Each staging folder has a heartbeat file beside it that the running job refreshes; at start-up the agent removes staging that neither it nor its heartbeat has touched for a day (`FILEDECK_WORK_IDLE_SECONDS` changes that), only inside these folders: other agents' running jobs are never removed, whatever the process ids.

Password-protected PDFs ask for the password in the preview. The password is checked on the server and the PDF viewer is given a copy decrypted by `qpdf` (the password is never sent to the page, which is why pdf.js's in-browser password callback is not used); an owner-password-only PDF just opens. Password-protected Word, Excel and PowerPoint files, and encrypted OpenDocument files, are recognised and reported as protected: the in-browser preview cannot decrypt Office encryption, so download them instead.

Passwords are read by 7-Zip (`7zz`) from its standard input. They never appear on a command line, in a URL, in a job record, in an error message or in the audit log (the audit log only records an allow-list of path-like fields, and archive passwords travel in the `x-filedeck-password` request header, base64 encoded, which is never logged). Encrypted archives are extracted by 7-Zip into a private staging folder and then sanitised the same way as every other extraction (no links or special files, entry and size caps, permission bits dropped) before anything is moved into place. Names are validated from the archive listing first, so a hostile archive is refused before 7-Zip writes anything.

### Saved passwords (the vault) and its trust model

Filedeck has no user accounts: whoever can reach the page is the user. To spare retyping, the hub keeps the passwords you enter for encrypted archives (and, later, PDFs) in a vault:

- **What is stored.** The password, encrypted with AES-256-GCM (a fresh IV per row, the row id as authenticated data), in a small sqlite file on its own volume (`filedeck-vault`, never inside user data). The location (node and path), scope, timestamps and expiry are stored in clear so Settings can list them. The AES key is derived (HKDF-SHA256) from a Kubernetes Secret created out of band, `filedeck-vault-key` (key `key`, any random value of 16 or more bytes; see `vault` in `k8s/values.yaml` for the command). It is mounted as an environment variable (or `FILEDECK_VAULT_KEY_FILE`) and is never logged or printed. Without the Secret the vault is memory only and Settings says so.
- **Lifetime.** Default: a sliding window (`vault.ttlSeconds`, 30 minutes idle) that every use renews, capped at `vault.maxHours` (24 h) after the password was entered, then it must be typed again. With **Remember** ticked it is kept until forgotten. **Use for all files in this folder** saves it for the folder and everything below it (the nearest folder entry wins; a file's own entry wins over a folder's). Entries are found by node and path, falling back to inode and size so a renamed or moved file still matches.
- **Who can use it.** Anyone who can reach the hub (that is, anyone with network access to the hub) can open a file whose password is saved, exactly as they can open any unprotected file: the vault does not authenticate people, it only saves typing. Do not store a password you would not want every user of this Filedeck to be able to use. Someone with access to the cluster Secrets and the volume can decrypt the vault; the encryption protects the file at rest (backups, a copied volume), not against the operator.
- **What leaves the hub.** The hub sends a saved password to the agent that owns the file, in a request header over the private application network (agents are only reachable from the hub and, if configured, require the shared agent token), and only for the request that needs it. Agents hand it to 7-Zip on stdin. Passwords are never returned to the browser, never put in URLs, job records, error messages or the audit log.
- **Managing it.** Right-click a file or folder, **Forget saved password** (removes its own entry, entries beneath a folder, and any folder entry above that would still unlock it). Settings, **Saved passwords** lists every entry (location, scope, remembered or expiring, last used, expires at) with **Forget** per row and **Forget all**; the values are never shown.

## Contributing

- Keep the core free of deployment-specific hostnames, logos, colours and link targets; use chart values or `FILEDECK_BRAND`. `npm run check:neutral` checks generic chart defaults. Publication history is reviewed separately when preparing a release.
- Colours, fonts and spacing come from the theme tokens in `theme.css` (`var(--fg)`, `var(--border)` ...), never literals. Navigation state (panels, folders, sort, selection, open viewers) lives in the URL, see `web/src/urlState.ts`.
- Every path that touches the filesystem goes through `paths.ts` (`resolveRead`, `resolveWrite`) and, for the actual open or change, `openChecked` or `pinParent`/`pinDir`. A new mutating route must be listed in `server/src/readonly.ts` so read-only volumes cover it.
- Add a test beside each change (`server/test/*.test.ts`, `node --test` with `tsx`). Web changes are checked in a browser at desktop and phone width, dark and light, and with the keyboard.
- **Every action is a real button**: icon plus label, the standard button style (flat, 6px radius), a `Tip` when icon-only. Never a text link, underlined text, or an `<a>` for an action. A download may be an `<a className="btn-a" role="button" download>` (it is styled as a button); a genuine navigation anchor must carry `data-nav` and should be rare. `server/test/buttonrule.test.ts` fails the build on a link-styled action.
- Small pull requests, one concern each.

## Licence

MIT, see `LICENSE`. The bundled Montserrat fonts are under the SIL Open Font License 1.1 (`web/public/assets/fonts/OFL.txt`).

> **Warning:** the vault volume holds a SQLite file shared briefly by two hub pods during a rollout. It must be block or local storage (ReadWriteOnce); never back it with NFS or SMB.
