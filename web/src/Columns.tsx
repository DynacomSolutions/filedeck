import { useRef, useSyncExternalStore } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { fmtDate, fmtMode, fmtSize, type Entry } from "./api";
import type { MenuItem } from "./ContextMenu";
import type { SortKey } from "./urlState";
import {
  COLUMNS, COLUMN_KEY, KEY_STEP, isDefault, isShown, parseColumns, resetColumns, resetWidth, serialiseColumns, setWidth, toggleColumn,
  totalWidth, visibleColumns, widthOf, type ColDef, type ColId, type ColumnState,
} from "./columns";
import "./columns.css";

/** Width of the optional Git column, which is not user-configurable. */
export const GIT_COL_W = 72;

let state: ColumnState | null = null;
const subs = new Set<() => void>();
const load = (): ColumnState => {
  if (!state) {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(COLUMN_KEY);
    } catch { /* storage may be blocked */ }
    state = parseColumns(raw);
  }
  return state;
};
const commit = (next: ColumnState, persist = true) => {
  state = next;
  if (persist) {
    try {
      if (isDefault(next)) localStorage.removeItem(COLUMN_KEY);
      else localStorage.setItem(COLUMN_KEY, serialiseColumns(next));
    } catch { /* storage may be blocked */ }
  }
  subs.forEach((f) => f());
};
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};

/** Shared column state (all panels use one set of columns), persisted in localStorage. */
export function useColumns() {
  const s = useSyncExternalStore(subscribe, load, () => parseColumns(null));
  return { state: s, cols: visibleColumns(s) };
}

export function ColGroup({ state: s, cols, git }: { state: ColumnState; cols: ColDef[]; git: boolean }) {
  return (
    <colgroup>
      {cols.flatMap((c, i) => [
        <col key={c.id} className={"c-" + c.id} style={{ width: widthOf(s, c.id) }} />,
        ...(i === 0 && git ? [<col key="git" className="c-git" style={{ width: GIT_COL_W }} />] : []),
      ])}
      <col className="c-fill" />
    </colgroup>
  );
}

/** Inline style for the table: fixed layout driven by the column widths. */
export const tableStyle = (s: ColumnState, git: boolean): React.CSSProperties => ({ minWidth: totalWidth(s) + (git ? GIT_COL_W : 0) });

/** Number of cells in a full row (visible columns, Git, and the filler). */
export const cellCount = (cols: ColDef[], git: boolean) => cols.length + (git ? 1 : 0) + 1;

export const FillCell = () => <td className="colh-fill" aria-hidden="true" />;

/** Cell for every column except Name (which the panel renders itself). */
export function dataCell(c: ColDef, en: Entry, isDir: boolean) {
  const cls = (c.align ? "num" : "txt") + " c-" + c.id;
  switch (c.id) {
    case "size": return <td key={c.id} className={cls}>{isDir ? "" : fmtSize(en.size)}</td>;
    case "mtime": return <td key={c.id} className={cls}>{fmtDate(en.mtime)}</td>;
    case "type": return <td key={c.id} className={cls}>{typeLabel(en, isDir)}</td>;
    case "mode": return <td key={c.id} className={cls + " mono"}>{fmtMode(en.mode, en.type)}</td>;
    default: return null;
  }
}

export function typeLabel(en: Entry, isDir: boolean): string {
  if (en.type === "symlink") return isDir ? "Folder link" : "Link";
  if (isDir) return "Folder";
  const dot = en.name.lastIndexOf(".");
  return dot > 0 && dot < en.name.length - 1 ? en.name.slice(dot + 1).toUpperCase() + " file" : "File";
}

/** Widest content of one column, measured with canvas text metrics (cheap even for thousands of rows). */
function autoFit(th: HTMLElement, id: ColId): number {
  const table = th.closest("table");
  const ctx = document.createElement("canvas").getContext("2d");
  const idx = [...th.parentElement!.children].indexOf(th);
  if (!table || !ctx || idx < 0) return COLUMNS.find((c) => c.id === id)!.def;
  let best = 0;
  const measure = (el: Element, extra: number) => {
    const cs = getComputedStyle(el);
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    best = Math.max(best, ctx.measureText(el.textContent ?? "").width + pad + extra);
  };
  measure(th, 40);
  for (const tr of table.tBodies[0]?.rows ?? []) {
    if (tr.classList.contains("more") || tr.classList.contains("creating") || tr.classList.contains("up")) continue;
    const td = tr.cells[idx];
    if (td) measure(td, id === "name" ? 34 : 4);
  }
  return Math.ceil(best);
}

function Handle({ col, s, label }: { col: ColDef; s: ColumnState; label: string }) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const w = widthOf(s, col.id);
  const set = (n: number, persist = true) => commit(setWidth(load(), col.id, n), persist);
  return (
    <div
      className="colh-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label} column`}
      aria-valuenow={w}
      aria-valuemin={col.min}
      aria-valuemax={col.max}
      tabIndex={0}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, w: widthOf(load(), col.id) };
      }}
      onPointerMove={(e) => {
        if (drag.current) set(drag.current.w + e.clientX - drag.current.x, false);
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        commit(load());
      }}
      onPointerCancel={() => {
        drag.current = null;
        commit(load());
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        set(autoFit(e.currentTarget.parentElement!, col.id));
      }}
      onKeyDown={(e) => {
        const step = KEY_STEP * (e.shiftKey ? 4 : 1);
        const cur = widthOf(load(), col.id);
        if (e.key === "ArrowRight") set(cur + step);
        else if (e.key === "ArrowLeft") set(cur - step);
        else if (e.key === "Home") set(col.min);
        else if (e.key === "End") set(col.max);
        else if (e.key === "Enter") commit(resetWidth(load(), col.id));
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    />
  );
}

export function columnMenu(): MenuItem[] {
  const s = load();
  return [
    ...COLUMNS.map((c): MenuItem => ({
      label: c.label,
      checked: isShown(s, c.id),
      disabled: c.id === "name",
      onSelect: () => commit(toggleColumn(load(), c.id)),
    })),
    "sep",
    { label: "Reset columns", disabled: isDefault(s), onSelect: () => commit(resetColumns()) },
  ];
}

export function HeaderRow({ s, cols, git, sort, onSort, onMenu }: {
  s: ColumnState;
  cols: ColDef[];
  git: boolean;
  sort: { key: SortKey; asc: boolean };
  onSort: (key: SortKey) => void;
  onMenu: (x: number, y: number, items: MenuItem[]) => void;
}) {
  return (
    <tr
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        // the keyboard context-menu key reports 0,0: anchor to the header cell instead
        const r = (e.target as HTMLElement).getBoundingClientRect();
        onMenu(e.clientX || r.left, e.clientY || r.bottom, columnMenu());
      }}
    >
      {cols.map((c, i) => {
        const on = c.sort && sort.key === c.sort;
        const th = (
          <th
            key={c.id}
            scope="col"
            aria-sort={c.sort ? (on ? (sort.asc ? "ascending" : "descending") : "none") : undefined}
            className={"colh c-" + c.id + (c.sort ? " sortable" : "") + (c.align ? " end" : "")}
          >
            {c.sort ? (
              <button type="button" className="colh-btn" onClick={() => onSort(c.sort!)}>
                {c.label}
                {on ? sort.asc ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" /> : null}
              </button>
            ) : (
              <span className="colh-txt">{c.label}</span>
            )}
            <Handle col={c} s={s} label={c.label} />
          </th>
        );
        return i === 0 && git ? [th, <th key="git" scope="col" className="colh git-th c-git"><span className="colh-txt">Git</span></th>] : th;
      })}
      <th className="colh colh-fill" aria-hidden="true" />
    </tr>
  );
}
