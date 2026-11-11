import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { entryKind, listAnnouncement, revealDelta, rowId } from "../src/listFocus.ts";

const filePanel = readFileSync(new URL("../src/FilePanel.tsx", import.meta.url), "utf8");

test("a primary-button release in the column header returns focus to the file list", () => {
  assert.match(filePanel, /<thead\s+role="rowgroup"\s+onPointerUp=\{\(e\) => \{[\s\S]*?e\.button === 0\) listRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(filePanel, /ref=\{listRef\}\s+className="fp-scroll"\s+tabIndex=\{0\}\s+role=\{view === "grid" \? "listbox" : "grid"\}/);
});

const editors = readFileSync(new URL("../src/EditorViews.tsx", import.meta.url), "utf8");
const columns = readFileSync(new URL("../src/Columns.tsx", import.meta.url), "utf8");

test("a row or tile names what it is, so a folder and a file differ without the icon", () => {
  assert.equal(entryKind({ type: "dir" }), "Folder");
  assert.equal(entryKind({ type: "symlink", linkDir: true }), "Folder");
  assert.equal(entryKind({ type: "symlink" }), "Link");
  assert.equal(entryKind({ type: "file" }), "File");
  assert.match(filePanel, /<span className="visually-hidden">\{entryKind\(en\)\}, <\/span>/);
});

test("the list is a grid (a listbox in the thumbnail view) with aria-selected rows and an active descendant", () => {
  assert.match(filePanel, /aria-multiselectable="true"\s+aria-busy=\{loading\}\s+aria-activedescendant=\{activeRowId\}/);
  assert.match(filePanel, /"aria-selected": sel\.has\(en\.path\)/);
  assert.match(filePanel, /id: rowId\(listId, index\)/);
  assert.match(filePanel, /<table className="ft cols" role="presentation"/);
  assert.match(columns, /<tr\s+role="row"/);
  assert.match(columns, /role="columnheader"/);
  assert.equal(rowId("p", 3), "p-r3");
});

test("Tab is not taken by the list; Alt+PageDown / Alt+PageUp switch panels and F6 keeps moving files", () => {
  assert.doesNotMatch(filePanel, /key === "Tab" && !mod/);
  assert.match(filePanel, /\(key === "PageDown" \|\| key === "PageUp"\)\) return onSwitch\(key === "PageDown" \? 1 : -1\);/);
  assert.match(filePanel, /if \(key === "F6"\) return toOther\("move"\), true;/);
  const help = readFileSync(new URL("../src/Shortcuts.tsx", import.meta.url), "utf8");
  assert.match(help, /\["Alt\+PageDown \/ Alt\+PageUp", "Next \/ previous panel's file list/);
  assert.doesNotMatch(help, /F6 \/ Shift\+F6/);
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /\[data-fp="\$\{to\.id\}"\] \.fp-scroll/);
});

test("the list is never rebuilt when the side pane opens or closes, and a split returns focus to a list", () => {
  assert.doesNotMatch(filePanel, /\) : pane \? \(\s+<Group/);
  assert.match(filePanel, /\{first && pane && <Panel id="pv"/);
  assert.match(filePanel, /<Panel id="list" minSize=\{narrow \? "30%" : "20%"\}>\{listing\}<\/Panel>/);
  assert.match(filePanel, /onSelect: \(\) => split\("horizontal"\)/);
  assert.match(filePanel, /onSplit\(dir\);\s+focusPanelList\(leaf\.id\);/);
});

test("each lazy editor is inside an error boundary with a retry, not left to unmount the panel", () => {
  assert.match(filePanel, /<ErrorBoundary what="The editor"[\s\S]*?<Suspense[\s\S]*?<TextEditor/);
  assert.match(filePanel, /<ErrorBoundary what="The diff viewer"[\s\S]*?<Suspense[\s\S]*?<DiffViewer/);
});

test("two panels never share a landmark name", () => {
  assert.match(filePanel, /aria-label=\{`File and folder actions for \$\{panelName\}`\}/);
  assert.match(filePanel, /<AddressBar label=\{`Breadcrumb for \$\{panelName\}`\}/);
  assert.match(filePanel, /pr\.id < leaf\.id\)\.length;/);
  const bar = readFileSync(new URL("../src/AddressBar.tsx", import.meta.url), "utf8");
  assert.match(bar, /aria-label=\{label\} ref=\{navRef\}/);
});

test("a row at the top edge is scrolled clear of the sticky header", () => {
  // view 100..400, header 30 high: a row at 100..120 is under the header
  assert.equal(revealDelta(100, 120, 100, 400, 30), -30);
  assert.equal(revealDelta(130, 150, 100, 400, 30), 0);
  assert.equal(revealDelta(390, 420, 100, 400, 30), 20);
  assert.equal(revealDelta(150, 170, 100, 400, 0), 0);
  assert.match(filePanel, /revealRow\(scroller, row\)/);
});

test("the list announces its settled state once, not while it streams or loads", () => {
  const base = { loading: false, streaming: false, total: 12, shown: 12, filtered: false, error: false };
  assert.equal(listAnnouncement(base), "12 entries");
  assert.equal(listAnnouncement({ ...base, total: 1, shown: 1 }), "1 entry");
  assert.equal(listAnnouncement({ ...base, total: 0, shown: 0 }), "Empty folder");
  assert.equal(listAnnouncement({ ...base, filtered: true, shown: 0 }), "No entries match the filter");
  assert.equal(listAnnouncement({ ...base, filtered: true, shown: 3 }), "3 of 12 entries match the filter");
  assert.equal(listAnnouncement({ ...base, streaming: true }), "");
  assert.equal(listAnnouncement({ ...base, loading: true }), "");
  assert.match(filePanel, /role="status" aria-live="polite">\{!cside && !leaf\.sr \? listSays : ""\}/);
  assert.doesNotMatch(filePanel, /fp-streaming" role="status"/);
});

test("rename and inline create hand focus back to the list when they end", () => {
  assert.match(filePanel, /if \(e\.key === "Escape"\) \(setRenaming\(null\), focusList\(\)\);/);
  assert.match(filePanel, /setRenaming\(null\);\s+focusList\(\);/);
  assert.match(filePanel, /if \(e\.key === "Escape"\) return \(setCreating\(null\), focusList\(\)\);/);
  assert.match(filePanel, /setCreating\(null\);\s+focusList\(\);/);
  // handing focus back is not the keyboard arriving: it must not select the first row
  assert.match(filePanel, /!skipFocusSelect\.current && sel\.size === 0/);
});

test("the column chooser is also in the View menu", () => {
  assert.match(filePanel, /\.\.\.\(view !== "grid" \? \(\["sep", \.\.\.columnMenu\(\)\] as MenuItem\[\]\) : \[\]\)/);
});

test("the editor says how to get out with Tab, and the page-level diff is a modal dialog", () => {
  assert.match(editors, /ariaLabel: "Editor\. Tab inserts a tab\. Press Control\+M/);
  assert.equal((editors.match(/<TabFocusToggle /g) ?? []).length, 2);
  assert.match(editors, /aria-label="Toggle Tab key moves focus"/);
  assert.match(editors, /role: "dialog", "aria-modal": true/);
  assert.match(editors, /overlay && e\.key === "Escape"/);
});
