import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Popover, type TNode } from "../src/SidebarTree.tsx";
import { ancestorPaths, elide, flatten, heldIds, hold, isOpen, shownOpen, type Held, navigate, parseExpanded, folderSizes, rovingId, serverUsage, setOpen, usagePct, type TreeNodeBase } from "../src/sidebarTree.ts";

const tree: TreeNodeBase[] = [
  { id: "a", expandable: true, children: [{ id: "a1", expandable: true, children: [{ id: "a1x", expandable: false }] }, { id: "a2", expandable: false }] },
  { id: "b", expandable: true, children: [{ id: "b1", expandable: false }] },
];
const rows = (open: string[]) => flatten(tree, (n) => open.includes(n.id));

test("expand state: defaults, overrides and trimming", () => {
  assert.equal(isOpen({}, "sec", true), true);
  assert.equal(isOpen({ sec: false }, "sec", true), false);
  assert.deepEqual(setOpen({}, "x", true, false), { x: true });
  assert.deepEqual(setOpen({ x: true }, "x", false, false), {});
  assert.deepEqual(setOpen({}, "sec", true, true), {});
  let s = {};
  for (let i = 0; i < 500; i++) s = setOpen(s, "k" + i, true, false);
  assert.equal(Object.keys(s).length, 400);
  assert.ok("k499" in s && !("k0" in s));
});

test("parseExpanded tolerates junk", () => {
  assert.deepEqual(parseExpanded("nope"), {});
  assert.deepEqual(parseExpanded("[1]"), {});
  assert.deepEqual(parseExpanded('{"a":true,"b":1,"c":false}'), { a: true, c: false });
  assert.deepEqual(parseExpanded(null), {});
});

test("flatten shows children only under expanded rows", () => {
  assert.deepEqual(rows([]).map((r) => r.id), ["a", "b"]);
  const r = rows(["a", "a1"]);
  assert.deepEqual(r.map((x) => [x.id, x.level, x.parent]), [["a", 1, null], ["a1", 2, "a"], ["a1x", 3, "a1"], ["a2", 2, "a"], ["b", 1, null]]);
});

test("Up/Down/Home/End clamp at the ends", () => {
  const r = rows(["a"]);
  assert.deepEqual(navigate(r, "a", "ArrowDown"), { type: "focus", id: "a1" });
  assert.deepEqual(navigate(r, "b", "ArrowDown"), { type: "focus", id: "b" });
  assert.deepEqual(navigate(r, "a", "ArrowUp"), { type: "focus", id: "a" });
  assert.deepEqual(navigate(r, "a2", "ArrowUp"), { type: "focus", id: "a1" });
  assert.deepEqual(navigate(r, "a1", "End"), { type: "focus", id: "b" });
  assert.deepEqual(navigate(r, "b", "Home"), { type: "focus", id: "a" });
});

test("Right expands, then enters; Left collapses, then goes to the parent", () => {
  const closed = rows([]);
  assert.deepEqual(navigate(closed, "a", "ArrowRight"), { type: "expand", id: "a" });
  const open = rows(["a"]);
  assert.deepEqual(navigate(open, "a", "ArrowRight"), { type: "focus", id: "a1" });
  assert.equal(navigate(open, "a2", "ArrowRight"), null);
  assert.deepEqual(navigate(open, "a", "ArrowLeft"), { type: "collapse", id: "a" });
  assert.deepEqual(navigate(open, "a1", "ArrowLeft"), { type: "focus", id: "a" });
  assert.equal(navigate(open, "a", "ArrowLeft") && navigate(closed, "a", "ArrowLeft"), null);
  // an expandable row with no loaded children yet: Right on it does nothing further
  const empty = flatten([{ id: "z", expandable: true, children: [] }], () => true);
  assert.equal(navigate(empty, "z", "ArrowRight"), null);
});

test("Enter opens, Space toggles folders and opens leaves, other keys ignored", () => {
  const r = rows(["a"]);
  assert.deepEqual(navigate(r, "a2", "Enter"), { type: "open", id: "a2" });
  assert.deepEqual(navigate(r, "a", " "), { type: "toggle", id: "a" });
  assert.deepEqual(navigate(r, "a2", " "), { type: "open", id: "a2" });
  assert.equal(navigate(r, "a", "x"), null);
  assert.equal(navigate([], null, "ArrowDown"), null);
  assert.deepEqual(navigate(r, null, "ArrowDown"), { type: "focus", id: "a" });
});

test("rovingId falls back to the first visible row", () => {
  const r = rows([]);
  assert.equal(rovingId(r, "b"), "b");
  assert.equal(rovingId(r, "gone"), "a");
  assert.equal(rovingId([], "a"), null);
});

test("server usage sums mounts, counts a device once and skips empty ones", () => {
  assert.equal(serverUsage([]), null);
  assert.equal(serverUsage([{ device: "tmpfs", total: 0, used: 0 }]), null);
  assert.deepEqual(serverUsage([{ device: "/dev/a", total: 100, used: 25 }, { device: "/dev/a", total: 100, used: 25 }, { device: "/dev/b", total: 300, used: 75 }]), { used: 100, total: 400 });
  assert.equal(usagePct({ used: 100, total: 400 }), 25);
  assert.equal(usagePct({ used: 5, total: 0 }), 0);
  assert.equal(usagePct({ used: 9, total: 3 }), 100);
});

test("popover shows label, details, size, percentage and bar", () => {
  const t = { id: "n:eu3", kind: "node", label: "a-very-long-server-name", icon: null, expandable: true, defaultOpen: false, tip: "eu3:/", usage: { used: 512, total: 2048 } } as TNode;
  const html = renderToStaticMarkup(createElement(Popover, { t }));
  assert.match(html, /a-very-long-server-name/);
  assert.match(html, /eu3:\//);
  assert.match(html, /512 B of 2\.0 KiB used \(25%\)/);
  assert.match(html, /class="st-bar"[^>]*aria-label="25% used"/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(Popover, { t: { ...t, usage: undefined } })), /st-bar/);
});

test("folderSizes: share of the parent, or of the mount's used bytes for top folders", () => {
  const e = [{ path: "/a", diskBytes: 100 }, { path: "/a/x", diskBytes: 25 }, { path: "/a/y", diskBytes: 75 }];
  const p = folderSizes(e, "/a");
  assert.equal(usagePct(p["/a/x"]!), 25);
  assert.equal(p["/a/x"]!.basis, "parent");
  const m = folderSizes(e, "/a", 400);
  assert.equal(usagePct(m["/a/y"]!), 19);
  assert.equal(m["/a/y"]!.basis, "mount");
  assert.deepEqual(folderSizes([{ path: "/a/x", diskBytes: 1 }], "/a"), {}); // parent not stored: nothing known
});

test("popover: size basis for known folders, a note and no bar for unknown ones", () => {
  const base = { id: "i", kind: "dir", label: "x", icon: null, expandable: true, defaultOpen: false } as const;
  const known = renderToStaticMarkup(createElement(Popover, { t: { ...base, size: { used: 1024, total: 4096, basis: "parent" } } as TNode }));
  assert.match(known, /1.0 KiB \(25% of the parent folder\)/);
  assert.match(known, /st-bar/);
  const mount = renderToStaticMarkup(createElement(Popover, { t: { ...base, size: { used: 1024, total: 4096, basis: "mount" } } as TNode }));
  assert.match(mount, /of the used space on the mount/);
  const unknown = renderToStaticMarkup(createElement(Popover, { t: { ...base, size: "unknown" } as TNode }));
  assert.match(unknown, /size not calculated yet/);
  assert.doesNotMatch(unknown, /st-bar/);
});

// Model of the tree's open state: manual choice (stored), auto = ancestor of the current folder, held = collapsed by hand at this location.
const open = (manual: Set<string>, loc: string, h: Held, id: string, at: string) => shownOpen(manual.has(id), ancestorPaths(loc).includes(at), heldIds(h, loc).includes(id));
const none: Held = { loc: "", ids: [] };

test("ancestorPaths: root first, never the folder itself", () => {
  assert.deepEqual(ancestorPaths("/a/b/c"), ["/", "/a", "/a/b"]);
  assert.deepEqual(ancestorPaths("/a"), ["/"]);
  assert.deepEqual(ancestorPaths("/"), []);
});

test("navigating to a deep path opens its ancestors", () => {
  for (const p of ["/", "/a", "/a/b"]) assert.equal(open(new Set(), "/a/b/c", none, "id" + p, p), true);
  assert.equal(open(new Set(), "/a/b/c", none, "id/a/b/c", "/a/b/c"), false);
});

test("navigating away closes what was opened automatically", () => {
  assert.equal(open(new Set(), "/x/y", none, "id/a", "/a"), false);
  assert.equal(open(new Set(), "/x/y", none, "id/x", "/x"), true);
});

test("a manual expansion survives navigation", () => {
  assert.equal(open(new Set(["id/a"]), "/x/y", none, "id/a", "/a"), true);
});

test("a manual collapse of an ancestor holds until the next navigation", () => {
  const h = hold(none, "/a/b/c", "id/a");
  assert.equal(open(new Set(), "/a/b/c", h, "id/a", "/a"), false);
  // new location: the hold no longer applies
  const h2: Held = { loc: "/a/b/c", ids: ["id/a"] };
  assert.deepEqual(heldIds(h2, "/a/z"), []);
  assert.equal(shownOpen(false, true, heldIds(h2, "/a/z").includes("id/a")), true);
});

test("expanding an auto-opened folder by hand makes it stay open", () => {
  assert.equal(open(new Set(["id/a"]), "/x/y", none, "id/a", "/a"), true);
});

type N = TreeNodeBase & { dots?: string[] };
const chainOf = (ids: string[], leaf: N[] = []): N => ids.reduceRight<N>((kid, id) => ({ id, expandable: true, children: [kid] }), { id: "end", expandable: true, children: leaf });
const mk = (head: N, hidden: N[], tail: N): N => ({ id: head.id + "...", expandable: true, children: [tail], dots: hidden.map((h) => h.id) });
const allOpen = () => true;

test("elide: short chain untouched, long chain gets one ellipsis row", () => {
  const short = [chainOf(["a", "b"], [{ id: "x", expandable: true }])];
  assert.deepEqual(elide(short, allOpen, new Set(), mk, 2), short);
  const long = chainOf(["a", "b", "c", "d", "e", "f"], [{ id: "x", expandable: true }, { id: "y", expandable: true }]);
  const [out] = elide([long], allOpen, new Set(), mk, 2) as N[];
  assert.equal(out!.id, "a");
  const dots = out!.children![0] as N;
  assert.equal(dots.id, "a...");
  assert.deepEqual(dots.dots, ["b", "c", "d", "e"]);
  const tail = dots.children![0]!;
  assert.equal(tail.id, "f");
  assert.equal(tail.children![0]!.id, "end");
  assert.deepEqual(tail.children![0]!.children!.map((c) => c.id), ["x", "y"]);
});

test("elide: revealed head and branching stop the chain; input is not mutated", () => {
  const long = chainOf(["a", "b", "c", "d", "e", "f"]);
  const copy = JSON.stringify(long);
  assert.deepEqual(elide([long], allOpen, new Set(["a"]), mk, 2), [long]);
  elide([long], allOpen, new Set(), mk, 2);
  assert.equal(JSON.stringify(long), copy);
  const fork: N = { id: "a", expandable: true, children: [chainOf(["b", "c"]), chainOf(["d", "e"])] };
  assert.deepEqual(elide([fork], allOpen, new Set(), mk, 2), [fork]);
});

test("elide: keep 0 folds nothing; keep 3 shows three tail rows", () => {
  const long = chainOf(["a", "b", "c", "d", "e", "f"]);
  assert.equal(elide([long], allOpen, new Set(), mk, 0)[0], long);
  const [out] = elide([long], allOpen, new Set(), mk, 3) as N[];
  const dots = out!.children![0] as N;
  assert.deepEqual(dots.dots, ["b", "c"]);
  assert.equal(dots.children![0]!.id, "d");
});
