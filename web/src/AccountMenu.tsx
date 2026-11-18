import { lazy, Suspense, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleUser, KeyRound, LogOut, ShieldAlert, Users } from "lucide-react";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { Tip } from "./Tooltip";
import { logout, type Account } from "./auth";

const AsRootDialog = lazy(() => import("./AsRootDialog").then((m) => ({ default: m.AsRootDialog })));

/**
 * The signed-in account in the header: its name, and a menu with "Sign out". Only shown when sign-in is on. A system
 * administrator also gets "Act as root…", which asks for the password or key again; `onAsRoot` gets the local end time. Every
 * administrator (system or virtual) gets "Accounts…", which opens the Accounts view through `onAccounts`. A Tailscale
 * session also shows "Signed in with Tailscale as <login or tag>" (the subject comes from the tailnet: shown in <bdi>).
 */
export function AccountMenu({ account, onAsRoot, onAccounts }: { account: Account; onAsRoot: (endsAt: number) => void; onAccounts?: () => void }) {
  const { name } = account;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [asking, setAsking] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const items: MenuItem[] = [{ label: name, disabled: true, icon: CircleUser }];
  if (account.method === "tailscale") {
    const subject = account.tailnet;
    items.push({ label: `Signed in with Tailscale${subject ? ` as ${subject}` : ""}`, content: <span className="ctx-text">Signed in with Tailscale{subject && <> as <bdi>{subject}</bdi></>}</span>, disabled: true, icon: KeyRound });
  }
  items.push("sep");
  if (account.admin && onAccounts) items.push({ label: "Accounts…", icon: Users, onSelect: onAccounts });
  // never for a virtual account or a system account that is not an administrator
  if (account.kind === "sys" && account.admin) items.push({ label: "Act as root…", icon: ShieldAlert, onSelect: () => setAsking(true) });
  items.push({ label: "Sign out", icon: LogOut, onSelect: () => void signOut() });
  const signOut = async () => {
    try {
      await logout();
    } finally {
      location.reload();
    }
  };
  return (
    <>
      <Tip label={`Signed in as ${name}`}>
        <button
          type="button"
          ref={button}
          className="account-btn"
          aria-label={`Account: ${name}`}
          aria-haspopup="menu"
          aria-expanded={false}
          onClick={(e) => {
            // the menu keeps itself inside the window and sets aria-expanded while open
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.right - 160, y: r.bottom + 2 });
          }}
        >
          <CircleUser aria-hidden="true" /> <span className="bl">{name}</span>
        </button>
      </Tip>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={items}
          onClose={() => setMenu(null)}
        />
      )}
      {/* on the page body: the header is a stacking context of its own, which would keep the dialog under the panels */}
      {asking && createPortal(
        <Suspense fallback={null}>
          <AsRootDialog
            name={name}
            onStarted={onAsRoot}
            onClose={() => {
              setAsking(false);
              button.current?.focus({ preventScroll: true });
            }}
          />
        </Suspense>,
        document.body,
      )}
    </>
  );
}
