# Tasks

## 1. File panel keyboard navigation
ETA: 2026-10-15 12:00 ICT
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
ETA: 2026-10-18 14:00 ICT
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| FD-8 | Sidebar tree: long labels truncate with an ellipsis and a hover popover (label, size, percentage, bar); size bar sits under the label aligned with the folder icon; top-level server rows get a size bar | done | claude-20261018-tree-label-ellipsis | tree-label-ellipsis | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/51 (1f550b7). CI green; web tests 81/81, typecheck clean. Checked in headless Chromium against mocked API responses, not a real hub. Folder rows have no size data yet (see 3.FD-13); network sources report no mounts, so they get no bar. |
| FD-14 | Release v0.3.8 so the sidebar tree polish (2.FD-8) deploys | done | claude-20261018-release-v038 | release-v038 | 2.FD-8 | | Release run 39094608784 succeeded; the hub and all agents run ghcr.io/dynacomsolutions/filedeck:0.3.8, GitOps sync healthy. The rollout stalled for a while because the old hub pod could not be removed by its node and strategy Recreate blocked the new pod (fixed by 2.FD-15). |
| FD-15 | Zero-downtime rollouts: hub and agents keep one ready pod until the new one is ready (RollingUpdate maxUnavailable 0 where safe), and SIGTERM shutdown always exits within the grace period | done | claude-20261018-zero-downtime | zero-downtime-rollout | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/57 (22b05d4): RollingUpdate maxSurge 1 maxUnavailable 0 for hub and agents, hub podAffinity keeps the surge pod on the vault's node, preStop sleep 5, shutdown drains in-flight requests then cleans up (5s drain, 15s hard exit), vault busy_timeout, index never deleted on SQLITE_BUSY. Deploys with 2.FD-16. |
| FD-16 | Release v0.3.9 so zero-downtime rollouts (2.FD-15) deploy | done | claude-20261018-release-v039 | release-v039 | 2.FD-15 | | v0.3.9 released (PR https://github.com/DynacomSolutions/filedeck/pull/58, a487094); the hub and all agents run filedeck:0.3.9, GitOps sync healthy. |
| FD-17 | Test sources surge on rollout (RollingUpdate maxUnavailable 0) like hub and agents | done | claude-20261018-test-sources-rolling | test-sources-rolling | 2.FD-15 | 2026-10-18 14:00 ICT | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/59 (46cf5ec). |
| FD-18 | Agents in a container list the host's mounts, not the container's (large disks such as a separate /home were missing from sizes) | done | claude-20261018-host-mounts | host-mounts | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/60 (23f1944). Deploys with 2.FD-19. |
| FD-19 | Release v0.3.10 (size store 3.FD-9, test-source surge 2.FD-17, host mounts 2.FD-18) and confirm no service drops to zero ready pods during the rollout | done | claude-20261018-release-v0310 | release-v0310 | 2.FD-18 | | Released and rolled out with no downtime; see 2.FD-15. |
| FD-42 | The sidebar tree opens the path to the current folder and closes what it opened when you move away; folders you opened yourself stay open | done |  |  |  | 2026-10-21 01:30 ICT | |

## 3. Cached folder sizes
ETA: 2026-10-18 18:00 ICT
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| FD-9 | Size store: per-folder size totals in SQLite on each agent, filled by the size scan and reused while a folder's inode and mtime are unchanged; one-folder delta updates propagated to parents; agent and hub `GET /api/du` | done | claude-20261018-size-store | size-store | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/55 (f31230e). |
| FD-10 | fanotify helper: tiny native watcher marks each local filesystem when the agent pod has CAP_SYS_ADMIN and CAP_DAC_READ_SEARCH, feeds changed folders to the size store (flush on close-after-write, at most every 30 s for files still being written); without the capabilities the store relies on cached scans only | done | claude-20261018-fd10 | fanotify-watcher | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/66 (fe87e8b). Off by default (agent.fanotify.enabled). |
| FD-11 | `filedeck du` CLI: du-compatible flags (-s, -h, -d N, -a, --apparent-size, --fresh), `node:/path` addressing, queries the hub with one read-only cluster API token | done | claude-20261018-fd11 | du-cli | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/65 (a535663). Token travels in X-Filedeck-Token; off by default. |
| FD-12 | Agent skill in this repo for every coding agent (Claude Code, Codex, Pi and others), not only Claude: one canonical SKILL.md in the open Agent Skills format at a tool-neutral path, referenced from AGENTS.md, and exposed to each tool's skill discovery path (for example .claude/skills, .agents/skills) without duplicating content; tells agents to use `filedeck du` instead of `du` | done | claude-20261018-fd12 | agent-skill | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/63 (dfb84fa). |
| FD-13 | Sidebar tree folder rows show size, percentage and bar from the size store | done | claude-20261018-fd13 | tree-folder-sizes | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/64 (3c1970f). Adds GET /api/du?cachedOnly=1. |
| FD-20 | Release v0.3.11 (size cache epic: du CLI and token, skill, tree folder sizes, fanotify watcher) | done | claude-20261018-release-v0311 | release-v0311 | 3.FD-10, 3.FD-11, 3.FD-12, 3.FD-13 | | Released and rolled out with no downtime; du API token verified end to end. |
| FD-21 | /api/du reports watched true when the fanotify watcher covers the path and is not stale, so the CLI stops warning about missed changes | done | claude-20261018-du-watched | du-watched-flag | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/70 (28f52d0). Deploys with 3.FD-22. |
| FD-22 | Release v0.3.12 so the du watched flag (3.FD-21) deploys | done | claude-20261018-release-v0312 | release-v0312 | 3.FD-21 | | Released v0.3.12 and rolled out with no downtime; cached du answers now report watched true where the change watcher covers the path. |
| FD-41 | The details panel shows a folder's stored size (and when it was measured) without starting a scan | done |  |  |  | 2026-10-21 01:30 ICT | |

## 4. du scan robustness
ETA: 2026-10-21 01:00 ICT
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| FD-23 | `filedeck du` scans are never cut short by FILEDECK_WALK_MAX_ENTRIES: the size walk stores and forgets each folder as soon as its children are done, so memory follows tree depth, not tree size; the cap stays for listing, search and archive paths | done |  |  | | 2026-10-21 00:30 ICT | `filedeck du -h -d 2` on a large data tree reported "scan hit the entry limit, sizes are partial" (89G shown). |
| FD-24 | Agent /healthz answers during big scans: scan rows are written on a worker thread (the main thread only reads), so a contended disk no longer stalls the event loop and kubelet stops killing an agent | done |  |  | | 2026-10-21 00:30 ICT | an agent restarted 8+ times on 20 Oct 2026 (liveness timeouts, then `HTTP 502: agent unreachable`). |
| FD-25 | Release v0.3.13 so FD-23 and FD-24 deploy | done |  |  | 4.FD-23, 4.FD-24 | 2026-10-21 00:30 ICT | |
| FD-26 | Size locks are granted in arrival order, so a du scan of a tree with constant writes is no longer starved by watcher updates and never stays queued | done | claude-20261020-du-lock-fifo | du-lock-fifo | | 2026-10-20 16:00 ICT | du stayed "queued, 0 entries" for 300 s and longer on a busy tree. |
| FD-27 | Release v0.3.14 so FD-26 deploys | done | claude-20261020-du-lock-fifo | du-lock-fifo | 4.FD-26 | 2026-10-20 16:30 ICT | |
| FD-28 | The change watcher bounds its pending folders: past 50 000 it treats the burst like a kernel overflow (marks the watched trees stale) instead of growing until the agent runs out of heap | done | claude-20261020-fanwatch-bound | fanwatch-bound | | 2026-10-20 17:00 ICT | An agent ran out of heap (320 MB) while a bulk copy wrote a large tree into a watched filesystem. |
| FD-29 | Release v0.3.15 so FD-28 deploys | done | claude-20261020-fanwatch-bound | fanwatch-bound | 4.FD-28 | 2026-10-20 17:30 ICT | |
| FD-35 | `filedeck du` keeps waiting through transient hub errors (502, 503, 504, network) and re-joins a lost job, instead of exiting while the scan runs on | done | claude-20261020-du-cli-retry | du-cli-retry | | 2026-10-20 18:00 ICT | A transient 503 during a long poll ended the CLI and the next scan started in parallel. |

## 5. Agent memory scales with data
ETA: 2026-10-21 01:00 ICT
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| FD-30 | Change watcher keeps its pending folders in the size store's SQLite file (one row per folder with its due time, drained in batches by one timer) instead of one in-memory timer per folder, so a bulk copy of any size costs disk rows, not heap, and no longer falls back to marking whole trees stale | done | claude-20261020-scale-fanwatch | scale-fanwatch | 4.FD-28 | 2026-10-20 17:45 ICT | Replaces the 50 000 cap from 4.FD-28. |
| FD-31 | Size walk memory is constant per tree depth: folders are read as a stream (`fs.opendir`), the walk holds one frame per depth level instead of every pending sibling, removed child folders are found in SQL instead of an in-memory child list, and stored children are validated in batches | done | claude-20261020-scale-walk | scale-walk | | 2026-10-20 18:30 ICT | One folder with millions of entries must not grow the heap. |
| FD-32 | Listing, search, archive, trash and properties walkers read folders as a stream and stop at their existing caps, so one huge folder cannot load all its names at once | done | claude-20261020-scale-readdir | scale-readdir | | 2026-10-20 17:30 ICT | |
| FD-33 | Stores that run without an index directory use a temporary SQLite file, never `:memory:`, so their rows stay off the heap | done | | | | 2026-10-20 19:00 ICT | |
| FD-36 | The size store never drops to its in-memory fallback on a busy database: a locked read is a cache miss, a real failure reopens the store with backoff, and the fallback holds at most 20 000 rows | done | claude-20261020-scale-walk | scale-walk | | 2026-10-20 19:00 ICT | Root cause of the agent heap OOMs on 20 Oct: "database is locked", then up to 500 000 fallback rows per walk on the heap. |
| FD-34 | Release v0.3.16 so epic 5 deploys | done |  |  | 5.FD-30, 5.FD-31, 5.FD-32, 5.FD-33 | 2026-10-20 19:30 ICT | |
| FD-37 | An agent starts serving /healthz within seconds whatever the size of its stores: nothing proportional to store size runs before listen, and a startup probe covers a long WAL replay | done |  |  | | 2026-10-21 01:00 ICT | v0.3.16 never came up with a 2 GB store. v0.3.17 added the startup probe and dropped the full-table read on open; still open: the change watcher handles its backlog before the server listens. |
| FD-38 | Release v0.3.17 so FD-37 deploys | done |  |  | 5.FD-37 | 2026-10-21 01:00 ICT | |
| FD-39 | The size walk keeps the disk busy (bounded parallel stats, no wait on each commit), so a tree of small folders on a busy disk scans at least 5x faster than v0.3.16 | done |  |  |  | 2026-10-21 00:30 ICT | v0.3.16 walked about 100 entries/s at 6% CPU on a busy disk. |
| FD-40 | Release v0.3.18 so FD-39 deploys | done |  |  | 5.FD-39 | 2026-10-21 00:45 ICT | |
| FD-43 | Release v0.3.19 so FD-41 and FD-42 deploy | done |  |  | 3.FD-41, 2.FD-42 | 2026-10-21 00:45 ICT | |
| FD-45 | Release v0.3.20 so FD-37 deploys | done |  |  | 5.FD-37 | 2026-10-21 01:15 ICT | |

## 6. Housekeeping
ETA: 2026-10-21 00:19 ICT
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| FD-44 | CLUSTER-287 hq0 disk cleanup: remove rebuildable and temporary material from this repo's .data folder and finished task worktrees | done | claude-20261021-cleanup | cleanup-20261021 | | 2026-10-21 00:19 ICT | Freed about 0.9 GiB: generated lag test tree, node_modules, dist copies, release tarballs; finished merged task worktree board-format-20261020. Kept scripts, notes and evidence. |

## 7. Sidebar tree
ETA: 2026-10-21 04:30 ICT
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| FD-46 | Folding of long open folder paths in the sidebar tree is a user setting (off, or keep the last 2 to 5 rows) | done | | tree-settings | | 2026-10-21 04:30 ICT | |
| FD-47 | The sidebar scrolls sideways when the tree is wider than it | done | | tree-settings | | 2026-10-21 04:30 ICT | |
| FD-48 | Release v0.3.21 so FD-46 and FD-47 deploy | todo | | | 7.FD-46, 7.FD-47 | 2026-10-21 04:30 ICT | |
