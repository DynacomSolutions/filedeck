import assert from "node:assert/strict";
import test from "node:test";
import { canGoUp, homeOf, openPath, rowOpens } from "../src/nodeHome.ts";

test("a machine's home is its first granted folder, else /", () => {
  assert.equal(homeOf({ roots: ["/srv/b", "/srv/a"] }), "/srv/b");
  assert.equal(homeOf({}), "/");
  assert.equal(homeOf(undefined), "/");
  assert.equal(homeOf({ roots: [] }), "/");
});

test("opening a machine at / opens its home; any other folder is kept", () => {
  assert.equal(openPath({ roots: ["/x"] }, "/"), "/x");
  assert.equal(openPath({ roots: ["/x"] }, "/x/y"), "/x/y");
  assert.equal(openPath(undefined, "/"), "/");
  assert.equal(openPath({}, "/y"), "/y");
});

test("a sidebar row for a granted folder opens its exact path, a grant of / too; the machine's row opens its home", () => {
  const n = { roots: ["/srv/b", "/"] };
  assert.equal(rowOpens("dir", n, "/"), "/");
  assert.equal(rowOpens("dir", n, "/srv/b"), "/srv/b");
  assert.equal(rowOpens("node", n, "/"), "/srv/b");
  assert.equal(rowOpens("node", undefined, "/"), "/");
});

test("up stops at / and at a granted folder", () => {
  const n = { roots: ["/srv/b", "/srv/a"] };
  assert.equal(canGoUp(n, "/srv/b"), false);
  assert.equal(canGoUp(n, "/srv/a"), false);
  assert.equal(canGoUp(n, "/srv/b/x"), true);
  assert.equal(canGoUp(n, "/"), false);
  assert.equal(canGoUp(undefined, "/"), false);
  assert.equal(canGoUp(undefined, "/srv/b"), true);
  assert.equal(canGoUp({}, "/srv"), true);
});
