import { useId, useRef, useState } from "react";
import * as Ic from "lucide-react";
import type { Overview } from "./admin";
import { cleanLink, cleanLinks, linkKind, MAX_LINKS } from "./accountForm";

export { linkCounts } from "./accountForm";
import "./accounts.css";

export const TAG_RISK = "Anyone who may apply this tag in your tailnet can make a device that signs in as this account.";
export const OFF_NOTE = "Tailscale sign-in is off on this hub. Links are kept and work once it is turned on.";
export const HEADERS_NOTE = "Tag links need the socket source; they do not work on this hub now.";
export const REMOVE_NOTE = "Removing a link ends the sessions that signed in through it when you save.";

/**
 * The "Tailscale" section of an account's editor: the tailnet logins and tags that sign in as it. `links` are the subjects as typed or kept;
 * `onChange` gets the new list. One field takes a login or a tag (Enter or Add); a bad or repeated value shows an inline error and is not
 * added. `start` is the list as saved: while it holds a link `links` no longer has, the section says that saving ends the sessions that
 * came through it. Subjects come from the hub and from the keyboard: React text, in <bdi>.
 */
export function TailnetLinks({ links, onChange, mode, disabled, start }: { links: string[]; onChange: (l: string[]) => void; mode: Overview["tailscale"]; disabled?: boolean; start?: string[] }) {
  const uid = useId();
  const [value, setValue] = useState("");
  const [err, setErr] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const typing = linkKind(value) === "tag";
  const hasTag = links.some((l) => linkKind(l) === "tag");
  const removed = (start ?? []).some((s) => !links.includes(s));

  const add = () => {
    const v = cleanLink(value);
    if (v === "") return setErr("Type a tailnet login or a tag first.");
    if (linkKind(v) === null) return setErr("This is not a tailnet login or tag. Use a login such as alice@github or a tag such as tag:server (letters, digits and dashes).");
    if (links.includes(v)) return setErr("This link is already in the list.");
    if (links.length >= MAX_LINKS) return setErr(`At most ${MAX_LINKS} tailnet links per account.`);
    setErr("");
    setValue("");
    onChange(cleanLinks([...links, v]));
    field.current?.focus({ preventScroll: true });
  };

  return (
    <section className="set-sec acc-tl" aria-labelledby={`${uid}-h`}>
      <h3 id={`${uid}-h`}>Tailscale</h3>
      {mode === null && <p className="muted acc-help">{OFF_NOTE}</p>}
      {mode === "headers" && hasTag && <p className="acc-warn"><Ic.TriangleAlert aria-hidden="true" /> <span>{HEADERS_NOTE}</span></p>}
      {links.length === 0 ? (
        <p className="muted">No tailnet links.</p>
      ) : (
        <ul className="acc-keys" aria-label="Tailnet links">
          {links.map((l) => {
            const tag = linkKind(l) === "tag";
            return (
              <li key={l}>
                <span className="acc-key-text">
                  <span><span className="pill">{tag ? "Tag" : "Login"}</span> <b><bdi>{l}</bdi></b></span>
                  {tag && <span className="muted acc-help">{TAG_RISK}</span>}
                </span>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove ${tag ? "tag" : "login"} ${l}`}
                  onClick={() => {
                    onChange(links.filter((x) => x !== l));
                    field.current?.focus({ preventScroll: true });
                  }}
                >
                  <Ic.Trash2 aria-hidden="true" /> Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {removed && <p className="muted acc-help">{REMOVE_NOTE}</p>}
      <div className="acc-field">
        <label htmlFor={`${uid}-f`}>Tailnet login or tag</label>
        <div className="acc-row acc-tl-row">
          <input
            id={`${uid}-f`}
            ref={field}
            value={value}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            aria-invalid={err ? true : undefined}
            aria-describedby={`${uid}-help ${uid}-err`}
            onChange={(e) => (setValue(e.target.value), setErr(""))}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              add();
            }}
          />
          <button type="button" disabled={disabled} onClick={add}><Ic.Plus aria-hidden="true" /> Add</button>
        </div>
        <span id={`${uid}-help`} className="muted acc-help">For example alice@github or tag:server.</span>
        {typing && <span className="muted acc-help">{TAG_RISK}</span>}
        <div className="ad-err" role="alert" id={`${uid}-err`}>{err}</div>
      </div>
    </section>
  );
}
