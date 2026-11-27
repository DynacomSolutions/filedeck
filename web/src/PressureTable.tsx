import { Folder } from "lucide-react";
import { consumerOwner, consumerProcess, fmtIops, fmtMBps, fmtPsi, folderHref, totalBps, totalIops, type ConsumerKind, type PressureConsumer } from "./pressure";

const kindLabels: Record<ConsumerKind, string> = { cgroup: "Cgroup", process: "Process", path: "Folder" };

function Dash({ label }: { label: string }) {
  return <><span aria-hidden="true">–</span><span className="visually-hidden">{label}</span></>;
}

function Load({ consumer, max }: { consumer: PressureConsumer; max: number }) {
  const read = Math.min(100, (consumer.rIops / max) * 100);
  const write = Math.min(100 - read, (consumer.wIops / max) * 100);
  return (
    <span className="pressure-bar" aria-hidden="true">
      <span className="pressure-bar-read" style={{ width: `${read}%` }} />
      <span className="pressure-bar-write" style={{ width: `${write}%` }} />
    </span>
  );
}

function Name({ node, consumer }: { node: string; consumer: PressureConsumer }) {
  const owner = consumerOwner(consumer);
  const main = consumer.pod ? owner! : consumer.label;
  const extras = [
    consumer.unit && consumer.unit !== main ? consumer.unit : null,
    consumer.pod?.container ? `container ${consumer.pod.container}` : null,
    consumer.pod && consumer.label !== main && consumer.label !== owner ? consumer.label : null,
  ].filter((value): value is string => value !== null);
  return (
    <>
      {consumer.kind === "path" && consumer.path
        ? <a className="btn-a pressure-path" data-nav href={folderHref(node, consumer.path)} title={`Open ${consumer.path} in the file browser`}><Folder size={14} aria-hidden="true" /><span>{main}</span></a>
        : <span className="pressure-name" title={consumer.cgroup ?? main}>{main}</span>}
      <span className="pressure-sub">
        <span className="pressure-badge">{kindLabels[consumer.kind]}</span>
        {extras.map((extra) => <span key={extra}>{extra}</span>)}
      </span>
    </>
  );
}

/** The ranked consumers of one disk. `consumers` arrive in display order; the caller decides when the order changes. */
export function PressureTable({ node, consumers }: { node: string; consumers: readonly PressureConsumer[] }) {
  const max = Math.max(1, ...consumers.map(totalIops));
  return (
    <div className="pressure-table-wrap" role="region" aria-label="Who is using this disk" tabIndex={0}>
      <table className="pressure-table">
        <caption className="visually-hidden">Consumers of this disk, busiest first. Values update every second. The order changes every two seconds.</caption>
        <thead>
          <tr>
            <th scope="col">Consumer</th>
            <th scope="col">Process</th>
            <th scope="col" className="num">Read</th>
            <th scope="col" className="num">Write</th>
            <th scope="col" className="num">PSI full</th>
            <th scope="col">Load</th>
          </tr>
        </thead>
        <tbody>
          {consumers.map((consumer) => {
            const eventsOnly = consumer.kind === "path" && totalIops(consumer) === 0 && totalBps(consumer) === 0 && (consumer.eventsPerSec ?? 0) > 0;
            const process = consumerProcess(consumer);
            return (
              <tr key={consumer.id}>
                <th scope="row"><Name node={node} consumer={consumer} /></th>
                <td>{process ?? <Dash label="No process" />}</td>
                {eventsOnly
                  ? <td className="num" colSpan={2}>{fmtIops(consumer.eventsPerSec!)} events/s</td>
                  : <>
                    <td className="num"><span>{fmtIops(consumer.rIops)} IOPS</span><span className="pressure-sub">{fmtMBps(consumer.rBps)} MB/s</span></td>
                    <td className="num"><span>{fmtIops(consumer.wIops)} IOPS</span><span className="pressure-sub">{fmtMBps(consumer.wBps)} MB/s</span></td>
                  </>}
                <td className="num">{consumer.psiFull10 !== undefined ? fmtPsi(consumer.psiFull10) : <Dash label="Not known" />}</td>
                <td>{eventsOnly ? null : <Load consumer={consumer} max={max} />}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
