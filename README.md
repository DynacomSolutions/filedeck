# Filedeck

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
npm run typecheck && npm test        # server tests (some need ffmpeg and bsdtar, and skip without them)
npm run build
FILEDECK_ROOT=$HOME npm run dev:agent      # agent on :8080
HUB_URL=http://127.0.0.1:8080 npm run dev:web   # Vite dev server, /api proxied
```

To run both modes locally: start an agent (`FILEDECK_MODE=agent FILEDECK_ROOT=/some/dir PORT=8081`) and a hub (`FILEDECK_MODE=hub NODES=local=http://127.0.0.1:8081 FILEDECK_STATIC=web/dist PORT=8080`).

## Configuration (environment)

Agent: `FILEDECK_ROOT`, `FILEDECK_NODE`, `PORT`, `FILEDECK_MAX_UPLOAD`, `FILEDECK_MAX_EDIT`, `FILEDECK_READONLY` (comma separated virtual prefixes), `FILEDECK_AGENT_TOKEN`, `FILEDECK_TRANSCODE_CONCURRENCY`, `FILEDECK_THUMB_DIR`, archive, search and hash limits (see `server/src/config.ts`).

Hub: `NODES` (`name=http://agent:8080,...`), `FILEDECK_STATIC`, `FILEDECK_AGENT_TOKEN`, `FILEDECK_SOURCES` (network sources, credentials from mounted files in `FILEDECK_SOURCE_SECRETS`), `FILEDECK_BRAND`.

`FILEDECK_BRAND` is JSON: `{"name","title","icon","css","themeKey"}`. Unset, the page says "Filedeck", has no logo and no header links (the header never carries logos or links to other sites; only the name, selection actions, Compare panels, theme and help).

## Contributing

- Keep the core free of company or deployment names: hostnames, registries, logos and link targets belong in `deploy/`, the chart values or `FILEDECK_BRAND`. `npm run check:neutral` fails on the identifiers it knows.
- Colours, fonts and spacing come from the theme tokens in `theme.css` (`var(--fg)`, `var(--border)` ...), never literals. Navigation state (panels, folders, sort, selection, open viewers) lives in the URL, see `web/src/urlState.ts`.
- Every path that touches the filesystem goes through `paths.ts` (`resolveRead`, `resolveWrite`) and, for the actual open or change, `openChecked` or `pinParent`/`pinDir`. A new mutating route must be listed in `server/src/readonly.ts` so read-only volumes cover it.
- Add a test beside each change (`server/test/*.test.ts`, `node --test` with `tsx`). Web changes are checked in a browser at desktop and phone width, dark and light, and with the keyboard.
- Small pull requests, one concern each.

## Licence

MIT, see `LICENSE`. The bundled Montserrat fonts are under the SIL Open Font License 1.1 (`web/public/assets/fonts/OFL.txt`).
