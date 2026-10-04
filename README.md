# Filedeck

<p align="center"><img src="web/public/logo-wordmark.svg" alt="Filedeck" height="48"></p>

The mark is a folder with a deck of two cards peeking out behind it, drawn as a single-colour line icon (`web/public/logo-mark.svg`, `logo-wordmark.svg`, `favicon.svg`).

A web file manager for a fleet of machines: dual (or more) panels, tabs, bookmarks, drag and drop between machines, bulk jobs with progress, folder compare and sync, search, archives, a Monaco editor and diff, previews (images, video with on-the-fly transcode, audio, PDF, Markdown, Word/Excel/PowerPoint/OpenDocument, hex), a trash per volume, permissions, symlinks and network sources (SFTP, WebDAV, S3, SMB).

One image, two modes:

- **agent** runs on each machine with the machine's filesystem mounted (`FILEDECK_ROOT`, `/host` in the chart). It serves a REST and SSE API under `/api`. Every client path is virtual and resolved chroot-style by `server/src/paths.ts`; file operations then run through descriptors so a symlink swapped in mid-request cannot leave the root.
- **hub** serves the single-page app and proxies `/api/nodes/<name>/...` to the agents. It also runs bulk jobs, folder diffs, cross-machine transfers and the network sources.

There are no user accounts: put it behind a trusted network boundary (a VPN, a private ingress). Agents can be locked to the hub with a network policy and an optional shared token (`FILEDECK_AGENT_TOKEN`), whole subtrees can be made read-only (`FILEDECK_READONLY`), and every state-changing request is written to stdout as a JSON audit line.

## Layout

| Path | What | Core or deployment |
|---|---|---|
| `server/` | Agent and hub (TypeScript, Hono, Node 22) and its tests | core |
| `web/` | The app (React, Vite, Monaco) | core |
| `Dockerfile`, `package.json`, `tsconfig.base.json` | Image and workspace | core |
| `web/public/assets/theme.css`, `fonts/` | Bundled theme tokens and fonts | core: neutral theme; Montserrat is SIL OFL 1.1 (`fonts/OFL.txt`) |
| `deploy/brand/` | Logos and palette (`theme.css`, referenced by `brand.css`) for one deployment, copied into the image at `/assets/brand` when the folder exists | deployment |
| `k8s/` | Helm chart (hub, one agent per node, network policy, ingress mapping) | deployment |
| `../.github/workflows/filedeck-image.yml` | Test, build, scan, publish, open a pin PR | deployment |

A bare clone of `server/`, `web/` and the top-level files builds and tests without `deploy/`, `k8s/` or the workflow.

## Develop

```sh
npm ci
npm run typecheck && npm test        # server tests (some need ffmpeg, bsdtar and 7zz, and skip without them)
npm run build
FILEDECK_ROOT=$HOME npm run dev:agent      # agent on :8080
HUB_URL=http://127.0.0.1:8080 npm run dev:web   # Vite dev server, /api proxied
```

To run both modes locally: start an agent (`FILEDECK_MODE=agent FILEDECK_ROOT=/some/dir PORT=8081`) and a hub (`FILEDECK_MODE=hub NODES=local=http://127.0.0.1:8081 FILEDECK_STATIC=web/dist PORT=8080`).

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
- **Who can use it.** Anyone who can reach the hub (that is, anyone on the private-network) can open a file whose password is saved, exactly as they can open any unprotected file: the vault does not authenticate people, it only saves typing. Do not store a password you would not want every user of this Filedeck to be able to use. Someone with access to the cluster Secrets and the volume can decrypt the vault; the encryption protects the file at rest (backups, a copied volume), not against the operator.
- **What leaves the hub.** The hub sends a saved password to the agent that owns the file, in a request header on the cluster network (agents are only reachable from the hub and, if configured, require the shared agent token), and only for the request that needs it. Agents hand it to 7-Zip on stdin. Passwords are never returned to the browser, never put in URLs, job records, error messages or the audit log.
- **Managing it.** Right-click a file or folder, **Forget saved password** (removes its own entry, entries beneath a folder, and any folder entry above that would still unlock it). Settings, **Saved passwords** lists every entry (location, scope, remembered or expiring, last used, expires at) with **Forget** per row and **Forget all**; the values are never shown.

## Contributing

- Keep the core free of company or deployment names: hostnames, registries, logos and link targets belong in `deploy/`, the chart values or `FILEDECK_BRAND`. `npm run check:neutral` fails on the identifiers it knows.
- Colours, fonts and spacing come from the theme tokens in `theme.css` (`var(--fg)`, `var(--border)` ...), never literals. Navigation state (panels, folders, sort, selection, open viewers) lives in the URL, see `web/src/urlState.ts`.
- Every path that touches the filesystem goes through `paths.ts` (`resolveRead`, `resolveWrite`) and, for the actual open or change, `openChecked` or `pinParent`/`pinDir`. A new mutating route must be listed in `server/src/readonly.ts` so read-only volumes cover it.
- Add a test beside each change (`server/test/*.test.ts`, `node --test` with `tsx`). Web changes are checked in a browser at desktop and phone width, dark and light, and with the keyboard.
- **Every action is a real button**: icon plus label, the standard button style (flat, 6px radius), a `Tip` when icon-only. Never a text link, underlined text, or an `<a>` for an action. A download may be an `<a className="btn-a" role="button" download>` (it is styled as a button); a genuine navigation anchor must carry `data-nav` and should be rare. `server/test/buttonrule.test.ts` fails the build on a link-styled action.
- Small pull requests, one concern each.

## Licence

MIT, see `LICENSE`. The bundled Montserrat fonts are under the SIL Open Font License 1.1 (`web/public/assets/fonts/OFL.txt`).
