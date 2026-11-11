import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { liveReturnTarget, pressedFocusable, resolveReturnFocus } from "../src/menuOpener.ts";
import { backdropClose } from "../src/dialogFocus.ts";

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const el = (name: string) => ({ name }) as unknown as Element;

test("closing a menu returns focus to the trigger, else to the element focused before it opened", () => {
  const trigger = el("trigger"), list = el("list"), body = el("body");
  assert.equal(resolveReturnFocus(trigger, list, body), trigger);
  // Shift+F10 or right-click on a file row: no trigger button, the list held focus
  assert.equal(resolveReturnFocus(null, list, body), list);
  assert.equal(resolveReturnFocus(null, body, body), null);
  assert.equal(resolveReturnFocus(null, null, body), null);
  // right-click on content that took no focus: the focusable container it happened in
  const container = el("container");
  assert.equal(resolveReturnFocus(null, body, body, container), container);
  assert.equal(resolveReturnFocus(null, list, body, container), list);
});

test("only a fresh right-button press names a container to return to", () => {
  const container = el("container");
  const target = { closest: () => container } as unknown as Element;
  assert.equal(pressedFocusable({ target, button: 2, time: 1000 }, 1200), container);
  assert.equal(pressedFocusable({ target, button: 2, time: 1000 }, 5000), null);
  assert.equal(pressedFocusable({ target, button: 0, time: 1000 }, 1200), null);
  assert.equal(pressedFocusable(null, 1200), null);
});

test("backdrop closes only for a press and a release on the backdrop", () => {
  let closed = 0;
  const backdrop = {}, inside = {};
  const h = backdropClose(() => closed++);
  h.onMouseDown({ target: backdrop, currentTarget: backdrop });
  h.onClick({ target: backdrop, currentTarget: backdrop });
  assert.equal(closed, 1);
  // press inside a field, release over the backdrop (text selection drag)
  h.onMouseDown({ target: inside, currentTarget: backdrop });
  h.onClick({ target: backdrop, currentTarget: backdrop });
  assert.equal(closed, 1);
  // a stale press on the backdrop does not carry over to the next click
  h.onMouseDown({ target: backdrop, currentTarget: backdrop });
  h.onMouseDown({ target: inside, currentTarget: backdrop });
  h.onClick({ target: backdrop, currentTarget: backdrop });
  assert.equal(closed, 1);
});

test("backdrop click keeps a dialog open once the user has typed", () => {
  let closed = 0, dirty = true;
  const backdrop = {};
  const h = backdropClose(() => closed++, () => dirty);
  h.onMouseDown({ target: backdrop, currentTarget: backdrop });
  h.onClick({ target: backdrop, currentTarget: backdrop });
  assert.equal(closed, 0);
  dirty = false;
  h.onMouseDown({ target: backdrop, currentTarget: backdrop });
  h.onClick({ target: backdrop, currentTarget: backdrop });
  assert.equal(closed, 1);
});

test("the menu scrolls inside the window and its scrolling does not close it", () => {
  const css = src("styles.css");
  assert.match(css, /\.ctx\{[^}]*max-height:calc\(var\(--vvh,100dvh\) - 8px\);overflow-y:auto/);
  const menu = src("ContextMenu.tsx");
  assert.match(menu, /closest\("\.ctx"\)/);
  assert.ok(!menu.includes("ctx-subwrap"), "submenus are placed in the viewport, not inside the scrolling menu");
});

test("choosing an item restores focus before the menu unmounts, so a dialog remembers the list", () => {
  const menu = src("ContextMenu.tsx");
  assert.match(menu, /onRestore\?\.\(\);\s*onClose\(\);\s*it\.onSelect/);
  assert.match(menu, /if \(e\.key === "Escape" \|\| e\.key === "Tab"\) \{\s*onRestore\?\.\(\);/s);
});

test("confirm dialogs name their message, archive errors are tied to fields, help lists F6 and uses h3", () => {
  assert.match(src("Dialogs.tsx"), /describedBy=\{messageId\}/);
  assert.match(src("ArchiveDialog.tsx"), /aria-describedby=\{describedBy\}/);
  const archive = src("ArchiveDialog.tsx");
  assert.match(archive, /<div id=\{errId\} className="ad-err" role="alert">/);
  assert.match(archive, /fieldErr\("vol"\)/);
  const help = src("Shortcuts.tsx");
  assert.match(help, /\["F6 \/ Shift\+F6", "Next \/ previous panel/);
  assert.match(help, /<h3>\{g\.title\}<\/h3>/);
  assert.ok(!help.includes("onMouseDown={onClose}"));
});

test("a list rebuilt while the menu was open is found again by its label and role", () => {
  const attrs = (label: string | null, role: string | null, isConnected: boolean) => ({ isConnected, getAttribute: (n: string) => (n === "aria-label" ? label : role) }) as unknown as Element;
  const old = attrs("Files in /a", "group", false);
  const fresh = attrs("Files in /a", "group", true);
  const other = attrs("Files in /b", "group", true);
  assert.equal(liveReturnTarget(old, () => [other, fresh]), fresh);
  assert.equal(liveReturnTarget(old, () => [other]), null);
  assert.equal(liveReturnTarget(attrs(null, null, false), () => [fresh]), null);
  const alive = attrs("x", "group", true);
  assert.equal(liveReturnTarget(alive, () => [fresh]), alive);
  assert.equal(liveReturnTarget(null, () => [fresh]), null);
});
