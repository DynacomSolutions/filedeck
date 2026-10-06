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
helm install filedeck ./filedeck-0.2.1.tgz -n filedeck --create-namespace
kubectl -n filedeck port-forward svc/filedeck 8080:80   # then open http://127.0.0.1:8080
```

The defaults give one agent (`local`, any node) that browses the node's filesystem. Values you will most likely set (all documented in `k8s/values.yaml`):

| Value | Meaning |
|---|---|
| `image.repository`, `image.tag`, `image.digest` | The image; a `digest` wins over `tag` |
| `nodes[]` | One agent each: `name` (shown in the UI) and `nodeName` (Kubernetes node; empty = any) |
| `agent.stagger` | Under Argo CD, roll agents one at a time (agent N in sync wave N+1, in `nodes` order); default on, ignored by plain Helm |
| `agent.readOnlyPaths` | Virtual paths no agent may change (default `/proc`, `/sys`) |
| `agentToken.secretName` | Existing Secret holding a shared hub-to-agent token (empty = none) |
| `vault.*` | Saved-password vault: key Secret, volume size and class, entry lifetime. `vault.keyJob` creates the key before the hub starts; check vault health after installation |
| `hub.nodeSelector` | Pin the hub (its vault volume is ReadWriteOnce) |
| `sources[]` | Network sources (SFTP, WebDAV, S3, SMB) and the Secrets holding their credentials |
| `brand` | `name`, `title`, `icon`, `css` and `themeKey`; `cssContent` is chart-only (neutral "Filedeck" when empty) |
| `mapping.enabled`, `mapping.host` | Optional Emissary / Ambassador Mapping to the hub; with another ingress route to the `filedeck` Service yourself |
| `testSources.*` | Scratch SFTP, WebDAV, S3 and SMB servers for trying the sources (off; needs SealedSecret ciphertext in `testSources.sealed`) |

Agents run as root with the node's `/` mounted read-write, and there are no user accounts: keep the hub on a trusted network and leave the NetworkPolicy and `agentToken` in place. Each agent is selected by the label `app.kubernetes.io/instance: <release>-agent-<name>`.

## Configuration (environment)

Agent: `FILEDECK_ROOT`, `FILEDECK_NODE`, `PORT`, `FILEDECK_MAX_UPLOAD`, `FILEDECK_MAX_EDIT`, `FILEDECK_READONLY` (comma separated virtual prefixes), `FILEDECK_AGENT_TOKEN`, `FILEDECK_TRANSCODE_CONCURRENCY`, `FILEDECK_THUMB_DIR`, archive, search and hash limits (see `server/src/config.ts`).

Hub: `NODES` (`name=http://agent:8080,...`), `FILEDECK_STATIC`, `FILEDECK_AGENT_TOKEN`, `FILEDECK_SOURCES` (network sources, credentials from mounted files in `FILEDECK_SOURCE_SECRETS`), `FILEDECK_BRAND`.

`FILEDECK_BRAND` is JSON: `{"name","title","icon","css","themeKey"}`. Unset, the page says "Filedeck", has no logo and no header links (the header never carries logos or links to other sites; only the name, selection actions, Compare panels, theme and help).

## Archives and passwords

Compress offers zip, 7z, tar.gz, tar.zst and tar.xz with a compression level (store to ultra), exclude patterns (one glob per line), an archive name and a destination folder. Zip and 7z can also be password protected (zip uses AES-256; a 7z can additionally encrypt its file names) and split into volumes (`name.7z.001`, `.002`, ...; open the first part to browse or extract the set). Extract takes a destination, a subfolder switch, an overwrite policy (keep both, replace, skip) and, for password-protected archives, a password; the archive browser can extract just the ticked entries.

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
