# Development

## Architecture

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

## Build and run

```sh
npm ci
npm run typecheck && npm test        # server tests (some need ffmpeg, bsdtar and 7zz, and skip without them)
                                     # with sshd or Apache (mod_dav) installed, the SFTP and WebDAV suites also run against them
npm run build                        # also compiles the native helpers into server/dist/native when a C compiler is present
FILEDECK_ROOT=$HOME npm run dev:agent      # agent on :8080
HUB_URL=http://127.0.0.1:8080 npm run dev:web   # Vite dev server, /api proxied
```

`npm run build` compiles the native helpers in `server/native` (the sandbox launcher, the fanotify helper and the no-replace rename helper) into `server/dist/native`, statically where the machine has a static C library and dynamically otherwise; without a C compiler it prints one line and the build still succeeds (`npm run build:native -w server` runs only this step). A start from the checkout then uses that launcher when `FILEDECK_SANDBOX_HELPER` is not set and `/usr/local/bin/filedeck-sandbox` does not exist, so `/api/info` reports the Landlock sandbox on a kernel that has it. The fanotify helper stays off unless `FILEDECK_FANWATCH` names it (for example `server/dist/native/filedeck-fanwatch`; it needs `CAP_SYS_ADMIN`). It feeds the folder-size store and the change event bus ([Change events](change-events.md)). As an ordinary user, the helper tests run in an unprivileged user namespace on a tmpfs (they need `unshare` and a C compiler, and use the test library `server/test/fanwatch-shim.c` in place of `open_by_handle_at`); as root they run on the real kernel. `scripts/bench-fanwatch.sh [FILES [DIRS]]` measures the helper.

To run both modes locally: start an agent (`FILEDECK_MODE=agent FILEDECK_ROOT=/some/dir PORT=8081`) and a hub (`FILEDECK_MODE=hub NODES=local=http://127.0.0.1:8081 FILEDECK_STATIC=web/dist PORT=8080`).

## Jobs and node status

Open `/status` for all accessible nodes or `/status/<node>` for one node. The query string stores the section, job, and filters.

- `GET /api/node-status` reads the agent's size store, watcher counters and change journal. It uses the normal agent authentication and requires a signed administrator claim when sign-in is active.
- `GET /api/status?node=<node>` reads the same snapshot through the hub. Omit `node` for all accessible agents. Each result identifies an available, unsupported or unavailable agent.
- Scan coverage uses complete, error-free rows that still exist in the size store. The timestamp records the stored root's latest scan or watcher refresh. A refresh of a descendant can preserve that time. A stale result means the store cannot verify that the whole tree is current.
- Live events use `GET /api/v1/changes?node=<node>` with the existing access rules. See [Change events](change-events.md) for cursor and filter behaviour.
- `web/src/StorageSection.tsx` contains the chart mount point. The component reads `GET /api/groups` and receives the selected node. Mount the chart inside its existing section and keep the empty state for hubs without the API.

[Back to the README](../README.md)
