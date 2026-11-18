import assert from "node:assert/strict";
import test from "node:test";
import { SHELL_KEY, cacheName, isOwnCache, precacheFrom, strategyFor, swVersion, type BundleEntry } from "../src/swPolicy.ts";

const O = "https://files.example.test";
const get = (path: string, mode = "cors", origin = O) => ({ method: "GET", url: origin + path, mode });

test("nothing under /api is ever handled, whatever its form", () => {
  for (const p of ["/api", "/api/", "/api?x=1", "/api/auth/me", "/api/nodes/a/api/file?path=/home/x.txt", "/api/nodes/a/api/events?path=/", "/api/ops"]) {
    assert.equal(strategyFor(get(p), O), "none", p);
    assert.equal(strategyFor(get(p, "navigate"), O), "none", p + " as a navigation");
  }
  // an encoded slash or dot segment that a server would read as /api is not handled either
  assert.equal(strategyFor(get("/%61pi/auth/me"), O), "none");
  assert.equal(strategyFor(get("/assets/../api/auth/me"), O), "none");
});

test("only GET from this origin is handled; the worker script itself never", () => {
  assert.equal(strategyFor({ method: "POST", url: O + "/", mode: "navigate" }, O), "none");
  assert.equal(strategyFor({ method: "HEAD", url: O + "/assets/index-CuXm30AH.js", mode: "cors" }, O), "none");
  assert.equal(strategyFor(get("/assets/index-CuXm30AH.js", "cors", "https://cdn.example.test"), O), "none");
  assert.equal(strategyFor(get("/sw.js"), O), "none");
});

test("navigations use the shell, including deep links with app state", () => {
  assert.equal(strategyFor(get("/", "navigate"), O), "shell");
  assert.equal(strategyFor(get("/?panes=a%3A%2Fhome&s=1", "navigate"), O), "shell");
  assert.equal(strategyFor(get("/some/route", "navigate"), O), "shell");
});

test("hashed build files are cached on use, other static files come from the precache", () => {
  assert.equal(strategyFor(get("/assets/index-CuXm30AH.js"), O), "asset");
  assert.equal(strategyFor(get("/assets/index-T6kPG2MB.css"), O), "asset");
  assert.equal(strategyFor(get("/assets/theme.css"), O), "static");
  assert.equal(strategyFor(get("/assets/fonts/Montserrat-Bold.woff2"), O), "static");
  assert.equal(strategyFor(get("/icon-192.png"), O), "static");
  // the manifest carries the deployment's brand, which can change without a new build: always from the hub
  assert.equal(strategyFor(get("/site.webmanifest"), O), "none");
  // a hashed name with a query is still the same file
  assert.equal(strategyFor(get("/assets/index-CuXm30AH.js?v=1"), O), "asset");
});

test("the shell is stored under one key that is not an API path", () => {
  assert.equal(SHELL_KEY, "/");
});

const chunk = (fileName: string, imports: string[] = [], css: string[] = [], isEntry = false): BundleEntry => ({ type: "chunk", fileName, isEntry, imports, css });

test("the precache holds the entry, its static imports and their CSS, plus listed public files; not lazy chunks", () => {
  const bundle: BundleEntry[] = [
    chunk("assets/index-AAAAAAAA.js", ["assets/react-BBBBBBBB.js", "assets/auth-CCCCCCCC.js"], ["assets/index-DDDDDDDD.css"], true),
    chunk("assets/react-BBBBBBBB.js"),
    chunk("assets/auth-CCCCCCCC.js", ["assets/react-BBBBBBBB.js"]),
    chunk("assets/editor.api-EEEEEEEE.js", ["assets/react-BBBBBBBB.js"]),
    { type: "asset", fileName: "assets/index-DDDDDDDD.css" },
    { type: "asset", fileName: "index.html" },
    { type: "asset", fileName: "sw.js" },
  ];
  const list = precacheFrom(bundle, ["icon-192.png", "assets/theme.css", "assets/fonts/OFL.txt", "sw.js", "site.webmanifest"]);
  assert.deepEqual(list, ["/assets/auth-CCCCCCCC.js", "/assets/fonts/OFL.txt", "/assets/index-AAAAAAAA.js", "/assets/index-DDDDDDDD.css", "/assets/react-BBBBBBBB.js", "/assets/theme.css", "/icon-192.png"]);
  assert.ok(!list.includes("/assets/editor.api-EEEEEEEE.js"));
  assert.ok(!list.some((p) => p.startsWith("/api")));
});

test("the version follows the precache list and names the cache; old caches are recognised as ours", () => {
  const a = swVersion(["/assets/index-AAAAAAAA.js"]);
  assert.equal(a, swVersion(["/assets/index-AAAAAAAA.js"]));
  assert.notEqual(a, swVersion(["/assets/index-ZZZZZZZZ.js"]));
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.equal(cacheName(a), `filedeck-shell-${a}`);
  assert.ok(isOwnCache("filedeck-shell-00000000"));
  assert.ok(!isOwnCache("other-app"));
});
