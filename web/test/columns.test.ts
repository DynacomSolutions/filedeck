import assert from "node:assert/strict";
import test from "node:test";
import { COLUMNS, clampWidth, isShown, totalWidth, parseColumns, resetColumns, resetWidth, serialiseColumns, setWidth, toggleColumn, visibleColumns, widthOf } from "../src/columns.ts";

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

test("every column, Name included, has an explicit width", () => {
  const s = resetColumns();
  for (const c of COLUMNS) assert.equal(typeof widthOf(s, c.id), "number", c.id);
  assert.equal(widthOf(s, "name"), 280);
  assert.equal(widthOf(setWidth(s, "name", 500), "name"), 500);
  assert.equal(widthOf(parseColumns(serialiseColumns(setWidth(s, "name", 500))), "name"), 500);
});

test("resizing one column leaves every other width untouched", () => {
  const s = resetColumns();
  const r = setWidth(s, "size", 180);
  assert.equal(widthOf(r, "size"), 180);
  assert.equal(widthOf(r, "name"), widthOf(s, "name"));
  assert.equal(widthOf(r, "mtime"), widthOf(s, "mtime"));
  assert.deepEqual(r.widths, { size: 180 });
});

test("widths respect each column's minimum", () => {
  for (const c of COLUMNS) assert.equal(clampWidth(c.id, 1), c.min, c.id);
  assert.equal(widthOf(setWidth(resetColumns(), "name", 10), "name"), 160);
});

test("older saves (Name flexible, no stored width, or with legacy fields) load gracefully", () => {
  const legacy = parseColumns(JSON.stringify({ widths: { size: 140 }, shown: { type: true }, extra: 1 }));
  assert.equal(widthOf(legacy, "name"), 280);
  assert.equal(widthOf(legacy, "size"), 140);
  assert.deepEqual(visibleColumns(legacy).map((c) => c.id), ["name", "type", "size", "mtime"]);
  assert.equal(totalWidth(legacy), 280 + 110 + 140 + 160);
});

test("the table width is the sum of the visible column widths, so widening one grows it by the same amount", () => {
  assert.equal(totalWidth(resetColumns()), 280 + 100 + 160);
  assert.equal(totalWidth(setWidth(resetColumns(), "name", 600)), 600 + 100 + 160);
  assert.equal(totalWidth(setWidth(resetColumns(), "name", 400)) - totalWidth(resetColumns()), 120);
});

test("header alignment: only Size is right aligned", () => {
  assert.deepEqual(COLUMNS.filter((c) => c.align === "end").map((c) => c.id), ["size"]);
});
