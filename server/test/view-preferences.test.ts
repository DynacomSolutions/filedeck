import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, resolvePanelPreferences, settingsFromStorage } from "../../web/src/settings.ts";
import { decodeState, encodeState, type Tree } from "../../web/src/urlState.ts";

test("stored view preferences keep valid values and replace invalid ones independently", () => {
  assert.deepEqual(settingsFromStorage(JSON.stringify({
    upRow: "up",
    showHidden: true,
    sort: { key: "mtime", asc: false },
    view: "grid",
  })), {
    upRow: "up",
    showHidden: true,
    sort: { key: "mtime", asc: false },
    view: "grid",
  });
  assert.deepEqual(settingsFromStorage(JSON.stringify({
    upRow: "unexpected",
    showHidden: "yes",
    sort: { key: "path", asc: 1 },
    view: "table",
  })), DEFAULT_SETTINGS);
  assert.deepEqual(settingsFromStorage("not JSON"), DEFAULT_SETTINGS);
});

test("explicit panel URL preferences override stored defaults, while omitted values inherit them", () => {
  const settings = settingsFromStorage(JSON.stringify({ showHidden: true, sort: { key: "mtime", asc: false }, view: "grid" }));
  const explicit: Tree = { kind: "leaf", id: "p1", node: "n", path: "/a", hidden: false, sort: { key: "name", asc: true }, w: "l" };
  const restored = decodeState(encodeState({ tree: explicit, active: "p1" }));
  assert.deepEqual(restored?.tree, explicit);
  assert.deepEqual(resolvePanelPreferences(settings, restored!.tree as Extract<Tree, { kind: "leaf" }>), {
    hidden: false,
    sort: { key: "name", asc: true },
    view: "list",
  });

  const omitted: Tree = { kind: "leaf", id: "p1", node: "n", path: "/a" };
  const inherited = decodeState(encodeState({ tree: omitted, active: "p1" }));
  assert.deepEqual(inherited?.tree, omitted);
  assert.deepEqual(resolvePanelPreferences(settings, inherited!.tree as Extract<Tree, { kind: "leaf" }>), {
    hidden: true,
    sort: { key: "mtime", asc: false },
    view: "grid",
  });
});
