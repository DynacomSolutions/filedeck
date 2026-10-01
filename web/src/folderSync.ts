/**
 * Pure planning for folder-diff sync actions. Nothing here touches the network:
 * the UI shows the plan as a dry run, then executes it step by step.
 */
export type RowStatus = "identical" | "different" | "left-only" | "right-only" | "error";
export interface SideInfo {
  t: "file" | "dir" | "symlink" | "other";
  s: number;
  m: number;
}
export interface PlanRow {
  p: string;
  /** right side's spelling when it differs (ignore-case matches) */
  rp?: string;
  status: RowStatus;
  l?: SideInfo;
  r?: SideInfo;
}
export type SyncAction = "copy-lr" | "copy-rl" | "delete-left" | "delete-right";
export type Side = "left" | "right";

export type Step =
  | { op: "mkdir"; side: Side; rel: string }
  | { op: "copy"; from: Side; srcRel: string; /** folder on the other side that receives the file ("" = its root) */ destDirRel: string; bytes: number; replaces: boolean }
  | { op: "trash"; side: Side; rel: string; why: string }
  | { op: "skip"; rel: string; reason: string };

export interface Plan {
  steps: Step[];
  copies: number;
  bytes: number;
  mkdirs: number;
  trashes: number;
  skipped: number;
  notes: string[];
}

const dirnameRel = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");

export interface PlanOptions {
  /**
   * Trash whole folders for a delete. Only safe when the comparison saw everything inside
   * (no include/exclude/hidden filters, no truncation); otherwise files go one by one.
   */
  wholeDirs: boolean;
}

export function planSync(rows: PlanRow[], selected: ReadonlySet<string>, action: SyncAction, o: PlanOptions): Plan {
  const plan: Plan = { steps: [], copies: 0, bytes: 0, mkdirs: 0, trashes: 0, skipped: 0, notes: [] };
  const byPath = new Map(rows.map((r) => [r.p, r]));
  const picked = rows.filter((r) => selected.has(r.p));
  const skip = (rel: string, reason: string) => {
    plan.steps.push({ op: "skip", rel, reason });
    plan.skipped++;
  };

  if (action === "delete-left" || action === "delete-right") {
    const side: Side = action === "delete-left" ? "left" : "right";
    const has = (r: PlanRow) => (side === "left" ? r.l : r.r);
    const rel = (r: PlanRow) => (side === "right" && r.rp ? r.rp : r.p);
    const gone: string[] = [];
    for (const r of picked) {
      if (!has(r)) continue;
      if (gone.some((d) => r.p.startsWith(d + "/"))) continue;
      const info = has(r) as SideInfo;
      if (info.t === "dir") {
        const below = rows.filter((x) => x.p.startsWith(r.p + "/") && has(x));
        const whole = o.wholeDirs && below.every((x) => selected.has(x.p));
        if (!whole) {
          if (!below.length) {
            plan.steps.push({ op: "trash", side, rel: rel(r), why: "empty folder" });
            plan.trashes++;
          }
          continue; // files inside are handled as their own rows; the folder stays
        }
        gone.push(r.p);
      }
      plan.steps.push({ op: "trash", side, rel: rel(r), why: info.t === "dir" ? "folder and everything inside" : info.t });
      plan.trashes++;
    }
    if (!o.wholeDirs && picked.some((r) => (side === "left" ? r.l : r.r)?.t === "dir")) {
      plan.notes.push("Filters are active, so folders are kept and only the listed files are moved to the trash.");
    }
    return plan;
  }

  const from: Side = action === "copy-lr" ? "left" : "right";
  const to: Side = from === "left" ? "right" : "left";
  const src = (r: PlanRow) => (from === "left" ? r.l : r.r);
  const dst = (r: PlanRow) => (to === "left" ? r.l : r.r);
  const relOf = (r: PlanRow, side: Side) => (side === "right" && r.rp ? r.rp : r.p);
  const made = new Set<string>();
  const base = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1);
  const cat = (dir: string, name: string) => (dir ? dir + "/" + name : name);
  /** Where this row's counterpart lives (or will live) on the destination side, honouring each side's spelling. */
  const destRelFor = (r: PlanRow): string => {
    if (dst(r)) return relOf(r, to);
    const a = byPath.get(dirnameRel(r.p));
    return cat(a ? destRelFor(a) : "", base(relOf(r, from)));
  };

  const ensureParents = (r: PlanRow) => {
    const chain: string[] = [];
    for (let d = dirnameRel(r.p); d; d = dirnameRel(d)) chain.unshift(d);
    for (const d of chain) {
      const a = byPath.get(d);
      if (!a || dst(a) || made.has(d)) continue;
      made.add(d);
      plan.steps.push({ op: "mkdir", side: to, rel: destRelFor(a) });
      plan.mkdirs++;
    }
  };

  for (const r of picked) {
    const s = src(r);
    const d = dst(r);
    if (!s) {
      skip(r.p, `only exists on the ${to} side`);
      continue;
    }
    if (r.status === "identical") continue;
    if (s.t === "symlink" || s.t === "other") {
      skip(r.p, s.t === "symlink" ? "symbolic links are not synced" : "special file");
      continue;
    }
    ensureParents(r);
    const dstRel = destRelFor(r);
    const spellingDiffers = d !== undefined && base(relOf(r, to)) !== base(relOf(r, from));
    if (s.t === "dir") {
      if (d && d.t !== "dir") {
        plan.steps.push({ op: "trash", side: to, rel: dstRel, why: `${d.t} in the way of a folder` });
        plan.trashes++;
      }
      if (!d || d.t !== "dir") {
        made.add(r.p);
        plan.steps.push({ op: "mkdir", side: to, rel: dstRel });
        plan.mkdirs++;
      }
      continue;
    }
    // regular file
    if (d && (d.t === "dir" || spellingDiffers)) {
      plan.steps.push({ op: "trash", side: to, rel: dstRel, why: d.t === "dir" ? "folder in the way of a file" : "name differs only in letter case" });
      plan.trashes++;
    }
    const replaces = d !== undefined && d.t === "file" && !spellingDiffers;
    plan.steps.push({ op: "copy", from, srcRel: relOf(r, from), destDirRel: dirnameRel(dstRel), bytes: s.s, replaces });
    plan.copies++;
    plan.bytes += s.s;
  }
  return plan;
}

export const joinRel = (base: string, rel: string) => (base === "/" ? "" : base.replace(/\/+$/, "")) + "/" + rel;
