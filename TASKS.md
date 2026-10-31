# Tasks

## 1. File panel keyboard navigation
ETA: 2026-10-15 12:00 ICT
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| 1 | Type-ahead search in the file panel: letters typed in quick succession jump to the first name with that prefix; the buffer resets after a short pause | done | claude-20261010-typeahead | typeahead-nav | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/41. CI green on 268c691; `web` tests 79/79 passing, typecheck clean. Not checked in a browser. Was FD-1. |
| 2 | Release v0.3.4 so the type-ahead fix (1.1) deploys | superseded | claude-20261010-typeahead | release-v034 | | | Superseded by 1.4: tag v0.3.4 pushed but Release run 37994192165 failed on Docker Hub, so no image was published. Was FD-2. |
| 3 | Release workflow pulls from Docker Hub via mirror.gcr.io so hosted-runner rate limits and timeouts stop failing releases | done | claude-20261010-typeahead | release-v035 | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/43; v0.3.5 Release run 37995971381 succeeded through the mirror. Was FD-3. |
| 4 | Release v0.3.5 so the type-ahead fix (1.1) deploys | done | claude-20261010-typeahead | release-v035 | | | Release run 37995971381 succeeded; the hub and all agents run ghcr.io/dynacomsolutions/filedeck:0.3.5, rollout healthy. Was FD-4. |
| 5 | Git column wide enough to show the branch name in folder git pills (was cut to one letter) | done | claude-20261010-typeahead | git-pill-width | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/45; GIT_COL_W 72 to 144. Not checked in a browser. Was FD-5. |
| 6 | Release v0.3.6 so 1.5 deploys | done | claude-20261010-typeahead | git-pill-width | | | Release succeeded; the hub and all agents run ghcr.io/dynacomsolutions/filedeck:0.3.6, rollout healthy. Was FD-6. |
| 7 | Release v0.3.7 so the S3 test source image fix (#47) deploys | done | claude-20261015-filedeck-test-s3 | release-v037 | | | filedeck-test-s3 ImagePullBackOff because quay.io/minio/minio is disabled upstream; fixed in PR https://github.com/DynacomSolutions/filedeck/pull/47 (pgsty/minio), release prep in PR https://github.com/DynacomSolutions/filedeck/pull/48. Release run 38727321325 succeeded; the hub and all agents run ghcr.io/dynacomsolutions/filedeck:0.3.7, filedeck-test-s3 runs pgsty/minio, rollout healthy. Was FD-7. |

## 2. Sidebar tree polish
ETA: 2026-10-18 14:00 ICT
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| 8 | Sidebar tree: long labels truncate with an ellipsis and a hover popover (label, size, percentage, bar); size bar sits under the label aligned with the folder icon; top-level server rows get a size bar | done | claude-20261018-tree-label-ellipsis | tree-label-ellipsis | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/51 (1f550b7). CI green; web tests 81/81, typecheck clean. Checked in headless Chromium against mocked API responses, not a real hub. Folder rows have no size data yet (see 3.20); network sources report no mounts, so they get no bar. Was FD-8. |
| 9 | Release v0.3.8 so the sidebar tree polish (2.8) deploys | done | claude-20261018-release-v038 | release-v038 | 2.8 | | Release run 39094608784 succeeded; the hub and all agents run ghcr.io/dynacomsolutions/filedeck:0.3.8, rollout healthy. The rollout stalled for a while because the old hub pod could not be removed by its node and strategy Recreate blocked the new pod (fixed by 2.10). Was FD-14. |
| 10 | Zero-downtime rollouts: hub and agents keep one ready pod until the new one is ready (RollingUpdate maxUnavailable 0 where safe), and SIGTERM shutdown always exits within the grace period | done | claude-20261018-zero-downtime | zero-downtime-rollout | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/57 (22b05d4): RollingUpdate maxSurge 1 maxUnavailable 0 for hub and agents, hub podAffinity keeps the surge pod on the vault's node, preStop sleep 5, shutdown drains in-flight requests then cleans up (5s drain, 15s hard exit), vault busy_timeout, index never deleted on SQLITE_BUSY. Deploys with 2.11. Was FD-15. |
| 11 | Release v0.3.9 so zero-downtime rollouts (2.10) deploy | done | claude-20261018-release-v039 | release-v039 | 2.10 | | v0.3.9 released (PR https://github.com/DynacomSolutions/filedeck/pull/58, a487094); the hub and all agents run filedeck:0.3.9, rollout healthy. Was FD-16. |
| 12 | Test sources surge on rollout (RollingUpdate maxUnavailable 0) like hub and agents | done | claude-20261018-test-sources-rolling | test-sources-rolling | 2.10 | 2026-10-18 14:00 ICT | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/59 (46cf5ec). Was FD-17. |
| 13 | Agents in a container list the host's mounts, not the container's (large disks such as a separate /home were missing from sizes) | done | claude-20261018-host-mounts | host-mounts | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/60 (23f1944). Deploys with 2.14. Was FD-18. |
| 14 | Release v0.3.10 (size store 3.16, test-source surge 2.12, host mounts 2.13) and confirm no service drops to zero ready pods during the rollout | done | claude-20261018-release-v0310 | release-v0310 | 2.13 | | Released and rolled out with no downtime; see 2.10. Was FD-19. |
| 15 | The sidebar tree opens the path to the current folder and closes what it opened when you move away; folders you opened yourself stay open | done | | | | 2026-10-21 01:30 ICT | Was FD-42. |

## 3. Cached folder sizes
ETA: 2026-10-18 18:00 ICT
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| 16 | Size store: per-folder size totals in SQLite on each agent, filled by the size scan and reused while a folder's inode and mtime are unchanged; one-folder delta updates propagated to parents; agent and hub `GET /api/du` | done | claude-20261018-size-store | size-store | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/55 (f31230e). Was FD-9. |
| 17 | fanotify helper: tiny native watcher marks each local filesystem when the agent pod has CAP_SYS_ADMIN and CAP_DAC_READ_SEARCH, feeds changed folders to the size store (flush on close-after-write, at most every 30 s for files still being written); without the capabilities the store relies on cached scans only | done | claude-20261018-fd10 | fanotify-watcher | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/66 (fe87e8b). Off by default (agent.fanotify.enabled). Was FD-10. |
| 18 | `filedeck du` CLI: du-compatible flags (-s, -h, -d N, -a, --apparent-size, --fresh), `node:/path` addressing, queries the hub with one read-only API token | done | claude-20261018-fd11 | du-cli | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/65 (a535663). Token travels in X-Filedeck-Token; off by default. Was FD-11. |
| 19 | Agent skill in this repo for every coding agent (Claude Code, Codex, Pi and others), not only Claude: one canonical SKILL.md in the open Agent Skills format at a tool-neutral path, referenced from AGENTS.md, and exposed to each tool's skill discovery path (for example .claude/skills, .agents/skills) without duplicating content; tells agents to use `filedeck du` instead of `du` | done | claude-20261018-fd12 | agent-skill | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/63 (dfb84fa). Was FD-12. |
| 20 | Sidebar tree folder rows show size, percentage and bar from the size store | done | claude-20261018-fd13 | tree-folder-sizes | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/64 (3c1970f). Adds GET /api/du?cachedOnly=1. Was FD-13. |
| 21 | Release v0.3.11 (size cache epic: du CLI and token, skill, tree folder sizes, fanotify watcher) | done | claude-20261018-release-v0311 | release-v0311 | 3.17, 3.18, 3.19, 3.20 | | Released and rolled out with no downtime; du API token verified end to end. Was FD-20. |
| 22 | /api/du reports watched true when the fanotify watcher covers the path and is not stale, so the CLI stops warning about missed changes | done | claude-20261018-du-watched | du-watched-flag | | | Merged in PR https://github.com/DynacomSolutions/filedeck/pull/70 (28f52d0). Deploys with 3.23. Was FD-21. |
| 23 | Release v0.3.12 so the du watched flag (3.22) deploys | done | claude-20261018-release-v0312 | release-v0312 | 3.22 | | Released v0.3.12 and rolled out with no downtime; cached du answers now report watched true where the change watcher covers the path. Was FD-22. |
| 24 | The details panel shows a folder's stored size (and when it was measured) without starting a scan | done | | | | 2026-10-21 01:30 ICT | Was FD-41. |

## 4. du scan robustness
ETA: 2026-10-21 01:00 ICT
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| 25 | `filedeck du` scans are never cut short by FILEDECK_WALK_MAX_ENTRIES: the size walk stores and forgets each folder as soon as its children are done, so memory follows tree depth, not tree size; the cap stays for listing, search and archive paths | done | | | | 2026-10-21 00:30 ICT | `filedeck du -h -d 2` on a large data tree reported "scan hit the entry limit, sizes are partial" (89G shown). Was FD-23. |
| 26 | Agent /healthz answers during big scans: scan rows are written on a worker thread (the main thread only reads), so a contended disk no longer stalls the event loop and kubelet stops killing an agent | done | | | | 2026-10-21 00:30 ICT | an agent restarted 8+ times on 20 Oct 2026 (liveness timeouts, then `HTTP 502: agent unreachable`). Was FD-24. |
| 27 | Release v0.3.13 so 4.25 and 4.26 deploy | done | | | 4.25, 4.26 | 2026-10-21 00:30 ICT | Was FD-25. |
| 28 | Size locks are granted in arrival order, so a du scan of a tree with constant writes is no longer starved by watcher updates and never stays queued | done | claude-20261020-du-lock-fifo | du-lock-fifo | | 2026-10-20 16:00 ICT | du stayed "queued, 0 entries" for 300 s and longer on a busy tree. Was FD-26. |
| 29 | Release v0.3.14 so 4.28 deploys | done | claude-20261020-du-lock-fifo | du-lock-fifo | 4.28 | 2026-10-20 16:30 ICT | Was FD-27. |
| 30 | The change watcher bounds its pending folders: past 50 000 it treats the burst like a kernel overflow (marks the watched trees stale) instead of growing until the agent runs out of heap | done | claude-20261020-fanwatch-bound | fanwatch-bound | | 2026-10-20 17:00 ICT | An agent ran out of heap (320 MB) while a bulk copy wrote a large tree into a watched filesystem. Was FD-28. |
| 31 | Release v0.3.15 so 4.30 deploys | done | claude-20261020-fanwatch-bound | fanwatch-bound | 4.30 | 2026-10-20 17:30 ICT | Was FD-29. |
| 32 | `filedeck du` keeps waiting through transient hub errors (502, 503, 504, network) and re-joins a lost job, instead of exiting while the scan runs on | done | claude-20261020-du-cli-retry | du-cli-retry | | 2026-10-20 18:00 ICT | A transient 503 during a long poll ended the CLI and the next scan started in parallel. Was FD-35. |

## 5. Agent memory scales with data
ETA: 2026-10-21 01:00 ICT
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| 33 | Change watcher keeps its pending folders in the size store's SQLite file (one row per folder with its due time, drained in batches by one timer) instead of one in-memory timer per folder, so a bulk copy of any size costs disk rows, not heap, and no longer falls back to marking whole trees stale | done | claude-20261020-scale-fanwatch | scale-fanwatch | 4.30 | 2026-10-20 17:45 ICT | Replaces the 50 000 cap from 4.30. Was FD-30. |
| 34 | Size walk memory is constant per tree depth: folders are read as a stream (`fs.opendir`), the walk holds one frame per depth level instead of every pending sibling, removed child folders are found in SQL instead of an in-memory child list, and stored children are validated in batches | done | claude-20261020-scale-walk | scale-walk | | 2026-10-20 18:30 ICT | One folder with millions of entries must not grow the heap. Was FD-31. |
| 35 | Listing, search, archive, trash and properties walkers read folders as a stream and stop at their existing caps, so one huge folder cannot load all its names at once | done | claude-20261020-scale-readdir | scale-readdir | | 2026-10-20 17:30 ICT | Was FD-32. |
| 36 | Stores that run without an index directory use a temporary SQLite file, never `:memory:`, so their rows stay off the heap | done | | | | 2026-10-20 19:00 ICT | Was FD-33. |
| 37 | The size store never drops to its in-memory fallback on a busy database: a locked read is a cache miss, a real failure reopens the store with backoff, and the fallback holds at most 20 000 rows | done | claude-20261020-scale-walk | scale-walk | | 2026-10-20 19:00 ICT | Root cause of the agent heap OOMs on 20 Oct: "database is locked", then up to 500 000 fallback rows per walk on the heap. Was FD-36. |
| 38 | Release v0.3.16 so epic 5 deploys | done | | | 5.33, 5.34, 5.35, 5.36 | 2026-10-20 19:30 ICT | Was FD-34. |
| 39 | An agent starts serving /healthz within seconds whatever the size of its stores: nothing proportional to store size runs before listen, and a startup probe covers a long WAL replay | done | | | | 2026-10-21 01:00 ICT | v0.3.16 never came up with a 2 GB store. v0.3.17 added the startup probe and dropped the full-table read on open; still open: the change watcher handles its backlog before the server listens. Was FD-37. |
| 40 | Release v0.3.17 so 5.39 deploys | done | | | 5.39 | 2026-10-21 01:00 ICT | Was FD-38. |
| 41 | The size walk keeps the disk busy (bounded parallel stats, no wait on each commit), so a tree of small folders on a busy disk scans at least 5x faster than v0.3.16 | done | | | | 2026-10-21 00:30 ICT | v0.3.16 walked about 100 entries/s at 6% CPU on a busy disk. Was FD-39. |
| 42 | Release v0.3.18 so 5.41 deploys | done | | | 5.41 | 2026-10-21 00:45 ICT | Was FD-40. |
| 43 | Release v0.3.19 so 3.24 and 2.15 deploy | done | | | 3.24, 2.15 | 2026-10-21 00:45 ICT | Was FD-43. |
| 44 | Release v0.3.20 so 5.39 deploys | done | | | 5.39 | 2026-10-21 01:15 ICT | Was FD-45. |

## 6. Housekeeping
ETA: 2026-10-21 00:19 ICT
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| 45 | Remove rebuildable and temporary material from this repo's .data folder and finished task worktrees | done | claude-20261021-cleanup | cleanup-20261021 | | 2026-10-21 00:19 ICT | Freed about 0.9 GiB: generated lag test tree, node_modules, dist copies, release tarballs; finished merged task worktree board-format-20261020. Kept scripts, notes and evidence. Was FD-44. |

## 7. Sidebar tree
ETA: 2026-10-21 04:30 ICT
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| 46 | Folding of long open folder paths in the sidebar tree is a user setting (off, or keep the last 2 to 5 rows) | done | | tree-settings | | 2026-10-21 04:30 ICT | Was FD-46. |
| 47 | The sidebar scrolls sideways when the tree is wider than it | done | | tree-settings | | 2026-10-21 04:30 ICT | Was FD-47. |
| 48 | Release v0.3.21 so 7.46 and 7.47 deploy | done | | | 7.46, 7.47 | 2026-10-21 04:30 ICT | Released and rolled out. Was FD-48. |

## 8. Durable jobs
ETA: 2026-10-21 09:00 ICT
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| 49 | Job polling in the UI survives an agent or hub restart: same job id, backoff, a waiting-for-the-agent state instead of lost track of the job | done | | durable-ui | | 2026-10-21 05:30 ICT | https://github.com/DynacomSolutions/filedeck/pull/99 Was FD-49. |
| 50 | Agent jobs are stored in SQLite with write-through, read-through and a lease, so the new pod serves the old pod's jobs during a rollout and orphans fail with a clear interrupted-by-restart error | done | | durable-store | | 2026-10-21 06:00 ICT | Plan: rollouts overlap two pods, so a restart-only rebuild is not enough. https://github.com/DynacomSolutions/filedeck/pull/100 Was FD-50. |
| 51 | On SIGTERM running jobs are interrupted cleanly (archive staging removed) and handed over for adoption | done | | durable-store | 8.50 | 2026-10-21 06:30 ICT | https://github.com/DynacomSolutions/filedeck/pull/100 Was FD-51. |
| 52 | Interrupted size, du, perms and password-free compress jobs re-run under the same id after a restart; extract and passworded compress fail clearly; secrets never stored | done | | | 8.51 | 2026-10-21 07:30 ICT | https://github.com/DynacomSolutions/filedeck/pull/101 Was FD-52. |
| 53 | Hub bulk operations persist and resume after a hub restart; the in-flight copy or move item is marked failed, never retried blindly | done | | | 8.50 | 2026-10-21 08:30 ICT | https://github.com/DynacomSolutions/filedeck/pull/102 Was FD-53. |
| 54 | Release so epic 8 deploys | done | | | 8.49, 8.52, 8.53 | 2026-10-21 09:00 ICT | Release run 39505147773 succeeded; the hub and all agents run 0.3.22 and their job stores are in place. Was FD-54. |

## 9. Job rows and size cache
ETA: 2026-10-21 17:36 ICT
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| 55 | Job rows: one subject line with ellipsis and full-text popover, then a pills line with the server and a coloured status pill | done | | job-rows | | 2026-10-21 14:00 ICT | https://github.com/DynacomSolutions/filedeck/pull/105 Was FD-55. |
| 56 | Job cancel is an X button at the top right of the row | done | | job-rows | | 2026-10-21 14:00 ICT | https://github.com/DynacomSolutions/filedeck/pull/105 Was FD-56. |
| 57 | Up to two detail lines under the progress bar, one line each with ellipsis and a popover with the rest | done | | job-rows | | 2026-10-21 14:00 ICT | https://github.com/DynacomSolutions/filedeck/pull/105 Was FD-57. |
| 58 | Size job detail lines: size, entries and ETA; then the folder being read | done | | job-rows | | 2026-10-21 14:00 ICT | https://github.com/DynacomSolutions/filedeck/pull/105 Was FD-58. |
| 59 | No conflicting size jobs: a second request for the same path joins the live job, overlapping paths never walk together | done | | job-rows | | 2026-10-21 14:00 ICT | https://github.com/DynacomSolutions/filedeck/pull/105 Was FD-59. |
| 60 | Sizes are cached indefinitely: Calculate size uses the cache by default with a separate Rescan, watched folders are trusted without the revalidate TTL, unwatched folders revalidate after it, and a job adopted after a restart reuses what was already stored | done | | job-rows | | 2026-10-21 14:00 ICT | https://github.com/DynacomSolutions/filedeck/pull/105 Was FD-60. |
| 61 | The root mount shows twice under a node ("/" and "/ (root)") in the sidebar tree | done | | root-dup | | 2026-10-21 14:00 ICT | https://github.com/DynacomSolutions/filedeck/pull/106 Was FD-61. |
| 62 | Two du requests for the same path join one job instead of queuing a second walk | done | | | 9.59 | 2026-10-21 15:00 ICT | https://github.com/DynacomSolutions/filedeck/pull/105 Was FD-62. |
| 63 | Size scan progress stalls for minutes at a time on a large tree (seen on /usr, before and after a restart) | done | | | | 2026-10-21 17:30 ICT | Writer back-pressure removed and slow-store logging added in https://github.com/DynacomSolutions/filedeck/pull/108; a fresh /usr scan under 0.3.24 logged one size-store commit of 150 s (5 commits, 340 s in all) and main-thread reads up to 3 s, with a 1.85 GB sizes database and a 379 MB write-ahead log that is not checkpointed. Fixing the slow commits now. WAL growth while a reader holds a snapshot capped (journal_size_limit, truncating checkpoint above 64 MiB) in https://github.com/DynacomSolutions/filedeck/pull/116; the 150 s commits are not reproduced yet, to be re-measured on 0.3.25. Confirmed on 0.3.25: a fresh /usr scan (610k entries, 36G) finished in 558 s; commits max 6 s, 20 s in all (was 150 s, 340 s); write-ahead log 15 MB (was 379 MB). Remaining slow reads tracked in 9.66. Was FD-63. |
| 64 | The CLI size wait exits with code 13 while the job is still running (the no-cap wait from 9.72 leaves no live handle) | done | | cli-exit13 | | 2026-10-21 15:00 ICT | Seen on a fresh /usr scan under 0.3.24: exit 13 after about 13 minutes at 62,274 entries. Cause: the CLI sleep waited on AbortSignal.timeout, whose timer Node unrefs, so the event loop emptied and Node exited 13. Fixed in https://github.com/DynacomSolutions/filedeck/pull/115. Was FD-68. |
| 65 | Release v0.3.25 so 9.63 and 9.64 deploy | done | | | 9.63, 9.64 | 2026-10-21 14:35 ICT | Release run succeeded; main CI green on e64ce3f; the hub and all agents run 0.3.25 (checked 2026-10-21 14:13 ICT). Was FD-69. |
| 66 | Main-thread size-store reads still take up to 1.6 s under IO pressure (getWithKids, kidPage), which pauses the agent event loop during big scans | done | | size-reads-offthread | | 2026-10-21 17:30 ICT | Seen on the 9.63 confirmation scan: 23 reads over 200 ms, 9.7 s in all. Size-store reads run in a read-only worker thread; after startup the main thread no longer touches the database file; tree pages per level so a 300k-child folder cannot exhaust the worker; reused rescans about 2x faster than before. https://github.com/DynacomSolutions/filedeck/pull/121, Opus reviewed twice. Was FD-70. |
| 67 | Release v0.3.27 so 9.66 and 9.68 deploy (v0.3.26 failed its build), then re-measure a fresh /usr scan | done | | | 9.66, 9.68, 9.69 | 2026-10-21 17:45 ICT | v0.3.26 failed its build (Release run 39566764618). v0.3.27: Release and main CI green on e7f0bb4; the hub and all agents run 0.3.27 (17:03 ICT). Fresh /usr scan: 36G in 59 s (0.3.25: 558 s); no slow commits; 2 reads over 200 ms, both in the read worker (max 277 ms); write-ahead log 17 MB. Was FD-71. |
| 68 | Image build tests fail and hang as root: a fanwatch modify re-run fires after 241 ms instead of 300 ms (fanwatch.test.ts:374), then the suite hangs until the 15 minute timeout | done | | release-build-hang | | 2026-10-21 17:45 ICT | Release run 39566764618. Causes: the size-store worker was unref'd before its message listener re-ref'd it, so an open store kept the process alive (hang); takeDue stamped last_run before its now-async reads, so a modify re-run could fire early. Fixed in https://github.com/DynacomSolutions/filedeck/pull/127; PR CI now runs the full server suite as root (480 pass, 0 fail). Was FD-72. |
| 69 | Root suite test race: a TTL test re-scanned within the 1 ms TTL and expected a re-read (size-store.test.ts:1220), failing the v0.3.27 release PR CI | done | | ttl-test-race | | 2026-10-21 17:15 ICT | PR CI run 39573141218; fixed by sleeping past the TTL before the assertion. https://github.com/DynacomSolutions/filedeck/pull/129 Was FD-73. |
| 70 | The change watcher stamps a folder's last run when it takes the row, not when the re-read finishes, so after a slow re-read the next modify re-run can come sooner than modifyMs after it | done | | fanwatch-last-run | | 2026-10-21 18:30 ICT | Pre-existing; noted while fixing 9.68. The watcher now records each folder's run end through the writer worker (noteRan) and pushes a waiting modify row to the end plus modifyMs. https://github.com/DynacomSolutions/filedeck/pull/132; root suite green in PR CI. Was FD-74. |
| 71 | Release v0.3.28 so 9.70 deploys | done | | | 9.70 | 2026-10-21 18:30 ICT | Release and main CI green on 26c385c; the hub and all agents run 0.3.28 (17:36 ICT). Was FD-75. |
| 72 | The CLI size wait gives up after its own 900 s limit while the job is still running; it should keep following a live job | done | | | | 2026-10-21 15:00 ICT | https://github.com/DynacomSolutions/filedeck/pull/109, the CLI had no 900 s cap; the default 3600 s --timeout is now no cap Was FD-64. |
| 73 | Release v0.3.23 so epic 9 deploys | done | | | 9.55, 9.56, 9.57, 9.58, 9.59, 9.60, 9.61, 9.62, 9.63, 9.72 | 2026-10-21 13:30 ICT | Release run 39547863442 succeeded; the hub and all agents run 0.3.23. Was FD-65. |
| 74 | Root-only fanwatch test fails on main after v0.3.23: settle event not held back (fanwatch.test.ts:377) | done | | fanwatch-modify | | 2026-10-21 14:00 ICT | Root cause: fanwatch drain() only read due modify rows inside the active window, so an event loop stall past settleMs left a watched change unread until the next event. Fixed in https://github.com/DynacomSolutions/filedeck/pull/111; the root fanwatch step passed in PR CI. Was FD-66. |
| 75 | Release v0.3.24 so 9.74 deploys | done | | | 9.74 | 2026-10-21 13:30 ICT | Release run succeeded; main CI green on b485ce0; the hub and all agents run 0.3.24 (checked 2026-10-21 12:45 ICT). Was FD-67. |

## 10. File list rename and focus
ETA: 2026-10-31 17:00 ICT
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| 76 | Rename shows a full input where the name was, not an ellipsis, uncropped by other columns | done | claude-20261031-rename-sort-focus | rename-sort-focus | | 2026-10-31 17:00 ICT | https://github.com/DynacomSolutions/filedeck/pull/138<br>CI green; web tests 105/105; checked in headless Chromium with mocked data. |
| 77 | After clicking a column header (sort and similar), keyboard navigation focuses the file list again | done | claude-20261031-rename-sort-focus | rename-sort-focus | | 2026-10-31 17:00 ICT | https://github.com/DynacomSolutions/filedeck/pull/138<br>CI green; web tests 105/105; checked in headless Chromium with mocked data. |

## 11. Background size jobs
ETA: 2026-11-01 19:00 ICT
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| 78 | Find why size jobs for .worktrees and DynacomSolutions keep running | done | claude-20261031-size-jobs | | | 2026-10-31 16:00 ICT | Watcher overflow marks whole watched trees stale, so du rescans 5M+ files.<br>Size commits take up to 3 h.<br>Every /api/du call is a visible job, queued behind overlapping scans. |
| 79 | Watched folders answer du and size requests from the store without a scan job | done | claude-20261031-size-store | size-store-fresh | 11.78 | 2026-11-01 07:30 ICT | Third review: cross-process races and full rescan after restart<br>Owner chose single writer (11.91, 11.92)<br>Merged https://github.com/DynacomSolutions/filedeck/pull/156 |
| 80 | Jobs not started in the UI run in the background, listed in a separate background jobs view | done | claude-20261031-bg-jobs | background-jobs | 11.78 | 2026-10-31 19:30 ICT | CLI, API, watcher and adopted jobs.<br>https://github.com/DynacomSolutions/filedeck/pull/141; CI green. |
| 81 | Watcher overflow re-reads only the folders that were pending, not whole watched trees | done | claude-20261031-size-store | size-store-fresh | 11.78 | 2026-11-01 07:30 ICT | Third review: cross-process races and full rescan after restart<br>Owner chose single writer (11.91, 11.92)<br>Merged https://github.com/DynacomSolutions/filedeck/pull/156 |
| 82 | Size-store commits no longer stall for hours during a big rescan | done | claude-20261031-size-store | size-store-fresh | 11.78 | 2026-11-01 07:30 ICT | Third review: cross-process races and full rescan after restart<br>Owner chose single writer (11.91, 11.92)<br>Merged https://github.com/DynacomSolutions/filedeck/pull/156 |
| 83 | du CLI has a default timeout and a cached-only flag; the skill says to use them | done | claude-20261031-bg-jobs | background-jobs | 11.78 | 2026-10-31 19:30 ICT | https://github.com/DynacomSolutions/filedeck/pull/141; CI green. |
| 84 | Release so 11.79, 11.81 and 11.82 deploy | in_progress | claude-20261101-release-v0332 | release-v0332 | 11.79, 11.81, 11.82, 11.91, 11.92 | 2026-11-01 08:30 ICT | release v0.3.32 |
| 85 | Release v0.3.29 so 10.76, 10.77, 11.80 and 11.83 deploy | superseded | claude-20261031-release-v0329 | release-v0329 | 10.76, 10.77, 11.80, 11.83 | 2026-10-31 17:30 ICT | Superseded by 11.86. v0.3.29 tag pushed; Release run 41185463592 failed the image scan (dompurify advisories), no image published.<br>Release PR https://github.com/DynacomSolutions/filedeck/pull/143. |
| 86 | Release v0.3.30 so 10.76, 10.77, 11.80 and 11.83 deploy | done | claude-20261031-release-v0330 | release-v0330 | 10.76, 10.77, 11.80, 11.83 | 2026-10-31 18:30 ICT | Released 31 Oct (#145); hub and all agents on 0.3.30, 0 restarts |
| 91 | Size store has one writer at a time, with lease and fencing; a waiting process serves reads | done | claude-20261031-size-store | size-store-fresh | 11.78 | 2026-11-01 07:30 ICT | Owner decision 31 Oct<br>Merged https://github.com/DynacomSolutions/filedeck/pull/156 |
| 92 | Watcher sessions hand over on rolling deploys, so a restart does not rescan | done | claude-20261031-size-store | size-store-fresh | 11.91 | 2026-11-01 07:30 ICT | Merged https://github.com/DynacomSolutions/filedeck/pull/156 |
| 93 | SFTP host-key test is flaky under load | todo | | | | | `sftp: without a pin a changed host key is refused and named` (server/test/sftp-hostkey.test.ts) failed 2 times in about 20 full runs<br>likely restarting the fake SFTP server on the same port after 200 ms. |

## 12. Preview, editor and mobile layout
ETA: 2026-11-01 01:00 ICT
| ID | Task | Status | Owner | Branch | Depends | ETA | Notes |
|---|---|---|---|---|---|---|---|
| 87 | Preview shows the real file type (text, code, images) instead of hex | done | claude-20261031-preview-type | preview-type | | 2026-10-31 23:30 ICT | Merged #150<br>Unknown or missing extensions now sniffed; live after next release |
| 88 | Editor supports select and select all (keyboard and a visible action) | done | claude-20261031-editor-mobile | editor-mobile | | 2026-11-01 01:00 ICT | Merged #151<br>Select all action, Ctrl/Cmd+A from toolbar; live after next release |
| 89 | Mobile: panels no longer crushed, on-screen keyboard never covers the edit input | done | claude-20261031-editor-mobile | editor-mobile | | 2026-11-01 01:00 ICT | Merged #151<br>Phone drawer, one panel at a time, viewport tracking<br>Real iOS and Android keyboards untested |
| 90 | Release v0.3.31 so 12.87, 12.88 and 12.89 deploy | done | claude-20261031-release-v0331 | release-v0331 | 12.87, 12.88, 12.89 | 2026-10-31 18:30 ICT | Released 31 Oct (#153)<br>Hub and all agents on 0.3.31, 0 restarts |
