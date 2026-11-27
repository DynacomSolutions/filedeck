import { useEffect, useRef, useState } from "react";
import { Activity, ArrowLeft } from "lucide-react";
import type { Account } from "./auth";
import { useNodes } from "./data";
import { PressureSection, PressureSummary, usePressureNodes } from "./DiskPressure";
import { JobsTray } from "./Jobs";
import { StatusJobsPanel } from "./StatusJobsPanel";
import { StatusNodes } from "./StatusNodes";
import { StatusEvents } from "./StatusEvents";
import { StorageSection } from "./StorageSection";
import { statusHistoryAction, statusRoute, statusUrl, type StatusRoute } from "./statusRoute";
import { ThemeMenu } from "./ThemeMenu";
import "./status.css";
import "./pressure.css";

const sections = [
  { id: "jobs", label: "Jobs" },
  { id: "nodes", label: "Node health" },
  { id: "events", label: "Live events" },
  { id: "storage", label: "Storage" },
  { id: "disks", label: "Disk pressure" },
] as const;

export function StatusPage({ initial, account }: { initial: StatusRoute; account?: Account }) {
  const [route, setRoute] = useState(initial);
  const storage = route.storage ?? { mode: "size", selected: null } as const;
  const { nodes, error } = useNodes();
  const devices = nodes?.filter((node) => node.kind !== "source");
  const mayReadHealth = !account || account.admin;
  const selected = devices?.find((node) => node.name === route.node);
  const missing = !!devices && !!route.node && !selected;
  const waitingForNode = !!route.node && devices === undefined;
  const pressure = usePressureNodes(mayReadHealth && (route.section === "jobs" || route.section === "nodes"));
  const pressureEntries = pressure.data?.filter((entry) => !route.node || entry.node === route.node);
  const heading = useRef<HTMLHeadingElement>(null);
  const currentUrl = useRef(location.pathname + location.search);
  const events = useRef(0);
  const [visit, setVisit] = useState(0);

  useEffect(() => {
    const pop = () => {
      const url = location.pathname + location.search;
      if (url === currentUrl.current) return;
      const next = statusRoute(location.pathname, location.search);
      if (!next) return;
      currentUrl.current = url;
      setRoute(next);
      setVisit(++events.current);
      heading.current?.focus({ preventScroll: true });
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  const navigate = (next: StatusRoute) => {
    const url = statusUrl(next, location.search);
    if (url === location.pathname + location.search) return;
    const action = statusHistoryAction(route, next);
    const target = next.section === "storage" ? url + location.hash : url;
    if (action === "push") history.pushState(null, "", target);
    else history.replaceState(history.state, "", target);
    currentUrl.current = url;
    setRoute(next);
  };

  return (
    <main className="status-page" id="filedeck-main" tabIndex={-1} aria-labelledby="status-title">
      <div className="status-wrap">
        <header className="status-header">
          <div className="status-header-bar">
            <a className="btn-a" data-nav href="/"><ArrowLeft size={16} aria-hidden="true" /> Files</a>
            <ThemeMenu />
          </div>
          <div className="status-heading">
            <div className="status-heading-text">
              <Activity size={28} aria-hidden="true" />
              <h1 id="status-title" tabIndex={-1} ref={heading}>Jobs and status</h1>
            </div>
            <label className="status-node-select">Node
              <select aria-label="Node" value={route.node ?? ""} onChange={(e) => navigate({ ...route, node: e.target.value || null, job: undefined, disk: undefined,
                storage: route.storage && { ...route.storage, selected: null } })}>
                <option value="">All nodes</option>
                {route.node && !selected && <option value={route.node}>{route.node}{missing ? " (unavailable)" : ""}</option>}
                {devices?.map((node) => <option value={node.name} key={node.name}>{node.name}{node.online ? "" : " (offline)"}</option>)}
              </select>
            </label>
          </div>
          <nav aria-label="Status sections" className="status-nav">
            {sections.map(({ id, label }) => {
              const next = { ...route, section: id, disk: undefined };
              return <a className="btn-a" data-nav key={id} href={statusUrl(next, location.search)} aria-current={route.section === id ? "page" : undefined} onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
                e.preventDefault();
                navigate(next);
              }}>{label}</a>;
            })}
          </nav>
        </header>
        {error && <p className="status-message" role="status">The node list is unavailable.</p>}
        {missing && <p className="status-message" role="status">This node is unavailable to your account.</p>}
        {waitingForNode && !error && <p className="status-message" role="status">Loading node…</p>}
        {!missing && !waitingForNode && <>
          {route.section === "jobs" && !!pressureEntries?.length && <PressureSummary entries={pressureEntries} route={route} navigate={navigate} />}
          {route.section === "jobs" && (nodes ? (
            <JobsTray nodes={nodes} statusOp={route.job?.startsWith("op:") ? route.job.slice(3) : undefined}
              renderStatus={(snapshot) => <StatusJobsPanel snapshot={snapshot} route={route} navigate={navigate} />} />
          ) : !error && <p role="status">Loading jobs…</p>)}
          {route.section === "nodes" && (mayReadHealth ? <StatusNodes node={route.node} route={route} navigate={navigate} {...(pressureEntries ? { pressure: pressureEntries } : {})} /> : <p className="status-message">Node health requires an administrator account.</p>)}
          {route.section === "events" && (mayReadHealth ? <StatusEvents key={`${route.node}:${visit}`} route={route} navigate={navigate} /> : <p className="status-message">Live events require an administrator account.</p>)}
          {route.section === "disks" && (mayReadHealth ? <PressureSection route={route} navigate={navigate} {...(nodes ? { nodes } : {})} /> : <p className="status-message">Disk pressure requires an administrator account.</p>)}
          {route.section === "storage" && <StorageSection
            view={{ ...storage, node: route.node }}
            update={(patch) => navigate({
              ...route,
              storage: { ...storage, ...patch },
            })}
          />}
        </>}
      </div>
    </main>
  );
}
