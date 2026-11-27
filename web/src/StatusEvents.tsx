import { useEffect, useRef, useState } from "react";
import { BACKGROUND_HEADER } from "./api";
import { checkSignedIn } from "./eventStream";
import { StatusTime } from "./StatusJobsPanel";
import { appendChanges, CHANGE_ROW_LIMIT, readChanges, type StatusChange } from "./statusChanges";
import { CHANGE_KINDS, changesUrl, type StatusRoute } from "./statusRoute";

const RECONNECT_MS = 3000;
const STREAM_LEASE_MS = 5 * 60_000;
const SAMPLE_MS = 150;

const kindLabels: Record<string, string> = {
  create: "Create", delete: "Delete", modify: "Modify", close_write: "Close after write", attrib: "Attribute change", move: "Move",
  ready: "Watcher ready", error: "Stream error", reset: "Reset", overflow: "Overflow", offline: "Node offline", lagged: "Stream lagged",
};

function ChangeFeed({ url }: { url: string }) {
  const [paused, setPaused] = useState(false);
  const [rows, setRows] = useState<StatusChange[]>([]);
  const [message, setMessage] = useState("Connecting…");
  const cursor = useRef<string | undefined>(undefined);
  const pending = useRef<StatusChange[]>([]);

  useEffect(() => {
    if (paused) return;
    let stopped = false;
    let current: AbortController | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      const batch = pending.current;
      pending.current = [];
      if (batch.length) setRows((previous) => appendChanges(previous, batch));
    };
    const connect = async () => {
      if (stopped || current || document.hidden) return;
      const controller = new AbortController();
      current = controller;
      setMessage("Connecting…");
      const lease = setTimeout(() => controller.abort(), STREAM_LEASE_MS);
      let reconnect = true;
      let live = false;
      try {
        const href = new URL(url, location.origin);
        if (cursor.current) href.searchParams.set("since", cursor.current);
        const r = await fetch(href, { headers: BACKGROUND_HEADER, signal: controller.signal });
        if (!r.ok || !r.body || !r.headers.get("content-type")?.startsWith("application/x-ndjson")) {
          reconnect = !r.ok && r.status >= 500;
          if (current === controller) {
            const error = await r.json().catch(() => null) as { error?: string } | null;
            if (current === controller) setMessage(error?.error ?? `Change stream unavailable (HTTP ${r.status}).`);
          }
          return;
        }
        if (current !== controller) return;
        setMessage("Live");
        live = true;
        await readChanges(r.body, (event) => {
          if (current !== controller) return;
          if (event.cursor && event.kind !== "lagged") cursor.current = event.cursor;
          if (event.kind === "offline" || event.kind === "error") {
            live = false;
            setMessage(event.kind === "offline" ? "Node offline. Waiting for its stream…" : event.error ?? "The node refused the stream.");
          } else if (!live && event.cursor && event.kind !== "lagged") {
            live = true;
            setMessage("Live");
          }
          if (event.kind === "ping") return;
          if (pending.current.length === CHANGE_ROW_LIMIT) pending.current.shift();
          pending.current.push(event);
        });
        if (current === controller) {
          setMessage("Connection ended. Reconnecting…");
          void checkSignedIn();
        }
      } catch {
        if (current === controller) setMessage("Reconnecting…");
      } finally {
        clearTimeout(lease);
        if (current === controller) {
          current = undefined;
          if (reconnect && !document.hidden) retry = setTimeout(() => void connect(), RECONNECT_MS);
        }
      }
    };
    const disconnect = () => {
      clearTimeout(retry);
      const controller = current;
      current = undefined;
      controller?.abort();
    };
    const visible = () => {
      if (document.hidden) disconnect();
      else void connect();
    };
    document.addEventListener("visibilitychange", visible);
    const sample = setInterval(flush, SAMPLE_MS);
    void connect();
    return () => {
      stopped = true;
      disconnect();
      clearInterval(sample);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [url, paused]);

  return (
    <>
      <div className="status-event-toolbar">
        <p role="status">{paused ? "Paused" : message}</p>
        <button type="button" onClick={() => setPaused(!paused)}>{paused ? "Resume" : "Pause"}</button>
        <button type="button" onClick={() => { pending.current = []; setRows([]); }}>Clear</button>
      </div>
      <p className="status-subtitle">Showing {rows.length} of up to {CHANGE_ROW_LIMIT} recent events</p>
      {rows.length === 0 && <p className="status-message">No events received.</p>}
      <ul className="status-rows status-event-list" aria-label="Recent change events">
        {rows.slice().reverse().map((event, i) => (
          <li className="status-row status-event" key={event.cursor ? event.kind + event.cursor : `${event.kind}:${event.time ?? 0}:${rows.length - i}`}>
            <div><strong>{kindLabels[event.kind] ?? event.kind}</strong>{event.path && <span className="status-subtitle"> · {event.dir ? "Folder" : "File"}</span>}</div>
            {event.time !== undefined && <span className="status-subtitle"><StatusTime at={event.time} /></span>}
            <div className="status-event-path">{event.from && <><code>{event.from}</code> → </>}{event.path && <code>{event.path}</code>}{event.reason ?? event.error}</div>
            {!!event.unwatched?.length && <div className="status-event-path">Unwatched mounts · {event.unwatched.join(", ")}</div>}
          </li>
        ))}
      </ul>
    </>
  );
}

export function StatusEvents({ route, navigate }: { route: StatusRoute; navigate: (route: StatusRoute) => void }) {
  const [draft, setDraft] = useState({ prefix: route.prefix ?? "", glob: route.glob ?? "" });
  const url = route.node ? changesUrl(route.node, route) : null;
  return (
    <section className="status-section" aria-labelledby="status-events-title">
      <div className="status-section-head"><div><h2 id="status-events-title">Live events</h2><p>File and folder changes from one node.</p></div></div>
      {!url ? <p className="status-message">Select a node to open its event stream.</p> : <>
        <form className="status-filters" onSubmit={(e) => {
          e.preventDefault();
          navigate({ ...route, prefix: draft.prefix.trim() || undefined, glob: draft.glob.trim() || undefined });
        }}>
          <label>Path prefix <input type="text" value={draft.prefix} maxLength={4096} placeholder="/work" onChange={(e) => setDraft({ ...draft, prefix: e.target.value })} /></label>
          <label>Glob <input type="text" value={draft.glob} maxLength={4096} placeholder="*.log" onChange={(e) => setDraft({ ...draft, glob: e.target.value })} /></label>
          <label>Kind <select value={route.kind ?? ""} onChange={(e) => navigate({ ...route, kind: CHANGE_KINDS.find((kind) => kind === e.target.value) })}>
            <option value="">All kinds</option>{CHANGE_KINDS.map((kind) => <option key={kind} value={kind}>{kindLabels[kind]}</option>)}
          </select></label>
          <label>Entry type <select value={route.type ?? ""} onChange={(e) => {
            const value = e.target.value;
            navigate({ ...route, type: value === "file" || value === "dir" ? value : undefined });
          }}><option value="">Files and folders</option><option value="file">Files</option><option value="dir">Folders</option></select></label>
          <button type="submit">Apply paths</button>
        </form>
        <ChangeFeed key={url} url={url} />
      </>}
    </section>
  );
}
