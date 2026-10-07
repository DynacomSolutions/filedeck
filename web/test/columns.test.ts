import assert from "node:assert/strict";
import test from "node:test";
import { COLUMNS, clampWidth, isFlex, isShown, totalWidth, parseColumns, resetColumns, resetWidth, serialiseColumns, setWidth, toggleColumn, visibleColumns, widthOf } from "../src/columns.ts";

test("widths are clamped to the column limits", () => {
  assert.equal(clampWidth("size", 1), 70);
  assert.equal(clampWidth("size", 99999), 400);
  assert.equal(clampWidth("size", 123.6), 124);
  assert.equal(clampWidth("size", Number.NaN), 100);
});

test("corrupt storage falls back to defaults", () => {
  for (const raw of [null, "", "{", "null", "[]", "42", '"x"', '{"widths":5,"shown":[]}']) {
    const s = parseColumns(raw);
    assert.deepEqual(visibleColumns(s).map((c) => c.id), ["name", "size", "mtime"], String(raw));
    assert.equal(widthOf(s, "size"), 100);
  }
});

test("parse drops unknown ids, bad values and clamps widths", () => {
  const s = parseColumns(JSON.stringify({ widths: { size: 5, nope: 200, mtime: "wide", name: 300 }, shown: { mode: true, name: false, zzz: true, type: "yes" } }));
  assert.equal(widthOf(s, "size"), 70);
  assert.equal(widthOf(s, "name"), 300);
  assert.equal(widthOf(s, "mtime"), 160);
  assert.equal(isShown(s, "mode"), true);
  assert.equal(isShown(s, "name"), true);
  assert.equal(isShown(s, "type"), false);
});

test("state survives a serialise and parse round trip", () => {
  const s = toggleColumn(setWidth(resetColumns(), "mtime", 222), "type");
  assert.deepEqual(parseColumns(serialiseColumns(s)), s);
});

test("visibility toggles and Name can never be hidden", () => {
  let s = resetColumns();
  s = toggleColumn(s, "mode");
  assert.equal(isShown(s, "mode"), true);
  s = toggleColumn(s, "size");
  assert.deepEqual(visibleColumns(s).map((c) => c.id), ["name", "mtime", "mode"]);
  assert.equal(toggleColumn(s, "name"), s);
  assert.equal(visibleColumns(s)[0]?.id, "name");
  assert.equal(COLUMNS[0]?.id, "name");
});

test("reset restores defaults and resetWidth forgets one width", () => {
  const s = setWidth(setWidth(resetColumns(), "size", 200), "mtime", 250);
  assert.equal(widthOf(resetWidth(s, "size"), "size"), 100);
  assert.equal(widthOf(resetWidth(s, "size"), "mtime"), 250);
  assert.deepEqual(resetColumns(), { widths: {}, shown: {} });
});

test("Name fills the remaining width until the user resizes it", () => {
  const s = resetColumns();
  assert.equal(isFlex(s, "name"), true);
  assert.equal(isFlex(s, "size"), false);
  const sized = setWidth(s, "name", 500);
  assert.equal(isFlex(sized, "name"), false);
  assert.equal(widthOf(sized, "name"), 500);
  assert.equal(isFlex(resetWidth(sized, "name"), "name"), true);
  assert.equal(isFlex(parseColumns(serialiseColumns(sized)), "name"), false);
});

test("the minimum table width uses Name's default share and honours a stored width", () => {
  assert.equal(totalWidth(resetColumns()), 240 + 100 + 160);
  assert.equal(totalWidth(setWidth(resetColumns(), "name", 600)), 600 + 100 + 160);
  assert.equal(widthOf(resetColumns(), "name"), 240);
});

test("header alignment: only Size is right aligned", () => {
  assert.deepEqual(COLUMNS.filter((c) => c.align === "end").map((c) => c.id), ["size"]);
});
