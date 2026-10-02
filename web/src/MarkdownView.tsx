import { useEffect, useMemo, useState } from "react";
import DOMPurify from "dompurify";
import { Marked } from "marked";
import { fileUrl } from "./api";
import * as Ic from "lucide-react";

const MAX = 1024 * 1024;
const md = new Marked({ gfm: true, breaks: false });

/** Folder of a virtual path and a relative reference resolved against it, never above "/". */
export function resolveRef(dir: string, ref: string): string {
  const out: string[] = ref.startsWith("/") ? [] : dir.split("/").filter(Boolean);
  for (const seg of ref.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}

let ctx: { node: string; dir: string } = { node: "", dir: "/" };
let hooked = false;
function hook() {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook("afterSanitizeAttributes", (el) => {
    if (el.tagName === "A") {
      const href = el.getAttribute("href") ?? "";
      if (/^https?:\/\//i.test(href)) {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer nofollow");
      } else {
        // relative links and anchors would navigate the app itself: keep the text, drop the target
        el.removeAttribute("href");
        el.removeAttribute("target");
      }
    }
    if (el.tagName === "IMG") {
      const src = el.getAttribute("src") ?? "";
      if (/^(https?:)?\/\//i.test(src) || /^data:/i.test(src) || src === "") {
        // remote images would leak the reader's address to a third party
        const alt = el.getAttribute("alt") ?? "";
        el.replaceWith(document.createTextNode(alt ? `[image: ${alt}]` : "[image blocked]"));
      } else {
        let rel = src;
        try {
          rel = decodeURI(src);
        } catch {
          /* keep as is */
        }
        el.setAttribute("src", fileUrl(ctx.node, resolveRef(ctx.dir, rel.split(/[?#]/)[0] ?? "")));
        el.setAttribute("loading", "lazy");
      }
    }
  });
}

export function renderMarkdown(src: string, node: string, dir: string): string {
  hook();
  ctx = { node, dir };
  const html = md.parse(src, { async: false }) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "form", "iframe", "object", "embed", "button", "textarea", "select"], FORBID_ATTR: ["style", "srcset"] });
}

/** Markdown rendered with GFM tables, task lists and code blocks; "Source" shows the raw text. */
export function MarkdownView({ node, path }: { node: string; path: string }) {
  const [text, setText] = useState<string | null>(null);
  const [trunc, setTrunc] = useState(false);
  const [raw, setRaw] = useState(false);
  useEffect(() => {
    const ctl = new AbortController();
    setText(null);
    fetch(fileUrl(node, path), { headers: { range: `bytes=0-${MAX - 1}` }, signal: ctl.signal })
      .then(async (r) => {
        const b = await r.arrayBuffer();
        setTrunc(b.byteLength >= MAX);
        setText(new TextDecoder().decode(b));
      })
      .catch(() => setText("(could not load)"));
    return () => ctl.abort();
  }, [node, path]);
  const html = useMemo(() => (text === null ? "" : renderMarkdown(text, node, path.slice(0, path.lastIndexOf("/")) || "/")), [text, node, path]);
  if (text === null) return <div className="pv-empty muted">Loading...</div>;
  return (
    <div className="pv-mdwrap">
      <div className="pv-tabs" role="tablist" aria-label="Markdown view">
        <button role="tab" aria-selected={!raw} className={!raw ? "on" : ""} onClick={() => setRaw(false)}><Ic.Eye /> Rendered</button>
        <button role="tab" aria-selected={raw} className={raw ? "on" : ""} onClick={() => setRaw(true)}><Ic.FileCode /> Source</button>
        {trunc && <span className="muted">first 1 MiB shown</span>}
      </div>
      {raw ? (
        <pre className="pv-text">{text}</pre>
      ) : (
        <article
          className="pv-md"
          onClick={(e) => {
            const a = (e.target as HTMLElement).closest("a");
            if (a && !a.getAttribute("href")) e.preventDefault();
          }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}
