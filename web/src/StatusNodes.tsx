import useSWR from "swr";
import type { HubNodeStatus, NodeStatus } from "../../server/src/node-status-types.ts";
import { BACKGROUND_HEADER } from "./api";
import { JOBS_IDLE_POLL_MS } from "./jobPoll";
import { StatusTime } from "./StatusJobsPanel";

async function getStatus(url: string): Promise<{ nodes: HubNodeStatus[] }> {
  const response = await fetch(url, { headers: BACKGROUND_HEADER, signal: AbortSignal.timeout(JOBS_IDLE_POLL_MS) });
  if (!response.ok) throw new Error(`Node status is unavailable (HTTP ${response.status}).`);
  return response.json();
}

const rootState = { missing: "Not stored yet", partial: "Partial scan", stale: "Stale", current: "Current", unknown: "Unavailable" };

function NodeFacts({ status }: { status: NodeStatus }) {
  const { watcher, journal, roots, sizeStore } = status;
  const scanned = roots.filter((root) => root.scannedAt !== null);
  const full = roots.filter((root) => root.fullScan).length;
  const lastScan = Math.max(0, ...scanned.map((root) => root.scannedAt ?? 0));
  const watched = watcher.coverage.filter((mount) => mount.state === "watched");
  const unwatched = [...new Set([...watcher.unwatchedPaths, ...watcher.coverage.filter((mount) => mount.state === "unwatched").map((mount) => mount.path)])];
  const uncertain = watcher.coverage.filter((mount) => mount.state === "unknown");
  return (
    <div className="status-node-grid">
      <section className="status-card">
        <h4>Size scans</h4>
        <dl className="status-facts">
          <div><dt>First full scan</dt><dd>{full === roots.length ? "Complete for all listed roots" : `${full} of ${roots.length} roots fully scanned`}</dd></div>
          <div><dt>Latest scan or refresh</dt><dd><StatusTime at={lastScan || null} /></dd></div>
          <div><dt>Size store</dt><dd>{sizeStore.damaged ? "Damaged" : sizeStore.available ? "Available" : "Unavailable"}</dd></div>
        </dl>
        <ul className="status-paths" aria-label="Scan roots">
          {roots.map((root) => <li key={root.path}><code>{root.path}</code><div>{rootState[root.state]}{root.scannedAt !== null && <> · <StatusTime at={root.scannedAt} /></>}</div></li>)}
        </ul>
      </section>
      <section className="status-card">
        <h4>Watcher</h4>
        <dl className="status-facts">
          <div><dt>{watcher.kind === "fanotify" ? "Fanotify" : "Native watcher"}</dt><dd>{watcher.running ? watcher.ready ? "On" : "Starting or degraded" : "Off"}</dd></div>
          <div><dt>Covered mounts</dt><dd>{watcher.running ? watcher.watched : 0} of {Math.max(watcher.mounts, watcher.coverage.length)}</dd></div>
          <div><dt>Unwatched mounts</dt><dd>{Math.max(watcher.unwatched, unwatched.length)}</dd></div>
          <div><dt>Excluded mounts</dt><dd>{watcher.excluded}</dd></div>
          <div><dt>Pending reconciliation</dt><dd>{watcher.backlog.toLocaleString()}</dd></div>
          <div><dt>Overflows</dt><dd>{journal.overflows.toLocaleString()}</dd></div>
          <div><dt>Lost events</dt><dd>{watcher.lostEvents.toLocaleString()}</dd></div>
          <div><dt>Unresolved events</dt><dd>{watcher.unresolved?.toLocaleString() ?? "Unavailable"}</dd></div>
        </dl>
        {watched.length > 0 && <p>Covered · {watched.map((mount) => mount.path).join(", ")}</p>}
        {unwatched.length > 0 && <p>Unwatched · {unwatched.join(", ")}</p>}
        {uncertain.length > 0 && <p>Coverage unknown · {uncertain.map((mount) => mount.path).join(", ")}</p>}
      </section>
      <section className="status-card">
        <h4>Event journal</h4>
        <dl className="status-facts">
          <div><dt>Stream</dt><dd>{journal.serving ? "Available" : "Unavailable"}</dd></div>
          <div><dt>Epoch</dt><dd><code>{journal.epoch ?? "Unavailable"}</code></dd></div>
          <div><dt>Oldest cursor</dt><dd><code>{journal.oldestCursor ?? "Unavailable"}</code></dd></div>
          <div><dt>Newest cursor</dt><dd><code>{journal.newestCursor ?? "Unavailable"}</code></dd></div>
          <div><dt>Subscribers</dt><dd>{Object.values(journal.subscribers).reduce((total, n) => total + n, 0)}</dd></div>
          <div><dt>Delivery lag</dt><dd>{journal.lagMs} ms</dd></div>
          <div><dt>Dropped readers</dt><dd>{journal.dropped}</dd></div>
        </dl>
      </section>
    </div>
  );
}

export function StatusNodes({ node }: { node: string | null }) {
  const url = "/api/status" + (node ? "?" + new URLSearchParams({ node }) : "");
  const { data, error, isLoading } = useSWR(url, getStatus, {
    refreshInterval: JOBS_IDLE_POLL_MS, revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false,
  });
  return (
    <section className="status-section" aria-labelledby="status-nodes-title">
      <div className="status-section-head"><div><h2 id="status-nodes-title">Node health</h2><p>Scan coverage, watcher activity and journal health.</p></div></div>
      {isLoading && <p role="status">Loading node health…</p>}
      {error && <p role="status" className="status-message">{error.message}{data && " Showing the last available data."}</p>}
      {data?.nodes.length === 0 && <p className="status-message">No accessible nodes.</p>}
      {data?.nodes.map((entry) => (
        <section className="status-node" key={entry.node}>
          <div className="status-node-head">
            <h3>{entry.node}</h3>
            {entry.state === "available" && <span className="status-subtitle">Updated <StatusTime at={entry.status.sampledAt} /></span>}
          </div>
          {entry.state === "available" ? <NodeFacts status={entry.status} /> : <p className="status-message">{entry.state === "unsupported" ? "This agent does not provide node health yet." : "Node health is unavailable."}</p>}
        </section>
      ))}
    </section>
  );
}
