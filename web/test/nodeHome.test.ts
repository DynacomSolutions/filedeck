import assert from "node:assert/strict";
import test from "node:test";
import { canGoUp, firstCrumb, homeOf, insideRoots, noAccessHome, openPath, rowOpens } from "../src/nodeHome.ts";

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

test("the address bar's first crumb names a granted folder by its path; elsewhere it is the root", () => {
  const n = { roots: ["/srv/b", "/srv/a"] };
  assert.deepEqual(firstCrumb(n, "/srv/a"), { label: "/srv/a", granted: true });
  assert.deepEqual(firstCrumb(n, "/"), { label: "/", granted: false });
  assert.deepEqual(firstCrumb(undefined, "/"), { label: "/", granted: false });
  assert.deepEqual(firstCrumb({}, "/mnt/data"), { label: "/", granted: false });
});

test("a folder the account may not list offers the home folder, for a machine with roots only", () => {
  const n = { roots: ["/srv/b"] };
  const denied = Object.assign(new Error("no access"), { status: 403 });
  assert.equal(noAccessHome(n, "/", denied), "/srv/b");
  assert.equal(noAccessHome(n, "/etc", denied), "/srv/b");
  // other failures, and machines without roots, keep the plain error
  assert.equal(noAccessHome(n, "/", Object.assign(new Error("gone"), { status: 404 })), null);
  assert.equal(noAccessHome(n, "/", new Error("network")), null);
  assert.equal(noAccessHome({}, "/", denied), null);
  assert.equal(noAccessHome(undefined, "/", denied), null);
  // at the home folder itself there is nowhere better to send the account
  assert.equal(noAccessHome(n, "/srv/b", denied), null);
});

test("up is allowed when the parent folder is inside a granted folder: nested grants and a grant of /", () => {
  assert.equal(canGoUp({ roots: ["/srv", "/srv/a"] }, "/srv/a"), true);
  assert.equal(canGoUp({ roots: ["/srv", "/srv/a"] }, "/srv"), false);
  assert.equal(canGoUp({ roots: ["/"] }, "/x"), true);
  assert.equal(canGoUp({ roots: ["/"] }, "/"), false);
  assert.equal(canGoUp({ roots: ["/srv/b", "/"] }, "/srv/b"), true);
  // outside every grant (typed, or an old bookmark): up would only go further out
  assert.equal(canGoUp({ roots: ["/srv/b"] }, "/etc/x"), false);
});

test("paths with a trailing slash compare as the folder itself", () => {
  assert.equal(canGoUp({ roots: ["/srv/share"] }, "/srv/share/"), false);
  assert.equal(canGoUp({ roots: ["/srv/share/"] }, "/srv/share"), false);
  assert.equal(canGoUp({ roots: ["/srv/share"] }, "/srv/share/x/"), true);
  const denied = Object.assign(new Error("no access"), { status: 403 });
  assert.equal(noAccessHome({ roots: ["/srv/b"] }, "/srv/b/", denied), null);
  assert.deepEqual(firstCrumb({ roots: ["/srv/b"] }, "/srv/b/"), { label: "/srv/b", granted: true });
  assert.equal(insideRoots({ roots: ["/srv/b"] }, "/srv/b/"), true);
});

test("insideRoots: a granted folder or below it; every path on a machine without roots", () => {
  const n = { roots: ["/srv/b", "/srv/a"] };
  assert.equal(insideRoots(n, "/srv/b"), true);
  assert.equal(insideRoots(n, "/srv/a/x"), true);
  assert.equal(insideRoots(n, "/srv"), false);
  assert.equal(insideRoots(n, "/"), false);
  assert.equal(insideRoots(n, "/srv/bb"), false);
  assert.equal(insideRoots({ roots: ["/"] }, "/x"), true);
  assert.equal(insideRoots(undefined, "/"), true);
  assert.equal(insideRoots({}, "/srv"), true);
});
