// Pure parsers (no React, no DOM globals beyond DOMParser) for office documents. Output is plain data that the
// viewer renders as text nodes, so nothing from a document is ever injected as HTML.
import { unzipSync, strFromU8 } from "fflate";

export interface Span {
  text: string;
  b?: boolean;
  i?: boolean;
}
export interface Para {
  t: "p";
  /** 1-6 for headings, 0 for body text */
  h: number;
  spans: Span[];
  bullet?: boolean;
}
export interface Table {
  t: "table";
  rows: string[][];
}
export type Block = Para | Table;
export type OfficeDoc =
  | { kind: "doc"; blocks: Block[]; note?: string }
  | { kind: "sheets"; sheets: { name: string; rows: string[][]; truncated: boolean }[] }
  | { kind: "slides"; slides: string[][] };

export const MAX_ZIP = 40 * 1024 * 1024;
export const MAX_ROWS = 1000;
export const MAX_COLS = 60;

const xml = (s: string) => new DOMParser().parseFromString(s, "application/xml");
const kids = (e: Element) => Array.from(e.children);
const desc = (e: Element | Document, local: string): Element[] => Array.from(e.getElementsByTagNameNS("*", local));
const attr = (e: Element | null | undefined, local: string) => (e ? (Array.from(e.attributes).find((a) => a.localName === local)?.value ?? null) : null);
const text = (e: Element | undefined) => (e ? (e.textContent ?? "") : "");

function entry(files: Record<string, Uint8Array>, name: string): string | null {
  const f = files[name];
  return f ? strFromU8(f) : null;
}

function readZip(buf: ArrayBuffer): Record<string, Uint8Array> {
  if (buf.byteLength > MAX_ZIP) throw new Error("file too large to preview");
  // only the XML parts are inflated; media and embeddings are skipped
  return unzipSync(new Uint8Array(buf), { filter: (f) => /\.(xml|rels)$/i.test(f.name) && f.originalSize < 32 * 1024 * 1024 });
}

// ---------- docx ----------
function runSpans(p: Element): Span[] {
  const spans: Span[] = [];
  for (const r of desc(p, "r")) {
    if (r.parentElement?.localName === "del") continue;
    let s = "";
    for (const c of kids(r)) {
      if (c.localName === "t") s += c.textContent ?? "";
      else if (c.localName === "tab") s += "\t";
      else if (c.localName === "br" || c.localName === "cr") s += "\n";
    }
    if (!s) continue;
    const rPr = kids(r).find((c) => c.localName === "rPr");
    const on = (n: string) => {
      const e = rPr && kids(rPr).find((c) => c.localName === n);
      return !!e && !["0", "false", "off"].includes(attr(e, "val") ?? "1");
    };
    spans.push({ text: s, ...(on("b") ? { b: true } : {}), ...(on("i") ? { i: true } : {}) });
  }
  return spans;
}

function docxPara(p: Element): Para {
  const pPr = kids(p).find((c) => c.localName === "pPr");
  const style = attr(pPr && kids(pPr).find((c) => c.localName === "pStyle"), "val") ?? "";
  const m = /^(?:heading|Heading|Titre|berschrift)\s*([1-6])$/.exec(style);
  const h = m ? Number(m[1]) : /^Title$/i.test(style) ? 1 : 0;
  const bullet = !!(pPr && kids(pPr).some((c) => c.localName === "numPr"));
  return { t: "p", h, spans: runSpans(p), ...(bullet ? { bullet: true } : {}) };
}

export function parseDocx(buf: ArrayBuffer): OfficeDoc {
  const files = readZip(buf);
  const src = entry(files, "word/document.xml");
  if (!src) throw new Error("not a Word document");
  const body = desc(xml(src), "body")[0];
  const blocks: Block[] = [];
  for (const el of body ? kids(body) : []) {
    if (el.localName === "p") blocks.push(docxPara(el));
    else if (el.localName === "tbl") {
      const rows = kids(el)
        .filter((r) => r.localName === "tr")
        .map((r) => kids(r).filter((c) => c.localName === "tc").map((c) => kids(c).filter((x) => x.localName === "p").map((x) => runSpans(x).map((s) => s.text).join("")).join("\n")));
      blocks.push({ t: "table", rows });
    }
  }
  const media = Object.keys(unzipSync(new Uint8Array(buf), { filter: (f) => f.name.startsWith("word/media/") })).length;
  return { kind: "doc", blocks, ...(media ? { note: `${media} embedded image(s) are not shown` } : {}) };
}

// ---------- xlsx ----------
function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/[^A-Za-z]/g, "")) n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
  return n - 1;
}

export function parseXlsx(buf: ArrayBuffer): OfficeDoc {
  const files = readZip(buf);
  const wb = entry(files, "xl/workbook.xml");
  if (!wb) throw new Error("not an Excel workbook");
  const rels = new Map<string, string>();
  const relSrc = entry(files, "xl/_rels/workbook.xml.rels");
  if (relSrc) for (const r of desc(xml(relSrc), "Relationship")) rels.set(attr(r, "Id") ?? "", attr(r, "Target") ?? "");
  const shared: string[] = [];
  const ss = entry(files, "xl/sharedStrings.xml");
  if (ss) for (const si of desc(xml(ss), "si")) shared.push(desc(si, "t").map((t) => t.textContent ?? "").join(""));
  const sheets = desc(xml(wb), "sheet").map((sh, n) => {
    const target = rels.get(attr(sh, "id") ?? "") ?? `worksheets/sheet${n + 1}.xml`;
    const path = target.startsWith("/") ? target.slice(1) : "xl/" + target;
    const sx = entry(files, path);
    const rows: string[][] = [];
    let truncated = false;
    if (sx) {
      for (const row of desc(xml(sx), "row")) {
        if (rows.length >= MAX_ROWS) {
          truncated = true;
          break;
        }
        const r = Number(attr(row, "r") ?? rows.length + 1) - 1;
        while (rows.length < r && rows.length < MAX_ROWS) rows.push([]);
        const cells: string[] = [];
        for (const c of kids(row).filter((x) => x.localName === "c")) {
          const ci = colIndex(attr(c, "r") ?? "");
          if (ci >= MAX_COLS) {
            truncated = true;
            continue;
          }
          const t = attr(c, "t");
          const v = text(kids(c).find((x) => x.localName === "v"));
          const val = t === "s" ? (shared[Number(v)] ?? "") : t === "inlineStr" ? desc(c, "t").map((x) => x.textContent ?? "").join("") : t === "b" ? (v === "1" ? "TRUE" : "FALSE") : v;
          while (cells.length < ci) cells.push("");
          cells[ci] = val;
        }
        rows[r] = cells;
      }
    }
    return { name: attr(sh, "name") ?? `Sheet ${n + 1}`, rows, truncated };
  });
  return { kind: "sheets", sheets };
}

// ---------- pptx ----------
export function parsePptx(buf: ArrayBuffer): OfficeDoc {
  const files = readZip(buf);
  const names = Object.keys(files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]));
  if (!names.length) throw new Error("not a PowerPoint presentation");
  return {
    kind: "slides",
    slides: names.map((n) => desc(xml(entry(files, n) as string), "p").map((p) => desc(p, "t").map((t) => t.textContent ?? "").join("")).filter((s) => s.trim())),
  };
}

// ---------- OpenDocument (odt, ods, odp) ----------
function odfText(e: Element): string {
  let s = "";
  for (const n of Array.from(e.childNodes)) {
    if (n.nodeType === 3) s += n.textContent ?? "";
    else if (n.nodeType === 1) {
      const el = n as Element;
      if (el.localName === "s") s += " ".repeat(Number(attr(el, "c") ?? 1));
      else if (el.localName === "tab") s += "\t";
      else if (el.localName === "line-break") s += "\n";
      else s += odfText(el);
    }
  }
  return s;
}

export function parseOdf(buf: ArrayBuffer, ext: string): OfficeDoc {
  const files = readZip(buf);
  const src = entry(files, "content.xml");
  if (!src) throw new Error("not an OpenDocument file");
  const doc = xml(src);
  if (ext === "ods") {
    const sheets = desc(doc, "table")
      .filter((t) => t.parentElement?.localName === "spreadsheet")
      .map((t, n) => {
        const rows: string[][] = [];
        let truncated = false;
        for (const row of kids(t).filter((r) => r.localName === "table-row")) {
          const repeat = Math.min(Number(attr(row, "number-rows-repeated") ?? 1), 5);
          const cells: string[] = [];
          for (const c of kids(row).filter((x) => x.localName === "table-cell" || x.localName === "covered-table-cell")) {
            const rep = Math.min(Number(attr(c, "number-columns-repeated") ?? 1), 10);
            const v = odfText(c).trim();
            for (let k = 0; k < rep && cells.length < MAX_COLS; k++) cells.push(v);
          }
          while (cells.length && cells[cells.length - 1] === "") cells.pop();
          for (let k = 0; k < repeat; k++) {
            if (rows.length >= MAX_ROWS) {
              truncated = true;
              break;
            }
            rows.push(cells);
          }
        }
        while (rows.length && rows[rows.length - 1]!.length === 0) rows.pop();
        return { name: attr(t, "name") ?? `Sheet ${n + 1}`, rows, truncated };
      });
    return { kind: "sheets", sheets };
  }
  if (ext === "odp") {
    return { kind: "slides", slides: desc(doc, "page").map((pg) => desc(pg, "p").map((p) => odfText(p)).filter((s) => s.trim())) };
  }
  const body = desc(doc, "text").find((t) => t.parentElement?.localName === "body");
  const blocks: Block[] = [];
  const walk = (e: Element, bullet: boolean) => {
    for (const c of kids(e)) {
      if (c.localName === "h") blocks.push({ t: "p", h: Math.min(6, Math.max(1, Number(attr(c, "outline-level") ?? 1))), spans: [{ text: odfText(c) }] });
      else if (c.localName === "p") blocks.push({ t: "p", h: 0, spans: [{ text: odfText(c) }], ...(bullet ? { bullet: true } : {}) });
      else if (c.localName === "list" || c.localName === "list-item" || c.localName === "list-header") walk(c, true);
      else if (c.localName === "table") {
        blocks.push({ t: "table", rows: desc(c, "table-row").map((r) => kids(r).filter((x) => x.localName === "table-cell").map((x) => odfText(x))) });
      }
    }
  };
  if (body) walk(body, false);
  return { kind: "doc", blocks };
}

// ---------- csv / tsv ----------
export function parseDelimited(src: string, delim: string): OfficeDoc {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  let truncated = false;
  const pushRow = () => {
    row.push(cur);
    cur = "";
    if (rows.length < MAX_ROWS) rows.push(row.slice(0, MAX_COLS));
    else truncated = true;
    row = [];
  };
  for (let i = 0; i < src.length && !truncated; i++) {
    const ch = src[i]!;
    if (q) {
      if (ch === '"' && src[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) (row.push(cur), (cur = ""));
    else if (ch === "\n") pushRow();
    else if (ch !== "\r") cur += ch;
  }
  if (!truncated && (cur || row.length)) pushRow();
  return { kind: "sheets", sheets: [{ name: "Data", rows, truncated }] };
}

export const OFFICE_EXT = ["docx", "xlsx", "pptx", "odt", "ods", "odp", "csv", "tsv"];
export const LEGACY_OFFICE = ["doc", "xls", "ppt", "rtf"];

export function parseOffice(ext: string, buf: ArrayBuffer): OfficeDoc {
  switch (ext) {
    case "docx":
      return parseDocx(buf);
    case "xlsx":
      return parseXlsx(buf);
    case "pptx":
      return parsePptx(buf);
    case "odt":
    case "ods":
    case "odp":
      return parseOdf(buf, ext);
    case "csv":
      return parseDelimited(new TextDecoder().decode(buf), ",");
    case "tsv":
      return parseDelimited(new TextDecoder().decode(buf), "\t");
  }
  throw new Error("unsupported format");
}

/**
 * Password-protected Office files cannot be rendered here (decrypting them needs the full Office crypto
 * suite). Detect them so the viewer can say so instead of reporting a parse error: encrypted OOXML is an OLE
 * compound file rather than a zip, and encrypted OpenDocument lists `encryption-data` in its manifest.
 */
export function isEncryptedOffice(ext: string, buf: ArrayBuffer): boolean {
  const head = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
  const cfb = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((b, i) => head[i] === b);
  if (["docx", "xlsx", "pptx"].includes(ext)) return cfb;
  if (["odt", "ods", "odp"].includes(ext)) {
    try {
      const files = unzipSync(new Uint8Array(buf), { filter: (f) => f.name === "META-INF/manifest.xml" });
      return (entry(files, "META-INF/manifest.xml") ?? "").includes("encryption-data");
    } catch {
      return false;
    }
  }
  return false;
}
