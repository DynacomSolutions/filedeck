# Tasks

## 1. File panel keyboard navigation
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| FD-1 | Type-ahead search in the file panel: letters typed in quick succession jump to the first name with that prefix; the buffer resets after a short pause | done | claude-20261010-typeahead | typeahead-nav | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/41. CI green on 268c691; `web` tests 79/79 passing, typecheck clean. Not checked in a browser. |
| FD-2 | Release v0.3.4 so the type-ahead fix (FD-1) deploys | superseded | claude-20261010-typeahead | release-v034 | | | Superseded by 1.FD-4: tag v0.3.4 pushed but Release run 37994192165 failed on Docker Hub, so no image was published. |
| FD-3 | Release workflow pulls from Docker Hub via mirror.gcr.io so hosted-runner rate limits and timeouts stop failing releases | done | claude-20261010-typeahead | release-v035 | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/43; v0.3.5 Release run 37995971381 succeeded through the mirror. |
| FD-4 | Release v0.3.5 so the type-ahead fix (FD-1) deploys | done | claude-20261010-typeahead | release-v035 | | | Release run 37995971381 succeeded; the hub and all agents run ghcr.io/dynacomsolutions/filedeck:0.3.5, GitOps sync healthy. |
| FD-5 | Git column wide enough to show the branch name in folder git pills (was cut to one letter) | done | claude-20261010-typeahead | git-pill-width | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/45; GIT_COL_W 72 to 144. Not checked in a browser. |
| FD-6 | Release v0.3.6 so FD-5 deploys | done | claude-20261010-typeahead | git-pill-width | | | Release succeeded; the hub and all agents run ghcr.io/dynacomsolutions/filedeck:0.3.6, GitOps sync healthy. |
| FD-7 | Release v0.3.7 so the S3 test source image fix (#47) deploys | done | claude-20261015-filedeck-test-s3 | release-v037 | | | filedeck-test-s3 ImagePullBackOff because quay.io/minio/minio is disabled upstream; fixed in PR https://github.com/DynacomSolutions/filedeck/pull/47 (pgsty/minio), release prep in PR https://github.com/DynacomSolutions/filedeck/pull/48. Release run 38727321325 succeeded; the hub and all agents run ghcr.io/dynacomsolutions/filedeck:0.3.7, filedeck-test-s3 runs pgsty/minio, GitOps sync healthy. |

## 2. Sidebar tree polish
ETA: 2026-10-18 13:00 ICT
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| FD-8 | Sidebar tree: long labels truncate with an ellipsis and a hover popover (label, size, percentage, bar); size bar sits under the label aligned with the folder icon; top-level server rows get a size bar | done | claude-20261018-tree-label-ellipsis | tree-label-ellipsis | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/51 (1f550b7). CI green; web tests 81/81, typecheck clean. Checked in headless Chromium against mocked API responses, not a real hub. Folder rows have no size data yet (see 3.FD-13); network sources report no mounts, so they get no bar. |
| FD-14 | Release v0.3.8 so the sidebar tree polish (2.FD-8) deploys | done | claude-20261018-release-v038 | release-v038 | 2.FD-8 | | Release run 39094608784 succeeded; the hub and all agents run ghcr.io/dynacomsolutions/filedeck:0.3.8, GitOps sync healthy. The rollout stalled for a while because the old hub pod could not be removed by its node and strategy Recreate blocked the new pod (fixed by 2.FD-15). |
| FD-15 | Zero-downtime rollouts: hub and agents keep one ready pod until the new one is ready (RollingUpdate maxUnavailable 0 where safe), and SIGTERM shutdown always exits within the grace period | done | claude-20261018-zero-downtime | zero-downtime-rollout | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/57 (22b05d4): RollingUpdate maxSurge 1 maxUnavailable 0 for hub and agents, hub podAffinity keeps the surge pod on the vault's node, preStop sleep 5, shutdown drains in-flight requests then cleans up (5s drain, 15s hard exit), vault busy_timeout, index never deleted on SQLITE_BUSY. Deploys with 2.FD-16. |
| FD-16 | Release v0.3.9 so zero-downtime rollouts (2.FD-15) deploy | in_review | claude-20261018-release-v039 | release-v039 | 2.FD-15 | 2026-10-18 13:00 ICT | PR https://github.com/DynacomSolutions/filedeck/pull/58 |

## 3. Cached folder sizes
ETA: 2026-10-19 18:00 ICT
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| FD-9 | Size store: per-folder size totals in SQLite on each agent, filled by the size scan and reused while a folder's inode and mtime are unchanged; one-folder delta updates propagated to parents; agent and hub `GET /api/du` | todo | | | | 2026-10-18 20:00 ICT | |
| FD-10 | fanotify helper: tiny native watcher marks each local filesystem when the agent pod has CAP_SYS_ADMIN and CAP_DAC_READ_SEARCH, feeds changed folders to the size store (flush on close-after-write, at most every 30 s for files still being written); without the capabilities the store relies on cached scans only | todo | | | 3.FD-9 | 2026-10-19 14:00 ICT | |
| FD-11 | `filedeck du` CLI: du-compatible flags (-s, -h, -d N, -a, --apparent-size, --fresh), `node:/path` addressing, queries the hub with one read-only cluster API token | todo | | | 3.FD-9 | 2026-10-18 22:00 ICT | |
| FD-12 | Agent skill in this repo for every coding agent (Claude Code, Codex, Pi and others), not only Claude: one canonical SKILL.md in the open Agent Skills format at a tool-neutral path, referenced from AGENTS.md, and exposed to each tool's skill discovery path (for example .claude/skills, .agents/skills) without duplicating content; tells agents to use `filedeck du` instead of `du` | todo | | | 3.FD-11 | 2026-10-19 16:00 ICT | |
| FD-13 | Sidebar tree folder rows show size, percentage and bar from the size store | todo | | | 3.FD-9 | 2026-10-19 18:00 ICT | |
