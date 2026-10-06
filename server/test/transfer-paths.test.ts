import test from "node:test";
import assert from "node:assert/strict";
import { validTransferDestination } from "../../web/src/transferPaths.ts";

test("folder transfer destinations exclude self and descendants on the same node", () => {
  const items = [{ node: "local", path: "/projects/app", dir: true }];
  assert.equal(validTransferDestination(items, "local", "/projects/app"), false);
  assert.equal(validTransferDestination(items, "local", "/projects/app/src"), false);
  assert.equal(validTransferDestination(items, "local", "/projects/application"), true);
  assert.equal(validTransferDestination(items, "local", "/projects"), true);
  assert.equal(validTransferDestination(items, "remote", "/projects/app/src"), true);
});

test("file transfers and mixed selections are checked without overblocking", () => {
  assert.equal(validTransferDestination([{ node: "local", path: "/a.txt", dir: false }], "local", "/"), true);
  assert.equal(validTransferDestination([
    { node: "local", path: "/a.txt", dir: false },
    { node: "local", path: "/folder", dir: true },
  ], "local", "/folder/child"), false);
  assert.equal(validTransferDestination([
    { node: "local", path: "/a.txt", dir: false },
    { node: "remote", path: "/folder", dir: true },
  ], "local", "/folder"), true);
});
