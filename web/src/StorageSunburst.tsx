import { useEffect, useId, useRef, useState } from "react";
import useSWR from "swr";
import { ArrowLeft, HardDrive } from "lucide-react";
import { BACKGROUND_HEADER, fmtDate, fmtSize } from "./api";
import { useNodes } from "./data";
import { colourBand, ringMaximums, sliceHasPartialIO, sliceLabel, slicePath, sliceValue, storageModes, storageRings, storageSlices, storageView, storageViewUrl, type Slice, type StorageMode, type StorageView } from "./storageSunburst";
import type { GroupsResult, IOPressure, Statistics } from "../../server/src/group-types";
import "./storageSunburst.css";

const labels = { size: "Storage size", read: "Read pressure", write: "Write pressure" } as const;
const colours = {
  size: ["#acdbd2", "#79c6b9", "#4eac9e", "#287d75"],
  read: ["#bbc9fb", "#92a9f0", "#6b86de", "#4f64ae"],
  write: ["#f9cfac", "#f0ae79", "#d98651", "#ad592c"],
};

function format(n: number, mode: StorageMode) {
  if (mode === "size") return fmtSize(n);
  return n < 1024 ? `${Number(n.toFixed(1))} B/s` : `${fmtSize(n)}/s`;
}

function dataState(slice: Slice, mode: StorageMode): string[] {
  const flags = [];
  if (sliceHasPartialIO(slice, mode)) flags.push("Partial IO samples");
  if (slice.group?.unattributed) flags.push("Unattributed");
  if (slice.group?.notStored) flags.push(slice.bytes ? "Some sizes not stored" : "Size not stored");
  if (slice.group?.stale) flags.push("Stale size");
  if (slice.group?.hardLinks === "heavy") flags.push("Many hard links");
  if (slice.group?.errors) flags.push(`${slice.group.errors} scan errors`);
  return flags;
}

function ioMessage(io: GroupsResult["io"]) {
  if (io.status === "disabled") return "IO pressure is off.";
  if (io.status === "unavailable") return "IO pressure is unavailable.";
  if (io.stale) return "Showing the last IO samples. The latest query failed.";
  return null;
}

function useStorageView() {
  const [view, setView] = useState(() => storageView(location.search));
  useEffect(() => {
    const restore = () => setView(storageView(location.search));
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  return [view, (patch: Partial<StorageView>) => {
    const next = { ...storageView(location.search), ...patch };
    history.replaceState(history.state, "", storageViewUrl(location.href, next));
    setView(next);
  }] as const;
}

function NodePicker({ node, choose }: { node: string | null; choose: (node: string | null) => void }) {
  const id = useId();
  const { nodes } = useNodes();
  const choices = new Set((nodes ?? []).filter(({ kind }) => kind !== "source").map(({ name }) => name));
  if (node) choices.add(node);
  return <div className="storage-node-picker">
    <label htmlFor={id}>Node</label>
    <select id={id} value={node ?? ""} onChange={(event) => choose(event.currentTarget.value || null)}>
      <option value="">All nodes</option>
      {[...choices].map((name) => <option key={name} value={name}>{name}</option>)}
    </select>
  </div>;
}

async function fetchStorage(url: string): Promise<GroupsResult> {
  const response = await fetch(url, { headers: BACKGROUND_HEADER });
  if (response.status === 403) throw new Error("Grouped storage requires an administrator account.");
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("This hub could not provide grouped storage data.");
  }
  const value = await response.json() as GroupsResult;
  if (!Array.isArray(value.nodes) || !Array.isArray(value.unavailable) || !value.io) {
    throw new Error("This hub could not provide grouped storage data.");
  }
  return value;
}

function PressureStats({ pressure }: { pressure: IOPressure }) {
  const stats: { name: string; values: Statistics | null; format: (value: number) => string }[] = [
    { name: "Read", values: pressure.read, format: (v) => format(v, "read") },
    { name: "Write", values: pressure.write, format: (v) => format(v, "write") },
    { name: "Utilisation", values: pressure.utilisation, format: (v) => `${Number(v.toFixed(1))}%` },
  ];
  return <dl className="storage-io-stats">{stats.map(({ name, values, format }) =>
    <div key={name}>
      <dt>{name}</dt>
      <dd>{values ? <dl>{(["min", "mean", "max", "resting"] as const).map((key) =>
        <div key={key}><dt>{key}</dt><dd>{format(values[key])}</dd></div>
      )}</dl> : "Unavailable"}</dd>
    </div>
  )}</dl>;
}

function SliceDetails({ selection, slices, mode, choose }: {
  selection: Slice; slices: Slice[]; mode: StorageMode; choose: (id: string) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const jump = (id: string) => {
    choose(id);
    heading.current?.focus();
  };
  const flags = dataState(selection, mode);
  const parent = slices.find((s) => s.id === selection.parent);
  const children = slices.filter((slice) => slice.parent === selection.id);
  return <aside className="storage-detail" aria-label="Selected storage slice">
    <div className="storage-detail-heading">
      <span className="storage-detail-context">{selection.level === "node" ? "Node" : parent?.description}</span>
      <h3 tabIndex={-1} ref={heading}>{selection.label}</h3>
      <p className="storage-detail-bytes">{selection.group?.notStored && !selection.bytes ? "Size not stored" : format(selection.bytes, "size")}</p>
    </div>
    {flags.length > 0 && <ul className="storage-flags">
      {flags.map((flag) => <li key={flag}>{flag}</li>)}
    </ul>}
    {selection.group?.scannedAt != null && <p>Oldest scan <time dateTime={new Date(selection.group.scannedAt).toISOString()}>
      {fmtDate(selection.group.scannedAt)}
    </time></p>}
    {selection.drive && <div className="storage-drive-detail">
      {selection.drive.devices.some(({ model }) => model) && <p>{selection.drive.devices.map(({ model }) => model).filter(Boolean).join(" + ")}</p>}
      <p>Mounted at {selection.drive.mounts.join(", ")}</p>
      <p>{selection.drive.usedBytes !== null && selection.drive.capacityBytes !== null
        ? `${fmtSize(selection.drive.usedBytes)} used of ${fmtSize(selection.drive.capacityBytes)}`
        : "Filesystem capacity unavailable"}</p>
      {selection.drive.overageBytes > 0 && <p className="storage-warning">
        Cached totals exceed filesystem usage by {fmtSize(selection.drive.overageBytes)}.
      </p>}
    </div>}
    {selection.io && <PressureStats pressure={selection.io} />}
    {parent && <button type="button" className="storage-parent" onClick={() => jump(parent.id)}><ArrowLeft size={14} aria-hidden="true" />{parent.label}</button>}
    {children.length > 0 && <ul className="storage-slice-list">
      {children.map((slice) => {
        const value = sliceValue(slice, mode);
        const flags = dataState(slice, mode);
        return <li key={slice.id}><button type="button" onClick={() => jump(slice.id)}>
          <span>{slice.label}{flags.length > 0 && <small>{flags.join(" · ")}</small>}</span>
          <span>{value === null ? "Unavailable" : slice.group?.notStored && !value && mode === "size" ? "Not stored" : format(value, mode)}</span>
        </button></li>;
      })}
    </ul>}
  </aside>;
}

export function StorageSunburst({ node }: { node?: string | null }) {
  const [view, update] = useStorageView();
  const { mode, selected } = view;
  const activeNode = node === undefined ? view.node : node;
  const setSelected = (selected: string) => update({ selected });
  const id = useId();
  const url = activeNode ? `/api/groups?${new URLSearchParams({ node: activeNode })}` : "/api/groups";
  const { data, error, isLoading } = useSWR<GroupsResult, Error>(url, fetchStorage, { refreshInterval: 60_000, shouldRetryOnError: false });
  const { slices, total } = storageSlices(data?.nodes ?? []);
  const marked = slices.filter((slice) => slice.bytes > 0);
  const emptyNodes = slices.filter((slice) => slice.level === "node" && !slice.bytes);
  const focus = slices.find((slice) => slice.id === selected) ?? slices.find((s) => s.level === "drive") ?? slices[0];
  const maximums = ringMaximums(marked, mode);
  const current = data && ioMessage(data.io);

  return <div className="storage-sunburst">
    <div className="storage-controls">
      {node === undefined && <NodePicker node={activeNode} choose={(node) => update({ node, selected: null })} />}
      <div className="storage-toggle" role="group" aria-label="Colour by">
        {storageModes.map((choice) => <button key={choice} type="button" aria-pressed={mode === choice} onClick={() => update({ mode: choice })}>
          {labels[choice]}
        </button>)}
      </div>
      {mode !== "size" && current && <p className="storage-warning" role="status">{current}</p>}
    </div>
    {isLoading && <p className="storage-message" role="status">Loading storage data…</p>}
    {error && <p className="storage-message" role="status">{error.message}</p>}
    {!!data?.unavailable.length && <p className="storage-warning" role="status">Unavailable nodes: {data.unavailable.join(", ")}</p>}
    {data && <div className="storage-layout">
      <div className="storage-plot">
        {marked.length > 0 ? <>
          <svg className="storage-wheel" viewBox="-200 -200 400 400" role="group" aria-labelledby={`${id}-title`} aria-describedby={`${id}-desc`}>
            <title id={`${id}-title`}>Grouped storage sunburst</title>
            <desc id={`${id}-desc`}>Rings show nodes, drives and groups from inside out. Segment length represents allocated bytes. Node throughput is the sum for drives with samples.</desc>
            <defs>
              <pattern id={`${id}-unknown`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="5" height="5" className="storage-unknown-base" />
                <path d="M0 0V5" className="storage-unknown-line" />
              </pattern>
              <pattern id={`${id}-partial`} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <path d="M0 0V7" className="storage-partial-line" />
              </pattern>
              <pattern id={`${id}-stale`} width="6" height="6" patternUnits="userSpaceOnUse">
                <circle cx="3" cy="3" r="1" className="storage-stale-mark" />
              </pattern>
            </defs>
            {marked.map((slice) => {
              const value = sliceValue(slice, mode);
              const band = colourBand(slice, mode, maximums);
              const colour = band === null ? `url(#${id}-unknown)` : colours[mode][band];
              const d = slicePath(slice);
              const label = sliceLabel(slice);
              const flags = dataState(slice, mode);
              const name = `${slice.description}, ${fmtSize(slice.bytes)}${mode !== "size" ? `, ${value === null ? "pressure unavailable" : format(value, mode)}` : ""}${flags.length ? `, ${flags.join(", ")}` : ""}`;
              return <g key={slice.id}>
                <path d={d} fill={colour} className="storage-mark" role="button" tabIndex={0}
                  aria-label={name} aria-pressed={focus?.id === slice.id} onClick={() => setSelected(slice.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelected(slice.id);
                    }
                  }}><title>{name}</title></path>
                {sliceHasPartialIO(slice, mode) && <path d={d} fill={`url(#${id}-partial)`} className="storage-overlay" />}
                {(slice.group?.stale || slice.group?.notStored) && <path d={d} fill={`url(#${id}-stale)`} className="storage-overlay" />}
                {label && <text aria-hidden="true" className="storage-mark-label" x={label.x} y={label.y}
                  transform={`rotate(${label.angle} ${label.x} ${label.y})`}>{label.text}</text>}
              </g>;
            })}
            <text aria-hidden="true" className="storage-centre-value" y="-3">{format(total, "size")}</text>
            <text aria-hidden="true" className="storage-centre-label" y="14">Allocated</text>
          </svg>
          <div className="storage-legend">
            <div><span className="storage-swatches" aria-hidden="true">{colours[mode].map((colour) => <i key={colour} style={{ background: colour }} />)}</span>
              <span>{mode === "size" ? "Size by ring" : "Mean throughput by ring"}</span></div>
            <ul className="storage-ring-scale">
              {(Object.keys(storageRings) as Slice["level"][]).map((ring) => {
                const max = maximums[ring];
                return <li key={ring}><span>{ring}</span> {max === null ? "Unavailable" : `${format(0, mode)} to ${format(max, mode)}`}</li>;
              })}
            </ul>
            <div><i className="storage-swatch-unknown" aria-hidden="true" />{mode === "size" ? "Unattributed" : "Unattributed or no IO samples"}</div>
            {mode !== "size" && marked.some((slice) => sliceHasPartialIO(slice, mode)) &&
              <div><i className="storage-swatch-partial" aria-hidden="true" />Partial IO samples</div>}
            <div><i className="storage-swatch-stale" aria-hidden="true" />Stale or incomplete size</div>
          </div>
        </> : <div className="storage-empty" role="status">
          <HardDrive size={28} aria-hidden="true" />
          <h3>{focus ? "No allocated bytes to chart" : "No storage data"}</h3>
          <p>{focus ? "Select a drive or group to check its stored size." : "No node reported a filesystem for this view."}</p>
        </div>}
      </div>
      {focus && <SliceDetails selection={focus} slices={slices} mode={mode} choose={setSelected} />}
      {emptyNodes.length > 0 && slices.filter((slice) => slice.level === "node").length > 1 && <ul className="storage-slice-list" aria-label="Nodes without allocated bytes">
        {emptyNodes.map((slice) => <li key={slice.id}><button type="button" onClick={() => setSelected(slice.id)}>{slice.label}</button></li>)}
      </ul>}
    </div>}
    {mode === "size" && current && <p className="storage-message" role="status">{current}</p>}
  </div>;
}

export function StoragePage() {
  return <main className="storage-page" id="filedeck-main" tabIndex={-1} aria-labelledby="storage-title">
    <div className="storage-wrap">
      <a href="/" className="btn-a" data-nav><ArrowLeft size={16} aria-hidden="true" /> Files</a>
      <h1 id="storage-title">Storage</h1>
      <StorageSunburst />
    </div>
  </main>;
}
