import { useEffect, useId, useRef, useState, type MutableRefObject } from "react";
import * as Ic from "lucide-react";
import { Modal } from "./ArchiveDialog";
import { Dropdown } from "./Dropdown";
import { GrantPicker } from "./GrantPicker";
import { TailnetLinks } from "./TailnetLinks";
import { addKey, createAccount, removeKey, updateAccount, type AccountView, type Overview } from "./admin";
import { anyLinkCounts, formChanged, formProblems, fromView, MAX_PASSWORD, MIN_PASSWORD, notConfigured, toInput, type AccountForm, type Configured, type SourceChoice } from "./accountForm";
import "./archive.css";
import "./accounts.css";

const SOURCE_CHOICES: { value: SourceChoice; label: string }[] = [
  { value: "none", label: "No access" },
  { value: "read", label: "Read only" },
  { value: "write", label: "Read and write" },
];

const PENDING_LINK = "Add or clear the link you typed before saving.";
const SELF_WARNING = "Saving signs this account out everywhere, also here.";

/** The empty form for a new account, with one section per machine. */
function blank(ov: Overview): AccountForm {
  return { name: "", password: "", admin: false, machines: ov.nodes.map((node) => ({ node, runAs: "", grants: [] })), sources: {}, tailnet: [] };
}

/** The form of an existing account, with a section for every machine: the configured ones first, then any the account still names. */
function loaded(v: AccountView, ov: Overview): AccountForm {
  const f = fromView(v);
  const have = new Map(f.machines.map((m) => [m.node, m]));
  const machines = ov.nodes.map((node) => have.get(node) ?? { node, runAs: "", grants: [] });
  for (const m of f.machines) if (!ov.nodes.includes(m.node)) machines.push(m);
  return { ...f, machines };
}

/** A themed checkbox (the `label.ck` pattern of the jobs tray): the native input stays underneath for keyboard and screen readers. */
function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="ck acc-ck">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="ck-box" aria-hidden="true"><Ic.Check /></span>
      <span>{children}</span>
    </label>
  );
}

/**
 * Creates a virtual account (`existing` undefined) or edits one. Every change to an account ends its sessions and jobs on the hub, so
 * changing one's own account (`self`) first asks, and reloads the page once it is done. A save can take some seconds when a machine is
 * slow to answer: the button shows it, the form is disabled and cannot be sent twice (`onBusy` tells the view). The hub's refusal shows
 * in the alert next to Save. `closeRef` is how the view asks to close (Escape): with unsaved changes it asks "Discard changes?" first.
 */
export function AccountEditor({
  existing,
  overview,
  self,
  onSaved,
  onClose,
  onBusy,
  closeRef,
  dirtyRef,
}: {
  existing?: AccountView;
  overview: Overview;
  self: boolean;
  onSaved: (v: AccountView, created: boolean) => void;
  onClose: () => void;
  onBusy?: (busy: boolean) => void;
  /** the view's way to close the editor (or, given `then`, to leave the whole view): asks first when there are unsaved changes */
  closeRef?: MutableRefObject<((then?: () => void) => void) | null>;
  /** whether there are unsaved changes now */
  dirtyRef?: MutableRefObject<(() => boolean) | null>;
}) {
  const [start] = useState<AccountForm>(() => (existing ? loaded(existing, overview) : blank(overview)));
  const [form, setForm] = useState<AccountForm>(start);
  const [keys, setKeys] = useState(existing?.keys ?? []);
  const [hasPassword, setHasPassword] = useState(existing?.hasPassword ?? false);
  const [removePassword, setRemovePassword] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [err, setErr] = useState<string[]>([]);
  const [keyErr, setKeyErr] = useState("");
  /** the text typed in the link field and not added */
  const [pendingLink, setPendingLink] = useState("");
  const linkField = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"" | "save" | "key">("");
  /** the change that waits for "Saving signs this account out everywhere" to be confirmed */
  const [asking, setAsking] = useState<null | (() => Promise<void>)>(null);
  const [discarding, setDiscarding] = useState(false);
  /** what "Discard" does: back to the list, or (when the view is being closed) whatever the view asked for */
  const afterDiscard = useRef<(() => void) | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const sending = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const ids = { name: useId(), password: useId(), pwHelp: useId(), key: useId(), keyHelp: useId(), err: useId(), self: useId() };
  const known: Configured = { nodes: overview.nodes, sources: overview.sources.map((s) => s.name) };
  const gone = notConfigured(form, known);

  useEffect(() => heading.current?.focus({ preventScroll: true }), []);

  /**
   * The control that opened one of the editor's dialogs (the folder picker, a confirmation). The form is inert while a dialog is
   * open, so focus can only go back once that is lifted: the effect below runs after the commit that removes `inert`, whatever
   * order the dialog's own focus return took.
   */
  const opener = useRef<HTMLElement | null>(null);
  const noteOpener = () => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };
  const dialogOpen = picking !== null || asking !== null || discarding;
  useEffect(() => {
    if (dialogOpen) return;
    const el = opener.current;
    opener.current = null;
    if (el?.isConnected && document.activeElement !== el) el.focus({ preventScroll: true });
  }, [dialogOpen]);

  const set = (patch: Partial<AccountForm>) => setForm((f) => ({ ...f, ...patch }));
  const setMachine = (node: string, change: (m: AccountForm["machines"][number]) => AccountForm["machines"][number]) =>
    setForm((f) => ({ ...f, machines: f.machines.map((m) => (m.node === node ? change(m) : m)) }));

  /** Back to the list; with unsaved changes (the form differs, a password typed, "Remove password" set) it asks first. */
  const changed = () => removePassword || pendingLink.trim() !== "" || formChanged(start, form);
  const requestClose = (then?: () => void) => {
    if (sending.current) return;
    const go = then ?? onClose;
    if (changed()) {
      noteOpener();
      afterDiscard.current = go;
      setDiscarding(true);
    }
    else go();
  };
  if (closeRef) closeRef.current = requestClose;
  if (dirtyRef) dirtyRef.current = changed;

  /** Runs one call to the hub at a time; `self` changes ask first and reload the page after. */
  const run = async (what: "save" | "key", call: () => Promise<boolean>) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(what);
    onBusy?.(true);
    try {
      // the change has signed this page out: a fresh load shows the sign-in screen
      if ((await call()) && self) location.reload();
    } finally {
      sending.current = false;
      setBusy("");
      onBusy?.(false);
    }
  };
  const guarded = (what: "save" | "key", call: () => Promise<boolean>) => {
    if (sending.current) return;
    if (self) {
      noteOpener();
      setAsking(() => () => run(what, call));
    }
    else void run(what, call);
  };

  const save = () => {
    if (pendingLink.trim() !== "") {
      setErr([PENDING_LINK]);
      linkField.current?.focus();
      return;
    }
    const problems = formProblems(removePassword ? { ...form, password: "" } : form);
    if (problems.length) return setErr(problems);
    setErr([]);
    const input = toInput(form, known);
    guarded("save", async () => {
      try {
        let v: AccountView;
        if (existing) {
          const { name: _name, password, ...rest } = input;
          v = await updateAccount(existing.name, { ...rest, ...(removePassword ? { password: null } : password !== undefined ? { password } : {}) });
        } else {
          v = await createAccount(input);
        }
        // a password is never kept once the hub has it
        setForm((f) => ({ ...f, password: "" }));
        setRemovePassword(false);
        setHasPassword(v.hasPassword);
        if (!self) onSaved(v, !existing);
        return true;
      } catch (e) {
        setErr([(e as Error).message]);
        return false;
      }
    });
  };

  const changeKey = (call: () => Promise<AccountView>) =>
    guarded("key", async () => {
      setKeyErr("");
      try {
        const v = await call();
        setKeys(v.keys);
        setNewKey("");
        return true;
      } catch (e) {
        setKeyErr((e as Error).message);
        return false;
      }
    });

  const canSignIn = (hasPassword && !removePassword) || form.password !== "" || keys.length > 0 || anyLinkCounts(form.tailnet, overview.tailscale);
  return (
    // not a <form>: the folder picker and the confirmations are forms of their own (Modal)
    <div className="acc-editor" role="group" aria-labelledby={ids.name + "-h"}>
      <h2 id={ids.name + "-h"} className="acc-title" ref={heading} tabIndex={-1}>
        {existing ? <>Edit <bdi>{existing.name}</bdi></> : "New account"}
      </h2>
      {self && <p className="acc-warn" id={ids.self}><Ic.TriangleAlert aria-hidden="true" /> This is your own account. {SELF_WARNING}</p>}

      {/* disabled as a whole while a change is with the hub, Dropdowns and buttons included; inert under its own dialogs */}
      <fieldset className="acc-fs" disabled={busy !== ""} aria-busy={busy !== "" || undefined} inert={dialogOpen || undefined}>
        <section className="set-sec" aria-labelledby={ids.name + "-s"}>
          <h3 id={ids.name + "-s"}>Sign-in</h3>
          {!existing && (
            <div className="acc-field">
              <label htmlFor={ids.name}>Name</label>
              <input id={ids.name} value={form.name} autoComplete="off" spellCheck={false} autoCapitalize="none" required onChange={(e) => set({ name: e.target.value })} />
            </div>
          )}
          <div className="acc-field">
            <label htmlFor={ids.password}>{existing ? "New password" : "Password"}</label>
            <input
              id={ids.password}
              type="password"
              autoComplete="new-password"
              value={form.password}
              disabled={removePassword}
              aria-describedby={ids.pwHelp}
              onChange={(e) => set({ password: e.target.value })}
            />
            <span id={ids.pwHelp} className="muted acc-help">
              {removePassword
                ? "The password is removed when you save."
                : `${MIN_PASSWORD} to ${MAX_PASSWORD} characters. ${existing ? (hasPassword ? "Leave empty to keep the current password." : "This account has no password now.") : "Leave empty for an account that signs in with a key only."}`}
            </span>
            {existing && hasPassword && (
              <div className="acc-row">
                {removePassword ? (
                  <button type="button" onClick={() => setRemovePassword(false)}><Ic.Undo2 aria-hidden="true" /> Keep password</button>
                ) : (
                  <button type="button" onClick={() => (setRemovePassword(true), set({ password: "" }))}><Ic.KeyRound aria-hidden="true" /> Remove password</button>
                )}
              </div>
            )}
          </div>
          <Check checked={form.admin} onChange={(admin) => set({ admin })}>
            Administrator <span className="muted">Can manage accounts and use every network source.</span>
          </Check>
          {!canSignIn && <p className="muted acc-help">Without a password, a key or a tailnet link that works now, this account cannot sign in.</p>}
        </section>

        <section className="set-sec" aria-labelledby={ids.key + "-s"}>
          <h3 id={ids.key + "-s"}>Keys</h3>
          {!existing ? (
            <p className="muted">Add SSH keys once the account is created: its editor opens again then.</p>
          ) : (
            <>
              {keys.length === 0 ? (
                <p className="muted">No keys.</p>
              ) : (
                <ul className="acc-keys">
                  {keys.map((k) => (
                    <li key={k.fingerprint}>
                      <span className="acc-key-text">
                        <b><bdi>{k.comment ?? k.type}</bdi></b>
                        <span className="muted acc-fp"><bdi>{k.fingerprint}</bdi></span>
                      </span>
                      <button type="button" aria-label={`Remove key ${k.comment ?? k.fingerprint}`} onClick={() => changeKey(() => removeKey(existing.name, k.fingerprint))}>
                        <Ic.Trash2 aria-hidden="true" /> Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="acc-field">
                <label htmlFor={ids.key}>Public key</label>
                <textarea id={ids.key} rows={2} spellCheck={false} placeholder="ssh-ed25519 AAAA... comment" aria-describedby={ids.keyHelp} value={newKey} onChange={(e) => setNewKey(e.target.value)} />
                <span id={ids.keyHelp} className="muted acc-help">
                  One line from a .pub file: ssh-ed25519 or ecdsa-sha2-nistp256. Key changes apply at once and end this account&apos;s sessions.
                </span>
              </div>
              <div className="acc-row">
                <button type="button" disabled={newKey.trim() === ""} aria-busy={busy === "key" || undefined} onClick={() => changeKey(() => addKey(existing.name, newKey.trim()))}>
                  <Ic.KeyRound aria-hidden="true" /> {busy === "key" ? "Saving…" : "Add key"}
                </button>
                <div className="ad-err" role="alert">{keyErr}</div>
              </div>
            </>
          )}
        </section>

        <TailnetLinks links={form.tailnet} mode={overview.tailscale} disabled={busy !== ""} start={start.tailnet} pending={pendingLink} onPending={setPendingLink} inputRef={linkField} onChange={(tailnet) => set({ tailnet })} />

        <section className="set-sec" aria-labelledby={ids.name + "-m"}>
          <h3 id={ids.name + "-m"}>Machines</h3>
          <p className="muted">On each machine the account acts as a system user and sees only the folders given here. The first folder is the one Filedeck opens.</p>
          {form.machines.length === 0 && <p className="muted">No machines are configured.</p>}
          {form.machines.map((m) => {
            const isGone = gone.machines.includes(m.node);
            return (
              <fieldset key={m.node} className="acc-machine">
                <legend><Ic.Server aria-hidden="true" /> <bdi>{m.node}</bdi>{!known.nodes.includes(m.node) && <span className="muted"> (not configured now)</span>}</legend>
                {isGone && <p className="muted acc-help">This machine is not configured now. Saving leaves it out, which ends this access.</p>}
                <div className="acc-field">
                  <label htmlFor={`${ids.name}-run-${m.node}`}>Run as (system user)</label>
                  <input id={`${ids.name}-run-${m.node}`} value={m.runAs} autoComplete="off" spellCheck={false} autoCapitalize="none" onChange={(e) => setMachine(m.node, (x) => ({ ...x, runAs: e.target.value }))} />
                </div>
                {m.grants.length > 0 && (
                  <ul className="acc-grants" aria-label={`Folders on ${m.node}`}>
                    {m.grants.map((g, i) => (
                      <li key={g.path}>
                        <span className="acc-grant-path">
                          <Ic.Folder aria-hidden="true" /> <bdi>{g.path}</bdi>
                          {i === 0 && <span className="pill">Opens first</span>}
                        </span>
                        <Check checked={g.write} onChange={(write) => setMachine(m.node, (x) => ({ ...x, grants: x.grants.map((y) => (y.path === g.path ? { ...y, write } : y)) }))}>
                          Can change
                        </Check>
                        <button type="button" aria-label={`Remove folder ${g.path} on ${m.node}`} onClick={() => setMachine(m.node, (x) => ({ ...x, grants: x.grants.filter((y) => y.path !== g.path) }))}>
                          <Ic.X aria-hidden="true" /> Remove
                        </button>
                        {g.path === "/" && (
                          <span className="muted acc-help acc-whole">
                            This gives the whole machine. Only the permissions of {m.runAs.trim() ? <bdi>{m.runAs.trim()}</bdi> : "the run-as user"} limit it.
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {!isGone && (
                  <div className="acc-row">
                    <button type="button" onClick={() => (noteOpener(), setPicking(m.node))}><Ic.FolderPlus aria-hidden="true" /> Add folder…</button>
                  </div>
                )}
              </fieldset>
            );
          })}
        </section>

        <section className="set-sec" aria-labelledby={ids.name + "-n"}>
          <h3 id={ids.name + "-n"}>Network sources</h3>
          {overview.sources.length === 0 && gone.sources.length === 0 ? (
            <p className="muted">No network sources are configured.</p>
          ) : (
            <>
              {form.admin && <p className="muted">An administrator can use every network source, whatever is chosen here.</p>}
              <ul className="acc-sources">
                {overview.sources.map((s) => (
                  <li key={s.name}>
                    <span className="acc-src-name"><bdi>{s.name}</bdi> <span className="muted">{s.type}</span></span>
                    <Dropdown
                      label={`Access to ${s.name}`}
                      value={form.sources[s.name] ?? "none"}
                      options={SOURCE_CHOICES}
                      disabled={busy !== ""}
                      onChange={(v) => setForm((f) => ({ ...f, sources: { ...f.sources, [s.name]: v as SourceChoice } }))}
                    />
                  </li>
                ))}
                {gone.sources.map((name) => (
                  <li key={name}>
                    <span className="acc-src-name">
                      <bdi>{name}</bdi> <span className="muted">(not configured now)</span>
                      <span className="muted acc-help acc-gone">{form.sources[name] === "write" ? "Read and write" : "Read only"}. Saving leaves this grant out, which ends it.</span>
                    </span>
                    <button type="button" aria-label={`Remove the grant to ${name}`} onClick={() => setForm((f) => ({ ...f, sources: { ...f.sources, [name]: "none" } }))}>
                      <Ic.X aria-hidden="true" /> Remove
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <div className="acc-actions">
          <div className="ad-err acc-err" role="alert" id={ids.err}>
            {err.length === 1 ? err[0] : err.length > 1 ? <ul>{err.map((x) => <li key={x}>{x}</li>)}</ul> : null}
          </div>
          <button type="button" onClick={() => requestClose()}><Ic.X aria-hidden="true" /> Cancel</button>
          <button type="button" className="primary" onClick={save} aria-busy={busy === "save" || undefined} aria-describedby={err.length ? ids.err : undefined}>
            <Ic.Check aria-hidden="true" /> {busy === "save" ? "Saving…" : existing ? "Save" : "Create account"}
          </button>
        </div>
      </fieldset>

      {picking !== null && (
        <GrantPicker
          node={picking}
          onClose={() => setPicking(null)}
          onPick={(path) => {
            setMachine(picking, (x) => (x.grants.some((g) => g.path === path) ? x : { ...x, grants: [...x.grants, { path, write: false }] }));
            setPicking(null);
          }}
        />
      )}
      {asking && (
        <Modal title="Change your own account" onClose={() => setAsking(null)} describedBy={ids.self + "-q"}>
          <p id={ids.self + "-q"} className="pad0">{SELF_WARNING}</p>
          <div className="modal-actions">
            <button type="button" autoFocus onClick={() => setAsking(null)}><Ic.X aria-hidden="true" /> Cancel</button>
            <button
              type="submit"
              onClick={() => {
                const go = asking;
                setAsking(null);
                void go();
              }}
            >
              <Ic.Check aria-hidden="true" /> Save and sign out
            </button>
          </div>
        </Modal>
      )}
      {discarding && (
        <Modal title="Discard changes?" onClose={() => setDiscarding(false)} describedBy={ids.err + "-d"}>
          <p id={ids.err + "-d"} className="pad0">The changes to this account have not been saved.</p>
          <div className="modal-actions">
            <button type="button" autoFocus onClick={() => setDiscarding(false)}><Ic.Undo2 aria-hidden="true" /> Keep editing</button>
            <button type="submit" className="danger" onClick={() => (setDiscarding(false), (afterDiscard.current ?? onClose)())}><Ic.Trash2 aria-hidden="true" /> Discard</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
