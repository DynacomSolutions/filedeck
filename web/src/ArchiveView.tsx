import { useEffect, useState } from "react";
import { api, fmtSize, parent, type ArchiveEntry, type Entry } from "./api";
import { FileIcon } from "./FileIcon";
import { Tip } from "./Tooltip";
import * as Ic from "lucide-react";

/** Browse an archive's contents without extracting it. */
export function ArchiveView({ node, entry }: { node: string; entry: Entry }) {
  const [data, setData] = useState<{ entries: ArchiveEntry[]; truncated: boolean; bytes: number } | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  useEffect(() => {
    setData(null);
    setErr("");
    setMsg("");
    let live = true;
    api
      .archiveList(node, entry.path)
      .then((d) => live && setData(d))
      .catch((e: Error) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [node, entry.path]);
  return (
    <div className="av">
      <div className="av-bar">
        <button
          onClick={() =>
            api
              .startExtract(node, entry.path, parent(entry.path), true)
              .then((j) => setMsg(`Started: ${j.title}`))
              .catch((e: Error) => setMsg(e.message))
          }
        >
          <Ic.PackageOpen /> Extract here
        </button>
        <span className="muted">
          {data ? `${data.entries.length}${data.truncated ? "+" : ""} entries, ${fmtSize(data.bytes)} uncompressed` : err ? "" : "reading archive..."}
        </span>
        {msg && <span className="muted">{msg}</span>}
      </div>
      {err && <div className="fp-err">{err}</div>}
      {data && (
        <table className="ft av-table">
          <thead>
            <tr>
              <th>Name</th>
              <th className="size">Size</th>
            </tr>
          </thead>
          <tbody>
            {data.entries.map((e, i) => (
              <tr key={i}>
                <td className="name">
                  <Tip label={e.link ? `${e.name} -> ${e.link}` : e.name} fill>
                    <span><FileIcon className="ico" type={e.type} />{e.name}</span>
                  </Tip>
                </td>
                <td className="num">{e.type === "file" ? fmtSize(e.size) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data?.truncated && <div className="fp-err">Listing truncated; extract to see everything.</div>}
    </div>
  );
}
