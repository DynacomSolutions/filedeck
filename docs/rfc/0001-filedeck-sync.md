# RFC 0001: FileDeck sync

Status: draft for the owner. Date: 28 Nov 2026. Author: design sub-agent.

This RFC studies a file sync system built into FileDeck, to replace Syncthing. It changes nothing in Syncthing or its chart. It adds no code. It lists the work as board epic 32.

## 0. Summary

- Syncthing wastes CPU because it finds changes by scanning. A new file in a big folder starts `scanSubdirs`, `findRename` and `CountNeed` on a per-folder SQLite database. Each of the four nodes also keeps a copy of every peer's file list.
- FileDeck already knows what changed. The agent reads fanotify (Linux) or FSEvents (Mac) once, writes a journal with a cursor and serves it on a socket. A sync daemon can read that stream and never walk a folder in normal work.
- Proposal: a new daemon `filedeck-syncd` (Rust, a crate in the agent workspace). It follows the change stream, keeps one shared catalogue of file versions in HoardDB (the Postgres engine), moves content in content-defined chunks (FastCDC) over mTLS, and keeps conflicts as copies.
- Node-only facts stay in a small local SQLite file: the stat cache, the chunk cache, the transfer spool and the stream cursor. All of it can be rebuilt. The catalogue is shared.
- Syncthing keeps running during the whole migration. Each folder has exactly one active system. FileDeck sync first runs in shadow mode and proves its result with hash manifests.
- A new folder type, `drain`, moves files one way from the MacBook to eu3 and eu4 and removes them from the Mac after every target has a durable copy (section 3.11). The MacBook is in release 1.
- Some folders should not be synced at all (section 5).
- Measured data is partly missing. Sizes and VictoriaMetrics series were not readable from the design agent's pod (section 2.4). Phase 0 (row 32.219) closes that gap before any build work.

## 1. Goals and rules

Goals:

1. No scan in normal work. Idle cost is near zero.
2. No data loss. A delete, a conflict or a crash never destroys the only copy.
3. Every part is event driven. Owner rules: no cron, no free-running timers, sizes from FileDeck.
4. One catalogue that shows, for each folder, what each node has and what it needs.
5. Metrics, alerts and probes from day one (the no-gaps rule).

Non-goals for version 1:

- File sharing with people outside the node pool.
- The seedbox peer (section 8, question 6).
- Extended attributes, ACLs and owners. Version 1 syncs content, mtime, mode bits, symlinks and empty folders.
- A GUI. The web app gets a read-only sync view after the engine works.

## 2. Inventory

### 2.1 Where the data comes from

- Chart values and README of `syncthing/` in `.cluster` (pinned image `2.1.5-walfix.9` on all four nodes).
- The live configuration, read from the start-up lines of each `syncthing` container log on 28 Nov 2026 (about 11:39 UTC for eu3 and eu4, earlier for hq0 and hq1). The pod has no `exec` right and no API key, so `config.xml` and the REST API were not read. Folder labels, ids and types are exact. The peer list of each folder is not in the log.
- `kubectl top` on 28 Nov 2026, about 11:50 UTC.

### 2.2 Folders

Paths on eu3 and eu4 are in the legacy tree `/home/storage/<label>` (seen in the eu4 warnings for Videos and Unsorted). The column "Why it exists" is inferred from the label. Thomas should correct it. On hq0 and hq1 they are under `/home/Storage`. All folders are `sendreceive` in the live log. The chart makes eu3 and eu4 use `ignorePerms`.

| Folder (id) | Nodes | Mode | Size, files | Why it exists |
|---|---|---|---|---|
| Downloads (`4nskz-nzujm`) | eu3, eu4 | send-receive | phase 0 | Downloads staging copy |
| Thomas' Downloads (`yrrxb-gag7e`) | eu3, eu4 | send-receive | phase 0 | Second downloads folder |
| Movies (`yir6g-jdqs2`) | eu3, eu4 | send-receive | phase 0 | Media library copy (scan 2 min 34 s on eu3) |
| Shows (`azga4-gjkfg`) | eu3, eu4 | send-receive | phase 0 | Media library copy (scan 4 min 38 s on eu3) |
| Videos (`tnzzf-drrew`) | eu3, eu4 | send-receive | phase 0 | Media and the `x` upload target (scan 55 s) |
| Unsorted (`4gcpp-tfkay`) | eu3, eu4 | send-receive | phase 0 | Old files, game saves and backups (scan 5 min 16 s) |
| Music (`gciqs-adzj5`) | eu3, eu4 | send-receive | phase 0 | Music library copy |
| Photos (`dgqzy-dkg9f`) | eu3, eu4 | send-receive | phase 0 | Photos copy |
| Obsidian (`4p2fe-y3toa`) | eu3, eu4 | send-receive | phase 0 | Notes, small |
| RenPy Saves (`m7tbt-fkhqw`) | eu3, eu4 | send-receive | phase 0 | Game saves, small |
| Games Library (`ly3of-owrn2`) | eu3, eu4 | send-receive | phase 0 | Game files |
| Installed Games (`qyfem-yplew`) | eu3, eu4 | send-receive | phase 0 | Installed game trees |
| Software (`gcfh7-qbzer`) | eu3, eu4 | send-receive | phase 0 | Software copy. Holds a Plex config tree with read errors (chart note). Scan 2 min 17 s |
| tapo-footage (`tapo-footage`, no label) | eu3, eu4 | send-receive | phase 0 | Camera footage copy |
| Software (`software-hq0-hq1`) | hq0, hq1 | send-receive | phase 0 | Herdr is the one writer on hq0, hq1 is a standby copy |
| MacBook Downloads (`macbook-downloads`) | hq0, MacBook | send-receive | 28 files and 16.6 GB were pending on 15 Oct | Mac `~/Downloads` to hq0. The `x` uploader moves finished files on to eu4. Becomes a `drain` folder (3.11) |
| db-backups | none | none | 454 GB | Moved to HoardDB object storage (ADR 0021). Removed from Syncthing on 28 Nov 2026 |
| Projects (`xsxoe-fqfja`) | none live | none | 21.7 M files in Oct | In the chart (`projectsIgnore`, `folderOverrides`) and README. It is in no node's live log. The chart entries are left over |

Extra devices in the eu3 and eu4 configuration: `hq0`, `hq1`, the old `archlinux` device (address `dynamic`) and the external peer `comet.seedhost.eu`. The log does not say which folders they share. Phase 0 reads the folder to device map from `config.xml`.

Other findings from the logs:

- eu4 cannot read two files: `Videos/unsorted/Scene_2 Jynx Maze_720p.mp4` and `Unsorted/media/backups/.../region3d/1.4.-3.3dr` fail with `input/output error`. Syncthing retries both about every 10 s. This looks like a disk or filesystem fault, not a sync fault. The new engine must treat a read error as a per-file state with back-off, not as a retry loop (section 3.9).
- hq0's Syncthing pod restarted 26 times in 9 days. hq1's pod restarted 7 times in 8 days.
- The same Software content has two folder ids: `gcfh7-qbzer` (eu3, eu4) and `software-hq0-hq1` (hq0, hq1). They do not meet.

### 2.3 Sizes and file counts

Not measured by this study. `filedeck du` needs a hub token, which the design pod does not hold, and the ingress refuses a request without one. Row 32.219 fills the two columns with:

```sh
filedeck du --cached -s -h eu3:/home/storage/Movies   # one call per folder and node
filedeck du --cached --json -s eu3:/home/storage/Movies   # --json gives the file count per folder
```

Use `--cached` or `--refresh-auto` only. Never `du`, `ncdu` or `find`.

### 2.4 Syncthing CPU and RAM

Seven-day p50 and p95 from VictoriaMetrics were not read: pods have no route to VictoriaMetrics (known gap, `.cluster` row 166.714). The design pod got `connection refused` on port 8428. Row 32.219 runs these queries from a node with access:

```promql
quantile_over_time(0.5,  rate(container_cpu_usage_seconds_total{namespace="syncthing",container="syncthing"}[5m])[7d:5m])
quantile_over_time(0.95, rate(container_cpu_usage_seconds_total{namespace="syncthing",container="syncthing"}[5m])[7d:5m])
quantile_over_time(0.5,  container_memory_working_set_bytes{namespace="syncthing",container="syncthing"}[7d])
quantile_over_time(0.95, container_memory_working_set_bytes{namespace="syncthing",container="syncthing"}[7d])
```

What is known now:

| Node | Folders | Owner figure (steady) | `kubectl top` at start-up | `kubectl top` after the scans | Chart limit |
|---|---|---|---|---|---|
| eu3 | 14 | about 1 core | 2042 m, 2050 Mi | 324 m, 1808 Mi | 2 CPU, 24 Gi (`GOMEMLIMIT` 8 GiB) |
| eu4 | 14 | 730 m | 1492 m, 1390 Mi | 243 m, 1402 Mi | 2 CPU, 24 Gi (8 GiB) |
| hq0 | 2 | not given | 2 m, 55 Mi | same | 8 CPU, 24 Gi |
| hq1 | 1 | not given | 3 m, 48 Mi | same | 4 CPU, 4 Gi (`GOMEMLIMIT` 3 GiB) |

The owner figure is the steady cost that Thomas measured. The two `kubectl top` columns are single samples taken right after the pods restarted for the `db-backups` removal, so they are not p50 values. hq1's seven-day memory peak was 1.75 GiB before the 4 Gi limit was set (`.cluster` board).

## 3. Design

### 3.1 Parts

```
  node A                                         node B
  +-----------------------------+                +-----------------------------+
  | filedeck agent (fanotify)   |                | filedeck agent (fanotify)   |
  |   journal + events socket   |                |   journal + events socket   |
  +------+----------------------+                +------+----------------------+
         | NDJSON, cursor                                | NDJSON, cursor
  +------v----------------------+   mTLS, h2     +------v----------------------+
  | filedeck-syncd              <---------------->| filedeck-syncd              |
  |  local SQLite: stat cache,  |  chunk fetch   |  local SQLite: stat cache,  |
  |  chunk cache, spool, cursor |                |  chunk cache, spool, cursor |
  +------+----------------------+                +------+----------------------+
         | SQL over TLS, LISTEN/NOTIFY                   |
         +---------------------+  +----------------------+
                               v  v
                     HoardDB (Postgres): the catalogue
```

- The agent stays the only reader of kernel events. `filedeck-syncd` reads the node's Unix events socket (`docs/change-events.md`). It needs no new privilege. It works with today's TypeScript agent and later with the Rust agent (`agent/`).
- `filedeck-syncd` is its own Deployment per node. It has its own limits, probes and metrics. A bug in sync cannot stop browsing or sizes.
- Control traffic goes to the catalogue. Content goes directly between nodes.
- The folder to node map and each node's role live in the catalogue. No device id is committed to a chart.

### 3.2 Change detection with no rescan

Each synced folder is a `prefix` filter on the events socket. The daemon sends `since=<cursor>` on connect.

1. An event names a path. `create`, `move`, `delete` and `attrib` are handled at once. A file is ready on `close_write`, not on `modify`. A file that is still written stays quiet until its `close_write`.
2. The daemon runs `lstat` on the path and compares it with the stat cache `(inode, size, mtime)`. If it is equal, the event ends there. This is what kills the `scanSubdirs` cost. One event costs one `lstat`.
3. If the stat differs, the daemon chunks and hashes only that file (3.4) and queues a catalogue update.
4. A file that no `close_write` follows (a move into place, a hard link) is handled on its `move` or `create` event.
5. The daemon stores a cursor only after the resulting changes are durable in the local outbox (3.7). The cursor then never runs ahead of the work.
6. Echo suppression: when the daemon writes a file itself, it records the final `(path, size, mtime, inode)` in the spool before the rename. The echo event finds that record and ends. The temporary names `.fdsync-<id>.part` are ignored by the filter, so they make no events.
7. A deadline is armed for a path only while a file looks unstable (size changed since the `lstat`). It is one armed deadline per path, set by an event. No global tick exists.

Lost events (the cursor rules in `docs/change-events.md`):

| Signal | Meaning | Action |
|---|---|---|
| `overflow`, scope node, with `window` | The kernel dropped events | Stat check of every synced prefix, hash only where the stat differs |
| `reset`, scope filesystem, with a mount path | One mount was not watched | The same check, only for synced prefixes under that mount |
| `reset`, scope node | The helper stopped or two agents overlapped | Same as `overflow` |
| `reset` after `since=` | The cursor is too old or from another epoch (journal holds 24 h or 2 GiB) | Same as `overflow` |
| `unwatched` mounts in `ready` | Network or unreachable mounts | The folder is marked `unwatched`. It is not synced and an alert fires (3.10) |

The stat check is a targeted subtree check, not a scan with hashing. For 650 k files it needs 650 k `lstat` calls on warm dentries, which is seconds, with no database write for an unchanged file. A check runs only when a lost-event signal arrives. It never runs on a clock. The metric `filedeck_sync_resync_total{reason}` counts them, and an alert fires when the rate is not near zero (3.10).

The first start on a folder needs a baseline: one full stat and hash pass. It is an explicit, logged job with a bandwidth and CPU budget, run once. The existing size store helps: a folder whose stored total and file count equal the catalogue total can skip hashing files that match by `(size, mtime)`.

### 3.3 Catalogue (what is shared)

One row per path per folder in HoardDB: `kind` (file, dir, symlink), `size`, `mtime`, `mode`, `content` (the root hash), `rev`, `deleted`, `origin` (the node that wrote the version). The folder row holds `next_rev`. Each node has an `applied_rev` row per folder: how far it has applied.

- A writer takes the folder's `next_rev` under a row lock once per batch, not once per file. Each batch gets a gap-free range of revisions in commit order. A reader asks for `rev > applied_rev` and cannot miss a row.
- A node that commits a batch sends `NOTIFY sync_<folder>`. A peer that listens wakes at once. After a reconnect, it queries from `applied_rev`. A lost notification costs nothing, because the log is the truth.
- A peer finds what it needs with one indexed query for a window of revisions. It does not hold a copy of every other node's index. This removes the work that `CountNeed` does.
- Tombstones stay until every node of the folder has `applied_rev` past them. That check runs when a node acknowledges, not on a timer.

### 3.4 Delta transfer: FastCDC, not rsync

| | rsync rolling hash | FastCDC chunks |
|---|---|---|
| Who reads the old file | The receiver reads the whole old file and sends block sums for each transfer | Nobody. Chunk lists are made once at hash time and cached |
| Round trips | A signature round trip for every file | One list exchange, then the missing chunks |
| Insert in the middle of a file | Found by the rolling window, at CPU cost on the sender | Found, because boundaries follow content |
| Rename and move | A new transfer | The same chunks. No transfer |
| Dedup across files | None | Yes, for chunks the node already has (copy locally) |
| Resume | Hard, per file | By chunk, free |
| Verification | Extra whole-file hash | The chunk hashes build the file hash |
| State | None | 40 bytes per chunk, cached per node |

Recommendation: FastCDC with BLAKE3.

- Files under 4 MiB are one chunk. The chunk hash is the file hash.
- Files of 4 MiB and more use FastCDC with minimum 256 KiB, average 1 MiB and maximum 4 MiB. The file hash is the BLAKE3 hash over the chunk hash list (a tree hash).
- BLAKE3 hashes above 1 GB/s per core on x86 and on Apple silicon. Syncthing's own start-up hash benchmark gave 377 MB/s on eu3 and 1.56 GB/s on hq0.
- Media files are mostly written once. Their gain is resume, move detection and verification, not delta size. The delta gain is for save files, notes, logs and project trees.
- Chunk lists are made at hash time on the sender and cached in the node's SQLite file. The catalogue holds only the root hash, so its size stays small. A receiver asks the sender for the chunk list of a version it needs.
- The receiver builds the new file from local chunks that it already holds (the old version or another file) and fetches the rest. It verifies each chunk hash on arrival.

### 3.5 Conflicts: revisions, not version vectors

Syncthing uses version vectors because it has no central authority. FileDeck sync has one: the catalogue. A simpler rule is correct here.

- Each node keeps for each path the `base_rev` it last applied. A local change is a new version on top of `base_rev`.
- The node publishes with compare-and-set: the catalogue accepts it only when the path's `rev` still equals `base_rev`. If it does not, another node wrote first: this is a conflict.
- On a conflict, both versions are kept (owner decision, 28 Nov 2026). The newer write (newer mtime, tie: the lower node id) keeps the name. The other version becomes a conflict copy next to it, named `name.sync-conflict-<yyyymmdd-hhmmss>-<node>.ext`, and is published as a new file. A change event reports each conflict. This is the Syncthing convention, so people recognise it.
- Modify against delete: the modify wins. The file returns.
- Directory against file with the same name: the file is renamed as a conflict copy.
- Case-insensitive targets (Mac): two paths that differ only by case are a conflict. Names are stored as bytes. A Mac node normalises to NFC on its own side only.
- Offline writes still work. A node that cannot reach the catalogue keeps editing locally. Its changes publish later against `base_rev`. Split brain cannot create two authorities.
- Version vectors remain the fallback if a future design drops the catalogue.

### 3.6 Folder roles and delete safety

Each folder and node pair has a role:

| Role | Local change | Remote change |
|---|---|---|
| `send-receive` | Published | Applied |
| `send-only` | Published | Not applied. Reported as a difference |
| `receive-only` | Not published. Counted as a local difference | Applied |
| `drain-source` | Published, then removed from the source after every target confirms (3.11) | Not applied |
| `drain-target` | Not applicable | Applied into the target's own destination folder (3.11) |

- A receive-only node shows local differences as a number and as a list. An explicit action reverts them (fetch the catalogue version again). Nothing reverts by itself.
- A folder has a marker file `.filedeck-sync` (like `.stfolder`). If the marker is missing, the folder is paused and an alert fires. This stops the classic loss: a disk that did not mount looks like an empty folder, and the empty folder looks like a mass delete.
- Applying a remote delete moves the file to the node's `.filedeck-trash` (the FileDeck trash), never `unlink`. The file stays in the trash for 7 days (owner decision, 28 Nov 2026).
- Mass-delete guard: a batch that deletes more than 1000 files or 5 percent of a folder stops and waits for approval. It raises an alert and a change event.
- Hard links are separate files. Symlinks sync as symlinks and are never followed. Sockets and devices are skipped.
- `.stignore`-style rules are per folder in the catalogue, not per device. They use the linear-time glob matcher of the event filter. This removes the per-device `.stignore` copy that the chart's init containers write today.
- Syncthing files (`.stfolder`, `.stignore`, `.stversions`, `~syncthing~*`, `.syncthing.*.tmp`) are ignored by default during the overlap.

### 3.7 Transfer, resume and local state

- A receiver plans from the catalogue, then pulls chunks from the node that has the version (the origin, or any node that already holds it). Eight chunk requests are in flight per stream.
- A chunk is written to `.fdsync-<rev>.part` at its offset. A spool row records finished chunks. The spool is fsynced every 64 chunks and at the end.
- After a crash, the spool is read and each chunk marked done is re-hashed from disk (cheap, local). The transfer continues from the first missing chunk.
- Commit: all chunks present, the tree hash equals the catalogue `content`, `fsync` the file, set mtime and mode, then `rename` into place. Just before the rename, an `lstat` of the target must equal what the daemon expects. If a local edit landed meanwhile, the incoming version becomes a conflict copy (3.5).
- Every transfer is idempotent. A repeated event, a repeated chunk or a repeated commit changes nothing.
- Local SQLite holds only node facts: stat cache, chunk cache, spool, outbox and stream cursor. It is a cache plus a small outbox. It can be rebuilt from the disk and the catalogue. The outbox is rebuilt by the stat check if lost.

### 3.8 Encryption and identity

Is WireGuard enough? No, not alone.

- The tailnet and the cluster overlay encrypt and authenticate node to node. They do not say which process or pod may fetch which folder. Any pod that can reach the port could ask for a folder. The path between two pod IPs is not shown to be encrypted in every hop.
- Syncthing uses TLS 1.3 with device certificates on top of the network. The log shows `TLS1.3-TLS_AES_128_GCM_SHA256` on every link. Dropping that would be a step back.
- Recommendation: mTLS (TLS 1.3, HTTP/2) between daemons, always. WireGuard stays as the outer layer. Each node holds a certificate from a FileDeck sync CA (cert-manager `Issuer`). The catalogue lists which node may read which folder, and the daemon checks the peer certificate against it on every request. A reloaded certificate (file change event) needs no restart.
- Chunk hashes are checked on arrival, so a damaged or forged chunk is found even without TLS.
- The CPU cost of TLS at 1 Gbit/s is small on modern cores (AES-NI, ARM crypto). It is not a reason to drop it.

### 3.9 Network: MTU 1230

The cluster network MTU is 1230. A TCP segment then carries at most 1190 bytes of payload on IPv4 (1230 less 20 for IP and 20 for TCP) and 1170 on IPv6. TLS adds about 22 bytes per record.

- Use TCP with TLS 1.3 and HTTP/2 for version 1. Set `TCP_MAXSEG` through the node's MSS clamp, and do not rely on ICMP "fragmentation needed" messages, which some paths drop.
- Do not tune application frames to the MTU. Use large TLS records (16 KiB) and large chunk writes (0.25 to 4 MiB). The kernel splits them. Small application frames waste headers: at 1190 bytes per segment, headers cost about 3.4 percent.
- Avoid QUIC in version 1. A QUIC Initial packet needs a 1200-byte UDP payload. On IPv4 that is 1228 bytes on the wire, which fits in 1230 by two bytes. On IPv6 it is 1248 bytes and does not fit. Syncthing's QUIC listener is already running next to TCP here. Test the path before any QUIC plan.
- The long links (eu3 and eu4 to hq, about 224 ms round trip per the databases README) need a large window: at 100 Mbit/s the bandwidth-delay product is about 2.8 MB. Set the HTTP/2 stream window to 4 MiB and the connection window to 16 MiB. Syncthing's 128 KiB blocks do not fill such a link. This is a throughput gain on its own.
- Row 32.222 includes a path test: send a 4 MiB chunk over each node pair and record throughput and retransmits. The result sets the in-flight count.

### 3.10 Metrics, alerts and probes (no gaps)

`filedeck-syncd` serves `/metrics`. vmagent scrapes it in the same `.cluster` change that adds the Deployment. Every series starts at 0.

| Metric | Use |
|---|---|
| `filedeck_sync_events_total{node,folder,kind}` | Events read |
| `filedeck_sync_stream_cursor_lag_seconds{node}` | Age of the last stored cursor against the stream head |
| `filedeck_sync_dirty_paths{node,folder}` | Paths waiting to publish |
| `filedeck_sync_out_of_sync_bytes{node,folder}`, `_files` | Bytes and files this node still needs |
| `filedeck_sync_oldest_unsynced_seconds{node,folder}` | Age of the oldest change not yet applied everywhere |
| `filedeck_sync_resync_total{node,folder,reason}` | Lost-event checks |
| `filedeck_sync_bytes_total{direction,node,peer,kind=chunk\|reused}` | Traffic and delta savings |
| `filedeck_sync_conflicts_total{folder}` | Conflict copies made |
| `filedeck_sync_held_deletes{folder}` | Deletes waiting for approval |
| `filedeck_sync_local_changes{folder}` | Receive-only differences |
| `filedeck_sync_file_errors{folder,class}` | Files in a read or write error state (`eio`, `perm`, `enospc`) |
| `filedeck_sync_db_up`, `_db_query_seconds` | Catalogue reachability and latency |
| `filedeck_sync_peer_up{peer}`, `_cert_expiry_seconds` | Link and certificate state |
| Process CPU and RSS, open files | Efficiency targets (section 6) |

Alerts (vmalert, in `.cluster`, added with the Deployment):

- `filedeck-sync-lag`: `oldest_unsynced_seconds` over 600 for 10 minutes.
- `filedeck-sync-stuck`: `out_of_sync_bytes` above 0 and no progress for 30 minutes.
- `filedeck-sync-resync`: more than 3 lost-event checks in 1 hour on one node.
- `filedeck-sync-db-down`: `db_up` is 0 for 5 minutes.
- `filedeck-sync-peer-down`: `peer_up` is 0 for 10 minutes.
- `filedeck-sync-cert-expiry`: under 14 days.
- `filedeck-sync-held-deletes`: any held delete for 1 hour.
- `filedeck-sync-conflicts`: a rise of more than 20 in 1 hour.
- `filedeck-sync-file-error`: a file in `eio` for 1 hour (this catches the eu4 case today).
- `filedeck-sync-local-changes`: a receive-only folder has local changes for 1 hour.
- `filedeck-sync-unwatched`: a synced folder is on an unwatched mount.
- A watchdog alert for a missing scrape of any node.

Probes (owner rule: the client path, never a shortcut):

- Liveness: an exec probe that runs `filedeck-syncd probe`. It opens a real mTLS connection to the node's peer address through the Service, does the handshake and sends a `ping` frame. A hung listener fails it within three tries. Timeouts are generous. The probe does not depend on the catalogue, so a database outage does not restart pods.
- Readiness: the peer listener is up, the stream is connected and the cursor is current. A new pod becomes ready only after this.
- Rollout: `RollingUpdate`, `maxSurge 1`, `maxUnavailable 0`. A Postgres advisory lock `sync_node_<node>` decides which pod is active. The old pod, on SIGTERM, fails readiness, finishes in-flight chunks, releases the lock and exits when drained. The new pod takes the lock. The grace period is only a kill ceiling.
- The deployment, the Service, the scrape job and the alerts ship in one `.cluster` PR.

### 3.11 Drain folders (MacBook to eu3 and eu4)

Owner decision, 28 Nov 2026. Thomas, quoted: the MacBook "must handle the fix where we auto copy folders over to a different folder on sync as we have a one way sync & drain from the Macbook to EU3/EU4". He wants "a folder where we throw a file into the folder, it uploads, then removes itself from the macbook".

What drain replaces. Today `macbook-downloads` is a two-way Syncthing folder (Mac `~/Downloads` and hq0 `/home/Storage/MacBook-Downloads`). A workaround then moves the files on:

- `syncthing-x-uploader` (`.cluster` `syncthing/templates/x-uploader-configmap.yaml`, an `inotifywait` loop) copies each finished file from the `x` subfolder to eu4 `/home/storage/Videos` with `rsync --remove-source-files` (lines 120 to 121). Values: `syncthing/values.yaml:397-400`. Description: `syncthing/README.md:47-70`.
- The delete on hq0 syncs back to the Mac, so the file leaves the Mac as a side effect. The file crosses two systems and a pod. A failure leaves no clear state.
- The destination folder is fixed in the chart (`Videos`). Drain replaces the uploader, the receiver pod and the two-way folder with one folder type.

Design:

- A `drain` folder has one source node (the MacBook) and one or more targets (eu3, eu4). Transfer is one way. The roles are `drain-source` and `drain-target` (3.6).
- Each target maps the folder to its own destination folder. The map is in the catalogue. Example: Mac `~/Downloads/x` to eu4 `/home/storage/Videos` and to eu3 `/home/storage/Unsorted`. No copy job runs after the sync.
- A file drains only when it is complete. The source must show no open writer in the holder table. A `close_write` (Linux) or FSEvents close event (Mac) must have arrived. If neither signal exists for the path, a size and mtime check runs when an event arrives, and the file drains only if both are unchanged since the last event. No global timer runs.
- Each target pulls the file (3.4 and 3.7). It verifies the BLAKE3 tree hash, calls `fsync` on the file, renames it into place, calls `fsync` on the parent folder, and then confirms to the catalogue. The confirmation row holds the root hash.
- The source removes the file only after every target of the folder has confirmed the same root hash. If the file changed on the Mac meanwhile, the hash differs, the file does not drain, and a new version queues.
- Removal on the Mac is a move to the Mac's FileDeck trash. The copy stays there for 7 days. It is not an instant delete (the rule of 3.6).
- Name clash at a target: keep both. The newer write keeps the name and the other becomes a conflict copy (3.5). An event reports it. The drain counts as done when both versions are safe.
- Target offline: the file stays on the Mac and waits. Queue age is a metric and an alert. No data leaves the Mac without confirmation.
- Disk full at a target (`enospc`): that target stops, the file stays on the Mac and an alert fires. Other targets finish, but the source waits for all of them.
- A target added later receives new files only. Files already removed from the Mac do not drain again.

Metrics added to 3.10:

| Metric | Use |
|---|---|
| `filedeck_sync_drain_queue_files{folder,target}` | Files waiting to drain |
| `filedeck_sync_drain_oldest_seconds{folder,target}` | Age of the oldest waiting file |
| `filedeck_sync_drain_bytes_total{folder,target}` | Bytes drained |
| `filedeck_sync_drain_failures_total{folder,target,class}` | Failures (`offline`, `enospc`, `hash`, `perm`) |

Alerts: `filedeck-sync-drain-stuck` (oldest item over 3600 s for 10 minutes), `filedeck-sync-drain-target-full` (any `enospc`), `filedeck-sync-drain-failures` (failures rising for 30 minutes).

Dependency: the Mac needs the Rust agent for holder and event data and for the trash. That is rust-agent spec phase 3 (join the pool) and its write phase (trash and move). Until then `macbook-downloads` stays on Syncthing with the `x` uploader.

## 4. State in HoardDB

### 4.1 Is it sound?

Yes, with a local cache. HoardDB (CloudNativePG, one engine, PG 17 with TimescaleDB, primary on `hq`, standbys hq0 and eu4, synchronous replication with RPO 0, automatic failback) fits a catalogue.

Reasons it is sound:

- The catalogue is small. At about 200 bytes per row plus indexes, 650 k files is about 130 MB. Even 20 M files is a few GB, which a node-local SQLite file holds today anyway (Syncthing's WAL reached 72 to 270 GB on the 21.7 M-file Projects folder).
- It replaces N copies of the index. Syncthing keeps each peer's index on each node. One catalogue keeps one.
- Compare-and-set in one transaction is a clean base for conflicts (3.5).
- It gives the whole fleet one view: lag, out of sync, conflicts. The web app and the MCP server can read it.
- It follows the owner rule: one Postgres engine, never a private database. A tenant is made with `scripts/db-tenant-add filedeck-sync <namespace> --app-secret-out <path>` from a `.cluster` task (GitOps PR). Clients use `postgres-pooler-rw.databases.svc.cluster.local` (session mode, so `LISTEN` works).

Costs to watch:

- eu3 and eu4 are far from the primary on `hq`. The databases README gives about 224 ms per query across that distance, and synchronous replication adds a commit wait. So all catalogue calls are batched: at most 3 round trips per batch of up to 1000 paths. Sync latency of a second or two is fine for files.
- Write rate. A burst of 1000 new files is one batch and one transaction. Steady state is a few transactions a minute. Target: under 20 writes per second on the engine in a worst-case burst, which row 32.221 proves with a load test.
- A tombstone and revision log needs pruning. It happens when the last node acknowledges (3.3), not on a cron.

### 4.2 What is per node and what is shared

| Shared (HoardDB) | Per node (local SQLite, rebuildable) |
|---|---|
| Folders, roles, ignore rules, node list | Stat cache `(path, inode, size, mtime, hash)` |
| File versions, `rev`, tombstones | Chunk lists and chunk index of local files |
| `applied_rev` per node and folder | Transfer spool and partial files |
| Conflict records, held deletes | Outbox of changes not yet published |
| Cutover manifests (section 7) | Stream cursor |
| Node and certificate registry | Peer connection state |

### 4.3 When the database is unreachable

- Local files stay fully usable. Browsing, sizes and events are unaffected, because sync is a separate Deployment.
- The daemon keeps reading events and writes changes to the local outbox. The cursor still advances only after the outbox write, so a long outage loses nothing, even past the 24-hour journal limit.
- Transfers already planned finish. Their acknowledgements wait in the outbox.
- Nothing new is applied from other nodes. The daemon never deletes or overwrites based on a guess. It applies only what the catalogue states.
- Reconnect uses backoff with jitter and no fixed interval. After a primary switchover, the daemon reconnects, re-runs `LISTEN` and queries from `applied_rev`. Publishing uses compare-and-set, so a retry is safe.
- Alerts: `db_up` is 0 for 5 minutes.
- Outbox growth is bounded: one row per dirty path, coalesced. If the bound is hit, the daemon stops reading the stream and records a `resync` need. The stat check then rebuilds the outbox later.

## 5. Folders that should not be synced

| Folder or content | Treatment |
|---|---|
| `db-backups` | Moved to HoardDB object storage (ADR 0021). Done on 28 Nov 2026 |
| Database data directories, WAL, `pg_wal`, SQLite files with a writer | Never synced. Use the database's own replication or an object backup |
| Plex config tree inside Software (permission and read errors in the chart note) | Exclude from sync. Back it up as one object snapshot |
| Build and cache trees (`node_modules`, `target`, `cargo-target`, `.git/objects`) | Never synced. Same list as `FILEDECK_SIZE_EXCLUDE` |
| Projects (21.7 M files) | Not synced (not in the live config). Code lives in git. Do not bring it back to Syncthing or to FileDeck sync |
| tapo-footage | Write-once, time-limited footage. Better as object storage with a retention rule. Until then a one-way copy (send-only from the writer node) |
| Installed Games, Games Library | Keep syncing, send-receive (owner decision, 28 Nov 2026) |
| Downloads, Thomas' Downloads | Staging. Keep as sync |
| MacBook Downloads, the `x` upload path | Becomes a `drain` folder (3.11). The `x-uploader` and its rsync receiver go away after the cutover |
| Movies, Shows, Videos, Music, Photos | Large and write-once. Keep file sync in version 1. Move to object storage only if sizes show a saving |
| Obsidian, RenPy Saves, Software (hq0, hq1) | Keep as sync. Small and active |

The rule for new folders: sync is for files that people or programs edit on more than one node. A file with a single writer and many readers is a copy job. A file that is only history is an object.

## 6. Efficiency targets per node

Baseline: Syncthing at about 1 core on eu3, 730 m on eu4, and 1.4 to 2 GiB RSS. The seven-day p50 and p95 come from phase 0. The targets are written as ratios so that they stand when the numbers arrive, and as absolute caps.

| Measure | Target |
|---|---|
| Idle CPU (no change in 10 minutes) | Under 10 m, p95 under 30 m |
| One new file in a 650 k-file folder | One event, one `lstat`, one hash of that file. No directory walk. CPU cost under 10 ms plus the hash |
| Burst of 1000 new small files | Under 5 CPU-seconds in total |
| Large file hash | BLAKE3 at least 800 MB/s on one core. Hash budget capped at 2 cores |
| RSS, 14 folders | Under 200 MiB, p95 under 300 MiB, plus bounded page cache |
| SQLite and catalogue writes | None when idle. One transaction per batch |
| Syncthing comparison | At least 90 percent less CPU than the Syncthing p50 and p95 on the same node, and at least 80 percent less memory |
| Directory walks | Zero in normal work. Only the stat check after a lost-event signal and the first baseline |
| Latency from a change to a peer's file (small file, same region) | p95 under 10 s. Cross region under 30 s |
| Read and write on disk while idle | Zero |

Hash CPU is not zero work. Media copies that already exist on both nodes are matched by `(size, mtime)` and the baseline, not rehashed.

## 7. Migration with no data loss

Rule: for each folder exactly one system is active. The other is off or observing. Two writers on one folder never happen.

### 7.1 Phases

1. Phase 0, measure (row 32.219). Fill in sizes, counts, peers and the 7-day CPU and RAM. Fix the folder list with Thomas.
2. Shadow mode (row 32.225). `filedeck-syncd` runs on all four nodes in `observe`. It reads the event stream, builds the catalogue in a separate schema `sync_shadow`, plans what it would send and receive, and writes no file in any synced folder. It reports differences against what Syncthing actually did.
3. Manifests. Each node writes a manifest per folder: path, kind, size, mtime, root hash, sorted. The comparison across nodes uses a directory hash tree, so equal subtrees are skipped in one comparison. Folders that Syncthing says are in sync must give equal manifests. Differences are listed and understood (ignored files, open files, the eu4 read errors) before any cutover.
4. Cutover per folder (row 32.226). The MacBook drain folder comes last, after the Rust Mac agent ships (rows 32.231 to 32.233). Order: Obsidian, RenPy Saves, Music, Photos, Software (hq0 and hq1), Downloads folders, then Games, then Videos, Shows, Movies, Unsorted, Software (eu3 and eu4), tapo-footage last (or removed under section 5).
5. Retirement (row 32.227) only after 30 clean days.

### 7.2 Cutover steps for one folder

1. Check both manifests are equal and the catalogue baseline equals them. Store the manifest in the catalogue as the cutover record.
2. Take Syncthing's folder out of service through a `.cluster` PR, using the same mechanism as the `db-backups` removal (`removeFromNodes` deletes the folder from `config.xml` and touches no file). Data stays on disk.
3. Wait for Syncthing to be quiet (no pending need). The check reads the pod's metrics, not a timer.
4. Switch the folder to `active` in the catalogue. The daemon creates `.filedeck-sync`. The baseline from step 1 is the first revision.
5. Watch the folder for 24 hours with the alerts of section 3.10. Applied deletes go to the trash and never `unlink` for the first 7 days.
6. Run the manifest compare again after 24 hours and 7 days.

### 7.3 Rollback

- Before the 7-day mark: pause the folder in the catalogue, then add the folder back to Syncthing through the same chart mechanism. Syncthing scans, finds identical files (FileDeck sync keeps mtime and size, so it hashes only where they differ), and resumes. Files written by FileDeck sync are plain files. Nothing is converted.
- The Syncthing index is not deleted until retirement. Rollback after the 7-day mark is the same, with a longer rescan.
- A bad cutover is found by an alert or a manifest difference. The cutover record in the catalogue is the evidence of the last good state.
- No step in this RFC deletes a file that exists today. Syncthing's own data (`.stversions`, index files) is left until row 32.227.

## 8. Recommendation and open questions

Recommendation: build the shadow daemon and the catalogue first. Prove them on the small folders. Then cut over folder by folder. The MacBook is in release 1 as a drain folder (3.11). It waits for the Rust Mac agent. Keep Syncthing for the seedbox peer until later.

Why this is worth it: the cost of Syncthing grows with folder size (scans and index work), and the new design grows with the number of changes. Idle nodes should be near zero. The catalogue gives lag, conflicts and drift as plain metrics, which Syncthing does not give us.

Risks:

- A mistake in delete handling is the main data risk. The trash, the mass-delete guard, the marker file and the 7-day soft period answer it.
- The catalogue is a new dependency. The local outbox keeps nodes working when it is down.
- The Rust agent (spec in `.data`) is not yet on Linux or on the Mac. The Linux daemon avoids this by reading the events socket, which the TypeScript agent already serves. The Mac drain cannot avoid it: it needs the Rust agent (3.11).
- Work size. Phases 1 to 4 are a real build. Phase 0 and the shadow run reduce risk before the cutover.

Open questions for Thomas. Each has a recommended answer. Questions 1 to 4 are decided.

Decided on 28 Nov 2026 (Thomas, AskUserQuestion):

1. Conflicts: keep both. The newer write keeps the name. The other version becomes a conflict copy next to it, and an event reports it (3.5). Decided 28 Nov 2026.
2. Deletes: a synced delete moves the file to FileDeck trash for 7 days. A batch over 1000 files or 5 percent of a folder stops and waits for approval (3.6). Decided 28 Nov 2026.
3. Installed Games and Games Library: keep syncing, send-receive (section 5). Decided 28 Nov 2026.
4. The MacBook is in release 1, as a `drain` folder (3.11). It needs the Rust Mac agent first. Decided 28 Nov 2026.

Still open:

5. How do the nodes reach the catalogue: direct Postgres, or through the hub? Recommended: direct from cluster nodes (tenant Secret, session pooler). Add a hub gateway only for the Mac.
6. What does the `comet.seedhost.eu` peer carry, and does it stay? Recommended: leave it on Syncthing, outside this RFC, and decide when phase 0 shows which folders it shares.
7. Syncthing has a stale `archlinux` device on eu3 and eu4. Remove it? Recommended: yes, as part of phase 0, in a separate chart change that Thomas approves.
8. Permissions and owners: sync content, mtime and mode bits only (like the current `ignorePerms`)? Recommended: yes.
9. Should media (Movies, Shows, Videos, tapo-footage) move to object storage later? Recommended: decide after phase 0 sizes. Footage first.
10. Check the eu4 disk for the two unreadable files now. Recommended: yes, before cutover of Videos and Unsorted, because the new engine will not hide it either.
11. Retire Syncthing after 30 clean days and then remove the `syncthing/` chart? Recommended: yes, each in its own PR.
12. Where does the daemon live? Recommended: Rust crate `fd-sync` in the `agent/` workspace, shipped as its own image and Deployment, not inside the agent pod.
13. Which destination folder does each drain target use on eu3 and eu4? Today the workaround writes to eu4 `Videos`. Thomas confirms the map.

## 9. Board rows

Epic 32, "File sync", in `TASKS.md`. One row per phase, in order:

| Row | Phase |
|---|---|
| 32.219 | Phase 0: measure Syncthing and inventory every folder |
| 32.220 | Phase 1: sync daemon with event reader, stat cache and manifest tool (observe mode) |
| 32.221 | Phase 2: catalogue schema in HoardDB and tenant |
| 32.222 | Phase 3: chunking, mTLS transport and resumable transfer |
| 32.223 | Phase 4: conflicts, roles and delete safety |
| 32.224 | Phase 5: metrics, alerts, probes and the `.cluster` chart |
| 32.225 | Phase 6: shadow run and manifest compare on every folder |
| 32.226 | Phase 7: per-folder cutover and a rollback drill |
| 32.227 | Phase 8: retire Syncthing |
| 32.228 | Folders that leave sync (Plex config, caches, footage) |
| 32.229 | Check the eu4 disk read errors |
| 32.231 | Drain folder design and catalogue model (needs the Rust Mac agent, phase 3) |
| 32.232 | Drain engine: durable confirm, trash on source, settle check |
| 32.233 | Drain metrics, alerts and the MacBook cutover that retires the `x` uploader |
