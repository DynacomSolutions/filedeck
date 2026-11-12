import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CHUNK_ROWS, CHUNK_TILE_ROWS, OVERSCAN_ROWS, OVERSCAN_TILE_ROWS, scrollTopFor, spacerHeight, windowFor, type Geometry } from "../src/listWindow.ts";

const list: Geometry = { offset: 100, pitch: 30, perRow: 1 };
const opts = { overscan: OVERSCAN_ROWS, chunk: CHUNK_ROWS };

test("a window at the top holds the first screen and the overscan, in whole chunks", () => {
  const w = windowFor(30000, 0, 900, list, opts);
  assert.equal(w.first, 0);
  assert.equal(w.last % CHUNK_ROWS, 0);
  assert.ok(w.last >= Math.ceil((900 - 100) / 30) + OVERSCAN_ROWS);
  assert.ok(w.last < 100, "only a screen or two of rows, never the 30,000");
});

test("scrolling moves the window and keeps the rows in view inside it", () => {
  for (const top of [0, 5000, 123456, 899000 - 900]) {
    const w = windowFor(30000, top, 900, list, opts);
    const firstVisible = Math.max(0, Math.floor((top - 100) / 30));
    const lastVisible = Math.min(29999, Math.ceil((top + 900 - 100) / 30));
    assert.ok(w.first <= firstVisible && w.last > lastVisible, `top ${top}: ${JSON.stringify(w)}`);
    assert.ok(w.last - w.first < 120, `top ${top}: ${w.last - w.first} rows`);
  }
});

test("the window never runs past the end and is not empty while there are items", () => {
  const w = windowFor(25, 100000, 900, list, opts);
  assert.ok(w.last <= 25 && w.first < w.last);
  assert.deepEqual(windowFor(0, 0, 900, list, opts), { first: 0, last: 0 });
  assert.deepEqual(windowFor(3, 0, 900, list, opts), { first: 0, last: 3 });
});

test("the window moves in whole chunks, so a few pixels of scroll do not change it", () => {
  const a = windowFor(30000, 10040, 900, list, opts);
  const b = windowFor(30000, 10040 + 30, 900, list, opts);
  assert.deepEqual(a, b);
});

test("the grid windows by rows of tiles and keeps whole rows", () => {
  const g: Geometry = { offset: 10, pitch: 150, perRow: 6 };
  const w = windowFor(30000, 40000, 900, g, { overscan: OVERSCAN_TILE_ROWS, chunk: CHUNK_TILE_ROWS });
  assert.equal(w.first % 6, 0);
  assert.ok(w.last % 6 === 0 || w.last === 30000);
  const firstVisibleRow = Math.floor((40000 - 10) / 150);
  assert.ok(w.first / 6 <= firstVisibleRow && w.last / 6 >= Math.ceil((40000 + 900 - 10) / 150));
});

test("scroll positions that show an item: least scroll, clear of a sticky header, or centred", () => {
  // item 1000 sits at 100 + 1000 * 30 = 30100, 30 high
  assert.equal(scrollTopFor(1000, 0, 900, list, 40, "nearest"), 30130 - 900);
  assert.equal(scrollTopFor(1000, 29500, 900, list, 40, "nearest"), null);
  assert.equal(scrollTopFor(1000, 30100, 900, list, 40, "nearest"), 30060); // under the 40 px header: back up by its height
  assert.equal(scrollTopFor(1000, 0, 900, list, 40, "center"), Math.round(30100 - (900 + 40 - 30) / 2));
  assert.equal(scrollTopFor(0, 5000, 900, list, 0, "center"), 0);
  // grid: item 13 of 6 per row is in row 2
  const g: Geometry = { offset: 10, pitch: 150, perRow: 6 };
  assert.equal(scrollTopFor(13, 0, 300, g, 0, "nearest"), 10 + 2 * 150 + 150 - 300);
});

test("spacers stand for the rows not rendered, less the grid gap", () => {
  assert.equal(spacerHeight(0, 30), 0);
  assert.equal(spacerHeight(1000, 30), 30000);
  assert.equal(spacerHeight(4, 150, 8), 592);
});

const panel = readFileSync(new URL("../src/FilePanel.tsx", import.meta.url), "utf8");

test("the panel renders a window of the listing, not a growing prefix", () => {
  assert.doesNotMatch(panel, /RENDER_STEP|IntersectionObserver|setLimit|more-tiles/);
  assert.match(panel, /const rowsShown = dataTo > dataFrom \? visible\.slice\(dataFrom, dataTo\) : \[\];/);
  assert.match(panel, /onScroll=\{onListScroll\}/);
  assert.match(panel, /<tr data-wtop role="row" aria-hidden="true"/);
});

test("rows carry their position in the whole listing, since most of it is not in the DOM", () => {
  assert.match(panel, /"aria-rowindex": index \+ 2/);
  assert.match(panel, /"aria-setsize": visible\.length, "aria-posinset": index \+ 1/);
  assert.match(panel, /"aria-rowcount": visible\.length \+ 1/);
  const cols = readFileSync(new URL("../src/Columns.tsx", import.meta.url), "utf8");
  assert.match(cols, /aria-rowindex=\{1\}/);
});

test("selection, ranges, type-ahead and select all still work on the filtered listing, not on the rendered rows", () => {
  assert.match(panel, /const a = visible\.findIndex\(\(x\) => x\.path === anchor\);/);
  assert.match(panel, /selectAllPaths\(visible\)/);
  assert.match(panel, /typeAheadMatch\(visible, cursor, key,/);
});
