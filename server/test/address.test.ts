import { test } from "node:test";
import assert from "node:assert/strict";
import { addressBase, baseRemainder, fuzzy, itemUri, normPath, parseAddress, resolveBasePath, splitTyped } from "../../web/src/address.ts";
import { encodeState, type Tree } from "../../web/src/urlState.ts";

const cur = { node: "node-a", path: "/home/user" };
const nodes = ["node-a", "node-b", "macbook"];

test("normPath resolves dots and slashes", () => {
  assert.equal(normPath("/a//b/./c/../d/"), "/a/b/d");
  assert.equal(normPath("../x", "/a/b"), "/a/x");
  assert.equal(normPath("/.."), "/");
});

test("parseAddress: node:/path, /path, bare names, relative", () => {
  assert.deepEqual(parseAddress("node-b:/var/log", cur, nodes), { node: "node-b", path: "/var/log" });
  assert.deepEqual(parseAddress("MACBOOK:/Users/me/", cur, nodes), { node: "macbook", path: "/Users/me" });
  assert.deepEqual(parseAddress("node-b:", cur, nodes), { node: "node-b", path: "/" });
  assert.deepEqual(parseAddress("/etc", cur, nodes), { node: "node-a", path: "/etc" });
  assert.deepEqual(parseAddress("node-b", cur, nodes), { node: "node-b", path: "/" });
  assert.deepEqual(parseAddress("docs/x", cur, nodes), { node: "node-a", path: "/home/user/docs/x" });
  assert.ok("error" in parseAddress("nope:/x", cur, nodes));
  assert.ok("error" in parseAddress("  ", cur, nodes));
});

test("parseAddress: full app URL", () => {
  const tree: Tree = { kind: "leaf", id: "p1", node: "node-b", path: "/srv", sel: "/srv/a.txt" };
  const url = "https://files.example.test/?s=" + encodeURIComponent(new URLSearchParams(encodeState({ tree, active: "p1" })).get("s")!);
  assert.deepEqual(parseAddress(url, cur, nodes), { node: "node-b", path: "/srv", select: "/srv/a.txt" });
  assert.ok("error" in parseAddress("https://files.example.test/", cur, nodes));
});

test("splitTyped: parent folder and fragment", () => {
  assert.deepEqual(splitTyped("node-b:/var/lo", cur, nodes), { bare: false, node: "node-b", dir: "/var", leaf: "lo" });
  assert.deepEqual(splitTyped("/", cur, nodes), { bare: false, node: "node-a", dir: "/", leaf: "" });
  assert.deepEqual(splitTyped("hq", cur, nodes), { bare: true, node: "node-a", dir: "/home/user", leaf: "hq" });
  assert.deepEqual(splitTyped("node-a:/a/..", cur, nodes), { bare: false, node: "node-a", dir: "/", leaf: "" });
  assert.equal(splitTyped("zz:/x", cur, nodes), null);
});

test("address bases resolve mount-relative paths without prefix collisions", () => {
  const bases = [
    { node: "node-a", path: "/", label: "node-a", kind: "node" as const },
    { node: "node-a", path: "/mnt", label: "node-a:/mnt", kind: "mount" as const },
  ];
  assert.equal(addressBase("node-a", "/mnt/photos", bases).path, "/mnt");
  assert.equal(addressBase("node-a", "/mnt2/photos", bases).path, "/");
  assert.equal(baseRemainder(bases[1]!, "/mnt/photos/2026"), "photos/2026");
  assert.equal(resolveBasePath(bases[1]!, "photos/2026"), "/mnt/photos/2026");
  assert.equal(resolveBasePath(bases[0]!, "/etc"), "/etc");
  const parsedBase = addressBase("node-a", "/mnt/photos/2026", bases);
  assert.equal(baseRemainder(parsedBase, "/mnt/photos/2026"), "photos/2026", "an unrelated target base keeps the parsed URI remainder");
});

test("fuzzy ranks prefix over substring over subsequence", () => {
  assert.ok(fuzzy("doc", "documents") > fuzzy("doc", "my-docs"));
  assert.ok(fuzzy("doc", "my-docs") > fuzzy("dcs", "documents"));
  assert.equal(fuzzy("xyz", "documents"), -1);
  assert.equal(itemUri("node-a", "/", "etc", true), "node-a:/etc/");
  assert.equal(itemUri("node-a", "/a", "f.txt", false), "node-a:/a/f.txt");
});
