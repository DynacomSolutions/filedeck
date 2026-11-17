import { useState } from "react";
import { CircleUser, LogOut } from "lucide-react";
import { ContextMenu } from "./ContextMenu";
import { Tip } from "./Tooltip";
import { logout } from "./auth";

/** The signed-in account in the header: its name, and a menu with "Sign out". Only shown when sign-in is on. */
export function AccountMenu({ name }: { name: string }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
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
          items={[{ label: name, disabled: true, icon: CircleUser }, "sep", { label: "Sign out", icon: LogOut, onSelect: () => void signOut() }]}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
