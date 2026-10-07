import { useEffect, useState } from "react";
import { api, parent, type Entry, type NodeInfo } from "./api";
import { Modal } from "./ArchiveDialog";
import type { SelRef } from "./Selection";
import { validTransferDestination } from "./transferPaths";
import * as Ic from "lucide-react";
import { Dropdown } from "./Dropdown";

export type TransferKind = "copy" | "move";

export function TransferDestination({ kind, items, initialNode, initialPath, onChoose, onClose }: {
  kind: TransferKind;
  items: SelRef[];
  initialNode: string;
  initialPath: string;
  onChoose: (node: string, dir: string) => void;
  onClose: () => void;
}) {
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [node, setNode] = useState(initialNode);
  const [dir, setDir] = useState(initialPath);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    api.nodes().then(({ nodes: found }) => {
      if (!live) return;
      setNodes(found);
      if (!found.some((n) => n.name === initialNode && n.online)) {
        const first = found.find((n) => n.online);
        if (first) setNode(first.name);
      }
    }, (e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [initialNode]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api.list(node, dir, false, controller.signal).then(({ entries: found }) => {
      setEntries(found.filter((entry) => entry.type === "dir" || !!entry.linkDir).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })));
      setLoading(false);
    }, (e: Error) => {
      if (controller.signal.aborted) return;
      setEntries([]);
      setError(e.message);
      setLoading(false);
    });
    return () => controller.abort();
  }, [node, dir]);

  const valid = validTransferDestination(items, node, dir);
  const label = kind === "copy" ? "Copy to folder" : "Move to folder";
  return (
    <Modal title={label} onClose={onClose} wide>
      <label>
        Destination node
        <Dropdown autoFocus label="Destination node" value={node} onChange={(v) => { setNode(v); setDir("/"); }} options={nodes.map((n) => ({ value: n.name, label: n.name + (n.online ? "" : " (offline)"), disabled: !n.online }))} />
      </label>
      <div className="transfer-destination-path">
        <span>Destination folder: <strong>{node}:{dir}</strong></span>
        <button type="button" aria-label="Up one destination folder" disabled={dir === "/"} onClick={() => setDir(parent(dir))}><Ic.ArrowUp /> Up</button>
      </div>
      {error && <div className="fp-err" role="alert">{error}</div>}
      {loading ? <p role="status">Loading folders...</p> : (
        <div className="transfer-destination-list" role="group" aria-label="Folders in destination">
          {entries.map((entry) => <button key={entry.path} type="button" onClick={() => setDir(entry.path)}><Ic.Folder /> {entry.name}</button>)}
          {!entries.length && !error && <p className="muted">No subfolders</p>}
        </div>
      )}
      {!valid && <p className="fp-err" role="alert">A folder cannot be copied or moved into itself or a folder inside it.</p>}
      <div className="modal-actions">
        <button type="button" onClick={onClose}><Ic.X /> Cancel</button>
        <button type="button" className={kind === "move" ? "danger" : undefined} disabled={loading || !!error || !valid} onClick={() => { onChoose(node, dir); onClose(); }}>
          {kind === "copy" ? <Ic.Copy /> : <Ic.FolderInput />} {kind === "copy" ? "Copy here" : "Move here"}
        </button>
      </div>
    </Modal>
  );
}
