# Size store heals itself

Owner decision, 18 Nov 2026: a folder-size store that is damaged beyond its index repair must recover by itself. No operator step. This reverses board rows 11.98 and 18.149.

## Problem

- An agent logs at every start: `size store unavailable, folder sizes are not cached: database disk image is malformed`.
- Since 11.98 the agent never moves, changes or deletes a damaged store. An operator must stop the agent and move the file aside.
- The move-aside of PR 161 was dropped after three reviews found races between processes. Several processes can have the file open: the writer and reader workers of one agent, and an old and a new agent during a rolling update.

## Why a move-aside races

SQLite finds the `-wal` and `-shm` files of a database by name. If a path is renamed or deleted and a new database is made at the same path, a process that still has the old file open uses the same `-wal` and `-shm` names as the processes on the new file. Examples:

- The last connection of the old file closes, checkpoints and deletes `<path>-wal`. That is the write-ahead log of the new file, so the new file loses committed pages.
- A reader worker that opens the path after the swap reads the new file, while the writer worker of the same process still writes the old one.

A rename does not help: the `-wal` and `-shm` names do not follow it.

## Design: generations, a path is never used again

1. **File names.** `sizes-<node>.db` is generation 0 (the name all versions used). Generation N > 0 is `sizes-<node>.db.<N>`. The current store is the highest generation whose main file exists. Each generation has its own `-wal` and `-shm` names.
2. **No open creates a file.** Every SQLite open of a store file (main thread, writer and reader workers) uses `file:<path>?mode=rw`. A file that is gone fails to open and the process looks for the current generation again. Only two places create a store file:
   - generation 0, when no generation exists (a new install), as before;
   - generation N+1, made by a heal: built under a temporary name, then put in place with `link()`, which fails if the name exists. Only one process can make generation N+1.
3. **Heal.** A process heals when the damage is real: `integrity_check` reports more than indexes, or SQLite reports SQLITE_CORRUPT or SQLITE_NOTADB at open, lease or check. Index-only damage is still rebuilt in place by the lease holder (11.95). The heal:
   - reads the folder again; if a higher generation exists, it follows it and does not heal;
   - else makes generation N+1 (incremental auto-vacuum and the schema are set before it is put in place);
   - switches to it, then deletes every file of the lower generations (main, `-wal`, `-shm`, journal);
   - logs one line: `size store: <old> was damaged (<first problems>); it is deleted and a new store <new> is used. Folder sizes are measured again.`
   - A process heals at most once in 10 minutes, so a failing disk cannot make it loop. A failed heal (for example, a full disk) is logged and tried again.
   - No lease is needed: the lease lives in the damaged file, which may not be readable. The exclusive `link()` is the lock.
4. **Follow.** Every process lists the index folder on each lease tick (a third of the lease time, also while the store is unavailable). A higher generation makes it switch:
   - it closes the connections of its writer and reader workers to the old file, then stops them;
   - requests still waiting on them fail as "fenced" (the lease is lost), never as damage;
   - it forgets everything it read from the old file: lease epoch, first epoch, stale marks, the validation floor (now), and it marks `/` stale, the same as when a store comes back after an outage;
   - the change watcher starts a new session in the new file;
   - a walk that began on the old file never commits to the new one (a generation check before each commit).
5. **Why the races are closed.**
   - A path is never reused for another database: numbers only grow, a lower generation is deleted only after a higher one exists, and no process opens a store file with create (except generation 0 when there is none).
   - A process still on the old file (until its next tick, or an older version until it exits) writes only into that file or into `-wal` and `-shm` names that no current process uses. Its writes are lost, never mixed in. Fencing in the old file still works as before.
   - A crash during a switch leaves a higher generation and lower leftovers. The highest wins and any process deletes the leftovers when it opens.
   - Two processes that find the damage at the same time: one `link()` wins, the other gets EEXIST and follows.
6. **Migration.** Nothing to do. An existing `sizes-<node>.db` is generation 0 and stays in use until it is damaged or compacted (below). Older versions keep using it. They never see generation 1 or later.
7. **Disk use.** A new generation starts empty. The deleted file uses space only while a process still has it open: a current-version process lets go at its next tick, an older version when it stops.

## Why 16.5 GB

- A synthetic store with the real schema holds about 350 to 600 bytes per folder (the `sizes` table plus the `sizes_parent` index; paths of 60 to 160 characters). 6 million folders is 2 to 3.5 GB, or up to about 5 GB with the page splits of rows written in any order.
- The file is never made smaller: `auto_vacuum` is off, so pages freed by deleted folders stay in the file as free pages. The file is the high-water mark of every folder the agent ever stored, including large trees deleted since (build output, worktrees).
- The file was also damaged by a crash while the store ran with `synchronous=OFF` (fixed in 18.149).
- Fix:
  - new generations use `auto_vacuum=INCREMENTAL`; the writer gives free pages back in steps of 8 MiB when more than a tenth of the file and 16 MiB are free;
  - a generation 0 file without auto-vacuum that is more than half free pages and more than 1 GiB free is compacted once by the lease holder: it starts a new generation the same way as a heal, with its own log line;
  - every open logs the file size and free space when more than a quarter is free.

## Out of scope

- The compare index (`index-<node>.db`) and the jobs file are not changed.
- The `/metrics` gauges stay as they are: `filedeck_size_store_damaged` is 1 only while a heal has not yet succeeded.
