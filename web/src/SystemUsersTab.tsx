import { useCallback, useEffect, useId, useRef, useState } from "react";
import * as Ic from "lucide-react";
import { Tip } from "./Tooltip";
import { Dropdown } from "./Dropdown";
import { Modal } from "./ArchiveDialog";
import { ConfirmDialog } from "./SessionsTab";
import { TailnetLinks } from "./TailnetLinks";
import { cleanLinks, linkKind, linksKey } from "./accountForm";
import { AdminError, listAccounts, overview, setSystemSources, setSystemTailnet, systemUserProblem, type Overview, type SourceAccess, type SystemView } from "./admin";
import type { Account } from "./auth";
import "./archive.css";
import "./accounts.css";
import "./sessions.css";

type Choice = "none" | "read" | "write";
const CHOICES: { value: Choice; label: string }[] = [
  { value: "none", label: "No access" },
  { value: "read", label: "Read only" },
  { value: "write", label: "Read and write" },
];
const choiceOf = (a: SourceAccess | undefined): Choice => (a ? (a.write ? "write" : "read") : "none");

/** How the view reaches the sources editor: is it open, does it hold unsaved changes, and leave it (`then`: whatever follows, e.g. closing the view). */
export type SystemCtl = { editing: () => boolean; close: (then?: () => void) => void };

/**
 * System users the hub knows of: named in FILEDECK_ADMINS, given a source, or signed in now. Administrators can add a system user (to
 * give it network sources before it signs in) and change the sources of one. The hub checks every name and answers with its own text.
 */
export function SystemUsersTab({ account, ctl }: { account: Account; ctl?: React.MutableRefObject<SystemCtl | null> }) {
  const uid = useId();
  const [data, setData] = useState<{ system: SystemView[]; overview: Overview } | null>(null);
  const [err, setErr] = useState("");
  const [status, setStatus] = useState("");
  /** the "Add system user" step: asking for the name */
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [nameErr, setNameErr] = useState("");
  /** the editor for one user's sources */
  const [editing, setEditing] = useState<{ name: string; admin: boolean; start: Record<string, Choice>; links: string[] } | null>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const editHeading = useRef<HTMLHeadingElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const alive = useRef(true);
  /** the open editor's own close, which asks first when it holds unsaved changes */
  const editorClose = useRef<((then?: () => void) => void) | null>(null);
  const isEditing = useRef(false);
  isEditing.current = editing !== null;
  useEffect(() => {
    if (!ctl) return;
    ctl.current = { editing: () => isEditing.current, close: (then) => editorClose.current?.(then) };
    return () => {
      ctl.current = null;
    };
  }, [ctl]);

  const load = useCallback(() => {
    Promise.all([listAccounts(), overview()]).then(
      ([l, ov]) => alive.current && (setData({ system: l.system, overview: ov }), setErr("")),
      (e: Error) => alive.current && setErr(e.message),
    );
  }, []);
  useEffect(() => {
    alive.current = true;
    load();
    return () => {
      alive.current = false;
    };
  }, [load]);
  useEffect(() => {
    if (editing) editHeading.current?.focus({ preventScroll: true });
    else if (wasEditing.current) listHeading.current?.focus({ preventScroll: true });
    wasEditing.current = editing !== null;
  }, [editing]);
  useEffect(() => {
    if (adding) nameInput.current?.focus({ preventScroll: true });
  }, [adding]);

  const edit = (u: SystemView) => {
    setStatus("");
    const start: Record<string, Choice> = {};
    for (const [s, a] of Object.entries(u.sources)) start[s] = choiceOf(a);
    setEditing({ name: u.name, admin: u.admin, start, links: u.tailnet.map((l) => l.subject) });
  };

  const closeAdd = () => {
    setAdding(false);
    setNameErr("");
    setName("");
    requestAnimationFrame(() => addButton.current?.focus({ preventScroll: true }));
  };

  const next = () => {
    const problem = systemUserProblem(name);
    if (problem) {
      setNameErr(problem);
      return;
    }
    const n = name.trim();
    const known = data?.system.find((u) => u.name === n);
    setAdding(false);
    setNameErr("");
    setName("");
    if (known) edit(known);
    else setEditing({ name: n, admin: data?.overview.systemAdmins.includes(n) ?? false, start: {}, links: [] });
  };

  if (editing && data) {
    return (
      <SourcesEditor
        key={editing.name}
        account={account}
        user={editing}
        overview={data.overview}
        headingRef={editHeading}
        closeRef={editorClose}
        onCancel={(saved) => {
          setEditing(null);
          // a save that went through in part has changed the list too
          if (saved) load();
        }}
        onSaved={(n) => {
          setEditing(null);
          setStatus(`Sources and Tailscale links of ${n} saved. Its sessions have ended.`);
          load();
        }}
      />
    );
  }

  return (
    <section className="set-sec sess-list sess-view" aria-labelledby={`${uid}-h`}>
      <h2 id={`${uid}-h`} ref={listHeading} tabIndex={-1}>System users</h2>
      <p className="muted">System users are not listed by the hub until they sign in or get a source or a Tailscale link. Users with links are listed too. Add one here to give it network sources or Tailscale links before it signs in. Administrators are named in the hub's settings and cannot be changed here.</p>
      <div className="vault-bar">
        <button type="button" className="primary" ref={addButton} disabled={!data} aria-expanded={adding} onClick={() => (setStatus(""), setAdding(true))}><Ic.UserPlus aria-hidden="true" /> Add system user</button>
        <Tip label="Reload the list"><button type="button" onClick={load}><Ic.RefreshCw aria-hidden="true" /> Refresh</button></Tip>
        <span className="muted vault-count">{data ? `${data.system.length} ${data.system.length === 1 ? "user" : "users"}` : err ? "" : "Loading..."}</span>
      </div>
      {adding && (
        <form
          className="sys-add"
          onSubmit={(e) => (e.preventDefault(), next())}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            closeAdd();
          }}
        >
          <label htmlFor={`${uid}-n`}>System user name</label>
          <input
            id={`${uid}-n`}
            ref={nameInput}
            value={name}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${uid}-e`}
            aria-invalid={nameErr ? true : undefined}
            onChange={(e) => (setName(e.target.value), setNameErr(""))}
          />
          <div className="ad-err" role="alert" id={`${uid}-e`}>{nameErr}</div>
          <div className="sys-row">
            <button type="submit" className="primary"><Ic.ArrowRight aria-hidden="true" /> Continue</button>
            <button type="button" onClick={closeAdd}><Ic.X aria-hidden="true" /> Cancel</button>
          </div>
        </form>
      )}
      <div className="acc-status" role="status">{status}</div>
      {err && <div className="ad-err" role="alert">{err}</div>}
      <div className="vault-wrap" role="region" aria-label="System users table" tabIndex={0}>
        <table className="ft sys-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Administrator</th>
              <th>Sources</th>
              <th>Tailscale</th>
              <th className="sys-c-num">Sessions</th>
              <th className="sys-c-act"><span className="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {data?.system.map((u) => (
              <tr key={u.name}>
                <td className="sys-c-name"><bdi>{u.name}</bdi>{account.kind === "sys" && account.name === u.name && <span className="pill">You</span>}</td>
                <td>{u.admin ? "Yes" : "No"}</td>
                <td className="sys-c-src">
                  {Object.keys(u.sources).length === 0 ? (
                    <span className="muted">None</span>
                  ) : (
                    Object.entries(u.sources).map(([s, a], i) => (
                      <span key={s}>{i > 0 && ", "}<bdi>{s}</bdi> <span className="muted">{a.write ? "read and write" : "read only"}</span></span>
                    ))
                  )}
                </td>
                <td className="sys-c-src">
                  {u.tailnet.length === 0 ? (
                    <span className="muted">None</span>
                  ) : (
                    u.tailnet.map((l, i) => (
                      <span key={l.subject}>{i > 0 && ", "}<bdi>{l.subject}</bdi> <span className="muted">{l.kind === "tag" ? "tag" : "login"}</span></span>
                    ))
                  )}
                </td>
                <td className="sys-c-num">{u.sessions}</td>
                <td className="sys-c-act">
                  <button type="button" aria-label={`Edit sources and Tailscale links of ${u.name}`} onClick={() => edit(u)}><Ic.Pencil aria-hidden="true" /> Edit</button>
                </td>
              </tr>
            ))}
            {data && data.system.length === 0 && (
              <tr><td colSpan={6} className="muted vault-empty">No system users are known yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The sources of one system user: one select per source, saved as a whole. Saving ends the user's sessions, so one's own asks first. */
function SourcesEditor({ account, user, overview: ov, headingRef, closeRef, onCancel, onSaved }: {
  account: Account;
  user: { name: string; admin: boolean; start: Record<string, Choice>; links: string[] };
  overview: Overview;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  closeRef: React.MutableRefObject<((then?: () => void) => void) | null>;
  /** `saved`: a call of a save went through (in part) before the editor closed, so the list is out of date */
  onCancel: (saved: boolean) => void;
  onSaved: (name: string) => void;
}) {
  const [choices, setChoices] = useState<Record<string, Choice>>(user.start);
  const [links, setLinks] = useState<string[]>(user.links);
  /** the text typed in the link field and not added */
  const [pending, setPending] = useState("");
  /** what the hub holds now: moves on when one of the two calls of a save went through and the other did not */
  const [base, setBase] = useState({ sources: user.start, links: user.links });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const sending = useRef(false);
  /** whether any call of a save has gone through: the list reads again when the editor closes */
  const savedAny = useRef(false);
  const errId = useId();
  const [discarding, setDiscarding] = useState(false);
  const afterDiscard = useRef<(() => void) | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const linkField = useRef<HTMLInputElement>(null);
  const self = account.kind === "sys" && account.name === user.name;
  const known = ov.sources.map((s) => s.name);
  const gone = Object.entries(base.sources).filter(([s, c]) => c !== "none" && !known.includes(s)).map(([s]) => s);
  const norm = (c: Record<string, Choice>) => JSON.stringify(Object.entries(c).filter(([, v]) => v !== "none").sort(([a], [b]) => (a < b ? -1 : 1)));
  /** the choices the hub is sent: configured sources only (it refuses the others, and saving ends those grants) */
  const sent: Record<string, Choice> = {};
  for (const s of known) if ((choices[s] ?? "none") !== "none") sent[s] = choices[s]!;
  const linksChanged = linksKey(links) !== linksKey(base.links);
  /** what the person changed: the sources they can see, and the links */
  const sourcesEdited = norm(sent) !== norm(Object.fromEntries(Object.entries(base.sources).filter(([s]) => known.includes(s))));
  /** what the save sends: also a source that is no longer configured, which is dropped by sending the others */
  const sourcesChanged = norm(sent) !== norm(base.sources);
  const pendingLink = pending.trim() !== "";
  const dirty = sourcesChanged || linksChanged || pendingLink;
  const leave = () => onCancel(savedAny.current);
  /** Back to the list, or on to `then`; with unsaved changes it asks "Discard changes?" first. */
  const requestClose = (then?: () => void) => {
    if (sending.current) return;
    const go = then ?? leave;
    if (sourcesEdited || linksChanged || pendingLink) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      afterDiscard.current = go;
      setDiscarding(true);
    } else go();
  };
  closeRef.current = requestClose;
  // the form is inert under a prompt: focus goes back to the control that opened it once the prompt is gone
  useEffect(() => {
    if (discarding || asking) return;
    const el = opener.current;
    opener.current = null;
    if (el?.isConnected && document.activeElement !== el) el.focus({ preventScroll: true });
  }, [discarding, asking]);

  /** The Save button: what can be refused without asking the hub is refused here, before the confirm for one's own account. */
  const clickSave = () => {
    setErr("");
    if (pendingLink) {
      setErr("Add or clear the link you typed before saving.");
      linkField.current?.focus();
      return;
    }
    const bad = cleanLinks(links).find((l) => linkKind(l) === null);
    if (bad !== undefined) return setErr(`This is not a tailnet login or tag: ${bad}`);
    // each call ends the user's sessions: one's own account cannot make a second call after the first
    if (self && sourcesChanged && linksChanged) {
      setErr("Your own sessions end with each change. Save the sources and the Tailscale links one after the other.");
      saveButton.current?.focus();
      return;
    }
    if (self) {
      opener.current = saveButton.current;
      setAsking(true);
    } else void save();
  };

  const save = async () => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setErr("");
    const sources: Record<string, SourceAccess> = {};
    for (const [s, c] of Object.entries(sent)) sources[s] = { write: c === "write" };
    const list = cleanLinks(links);
    // the links first: that call is the likelier to be refused (a taken link, a user no machine has), and nothing is then half saved
    // for the common refusal. One's own account only ever makes one call (`clickSave` refuses both).
    let done = "";
    try {
      if (linksChanged) {
        await setSystemTailnet(user.name, list);
        setBase((b) => ({ ...b, links: list }));
        savedAny.current = true;
        done = "Links saved";
      }
      if (sourcesChanged) {
        try {
          await setSystemSources(user.name, sources);
        } catch (e) {
          // the links went through: say so, or the person would think nothing was saved
          if (done) throw new AdminError(`${done}; sources not saved: ${(e as Error).message}`, 0);
          throw e;
        }
        setBase((b) => ({ ...b, sources: sent }));
        setChoices(sent);
        savedAny.current = true;
      }
      if (self) location.reload();
      else onSaved(user.name);
    } catch (e) {
      setErr((e as Error).message);
      setAsking(false);
      requestAnimationFrame(() => saveButton.current?.focus({ preventScroll: true }));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="sys-editor sess-view">
      <h2 className="acc-title" ref={headingRef} tabIndex={-1}>Sources of <bdi>{user.name}</bdi></h2>
      <fieldset className="acc-fs" disabled={busy} aria-busy={busy || undefined} inert={asking || discarding || undefined}>
        {user.admin && <p className="muted">This user is an administrator and can use every network source, whatever is chosen here.</p>}
        {self && <p className="acc-warn"><Ic.AlertTriangle aria-hidden="true" /> <span>This is your own account. Saving signs it out everywhere, also here.</span></p>}
        {ov.sources.length === 0 ? (
          <p className="muted">No network sources are configured.</p>
        ) : (
          <ul className="acc-sources">
            {ov.sources.map((s) => (
              <li key={s.name}>
                <span className="acc-src-name"><bdi>{s.name}</bdi> <span className="muted">{s.type}</span></span>
                <Dropdown label={`Access to ${s.name}`} value={choices[s.name] ?? "none"} options={CHOICES} disabled={busy} onChange={(v) => setChoices((c) => ({ ...c, [s.name]: v as Choice }))} />
              </li>
            ))}
          </ul>
        )}
        {gone.length > 0 && (
          <p className="muted">Not configured now: {gone.map((s, i) => <span key={s}>{i > 0 && ", "}<bdi>{s}</bdi></span>)}. Saving leaves these grants out, which ends them.</p>
        )}
        <TailnetLinks links={links} mode={ov.tailscale} disabled={busy} start={base.links} pending={pending} onPending={setPending} inputRef={linkField} onChange={setLinks} />
        <div className="acc-actions">
          <div className="ad-err acc-err" role="alert" id={errId}>{err}</div>
          <button type="button" onClick={() => requestClose()}><Ic.X aria-hidden="true" /> Cancel</button>
          <button type="button" className="primary" ref={saveButton} disabled={busy || !dirty} aria-busy={busy || undefined} aria-describedby={errId} onClick={clickSave}>
            <Ic.Check aria-hidden="true" /> {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </fieldset>
      {discarding && (
        <Modal title="Discard changes?" onClose={() => setDiscarding(false)} describedBy={errId + "-d"}>
          <p id={errId + "-d"} className="pad0">The changes to these sources and links have not been saved.</p>
          <div className="modal-actions">
            <button type="button" autoFocus onClick={() => setDiscarding(false)}><Ic.Undo2 aria-hidden="true" /> Keep editing</button>
            <button type="submit" className="danger" onClick={() => (setDiscarding(false), (afterDiscard.current ?? leave)())}><Ic.Trash2 aria-hidden="true" /> Discard</button>
          </div>
        </Modal>
      )}
      {asking && (
        <ConfirmDialog title="Change your own account" confirm="Save and sign out" busy={busy} onClose={() => setAsking(false)} onConfirm={() => void save()}>
          Saving signs this account out everywhere, also here. This page reloads.
        </ConfirmDialog>
      )}
    </div>
  );
}
