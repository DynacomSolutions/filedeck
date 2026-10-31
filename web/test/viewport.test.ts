import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { KEYBOARD_MIN_INSET, installViewportTracking, isEditableTarget, scrollDeltaToReveal, viewportMetrics } from "../src/viewport.ts";

test("full-height viewport: no keyboard", () => {
  assert.deepEqual(viewportMetrics(667, { height: 667, offsetTop: 0 }), { height: 667, top: 0, keyboard: 0, keyboardOpen: false });
});

test("shrunk visual viewport reports the keyboard height and the usable area", () => {
  const m = viewportMetrics(844, { height: 520, offsetTop: 0 });
  assert.equal(m.height, 520);
  assert.equal(m.keyboard, 324);
  assert.ok(m.keyboardOpen);
});

test("a panned viewport (iOS) counts the offset and never goes negative", () => {
  assert.deepEqual(viewportMetrics(844, { height: 500, offsetTop: 40 }), { height: 500, top: 40, keyboard: 304, keyboardOpen: true });
  assert.equal(viewportMetrics(600, { height: 650, offsetTop: 0 }).keyboard, 0);
});

test("a small bar change (browser chrome) is not a keyboard", () => {
  assert.ok(!viewportMetrics(800, { height: 800 - (KEYBOARD_MIN_INSET - 1), offsetTop: 0 }).keyboardOpen);
});

test("scrollDeltaToReveal moves a hidden control above the keyboard into view", () => {
  assert.equal(scrollDeltaToReveal({ top: 100, bottom: 140 }, 400), 0);
  assert.equal(scrollDeltaToReveal({ top: 380, bottom: 420 }, 350), 78);
  assert.equal(scrollDeltaToReveal({ top: -30, bottom: 10 }, 350), -38);
  // taller than the area: show its top edge instead of scrolling past it
  assert.equal(scrollDeltaToReveal({ top: 20, bottom: 900 }, 300), 12);
});

test("editable targets are recognised, buttons and checkboxes are not", () => {
  const el = (sel: string[]) => ({ matches: (q: string) => sel.some((s) => q.includes(s)) }) as unknown as Element;
  assert.ok(isEditableTarget(el(["textarea"])));
  assert.ok(!isEditableTarget(el(["div"])));
  assert.ok(!isEditableTarget(null));
});

function fakeWindow(layout: number, vv: { height: number; offsetTop: number }) {
  const handlers = new Map<string, () => void>();
  const style = new Map<string, string>();
  const classes = new Set<string>();
  const root = {
    style: { setProperty: (k: string, v: string) => style.set(k, v), removeProperty: (k: string) => style.delete(k) },
    classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)), remove: (c: string) => classes.delete(c) },
  };
  const visualViewport = { ...vv, addEventListener: (n: string, f: () => void) => handlers.set(n, f), removeEventListener: (n: string) => handlers.delete(n) };
  const win = {
    innerHeight: layout,
    visualViewport,
    document: { documentElement: root, activeElement: null, addEventListener: () => {}, removeEventListener: () => {} },
    requestAnimationFrame: (cb: () => void) => (cb(), 0),
  };
  return { win, visualViewport, handlers, style, classes };
}

test("installViewportTracking publishes --vvh and kb-open as the visual viewport shrinks and recovers", () => {
  const f = fakeWindow(667, { height: 667, offsetTop: 0 });
  const stop = installViewportTracking(f.win as never);
  assert.equal(f.style.get("--vvh"), "667px");
  assert.ok(!f.classes.has("kb-open"));
  f.visualViewport.height = 350;
  f.handlers.get("resize")!();
  assert.equal(f.style.get("--vvh"), "350px");
  assert.ok(f.classes.has("kb-open"));
  f.visualViewport.height = 667;
  f.handlers.get("resize")!();
  assert.ok(!f.classes.has("kb-open"));
  stop();
  assert.equal(f.style.get("--vvh"), undefined);
  assert.equal(f.handlers.size, 0);
});

test("without a visual viewport the tracker is a no-op", () => {
  assert.doesNotThrow(() => installViewportTracking({ innerHeight: 600, document: {} } as never)());
});

test("the viewport meta asks browsers to resize content for the keyboard", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /name="viewport" content="[^"]*interactive-widget=resizes-content/);
});

test("phone layout shows one panel at a time with a switcher", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /phone && tree\.kind === "split"[\s\S]*?className="phone-tabs"/);
  const fp = readFileSync(new URL("../src/FilePanel.tsx", import.meta.url), "utf8");
  assert.match(fp, /pane && phone \? \([\s\S]*?className="fp-phonepane"/);
});

test("phone sidebar is an off-canvas drawer with focus trap, Escape and backdrop close", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /className="drawer-back" onClick=\{onCloseDrawer\}/);
  assert.match(app, /function DrawerGuard[\s\S]*?useDialogFocus\(root\)[\s\S]*?e\.key === "Escape"/);
  assert.match(app, /onOpen=\{\(n, p, h\) => \{ closeDrawer\(\); openFromSide/);
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /@media\(max-width:700px\)\{\s*\.phone-only\{display:inline-flex\}[\s\S]*?\.side\{position:fixed;[^}]*translateX\(-102%\)/);
});

test("the editor pane has no second close button that would drop unsaved edits", () => {
  const fp = readFileSync(new URL("../src/FilePanel.tsx", import.meta.url), "utf8");
  assert.match(fp, /\{!gitDiff && !editing && \(\s*<Tip label=\{propsOpen && !editing/);
});

test("phone selection bar scrolls instead of clipping, and Clear is pinned", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.selbar\{overflow-x:auto;/);
  assert.match(css, /\.selbar-actions \.tip:last-child\{position:sticky;right:0/);
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /className="hide-phone" onClick/);
  assert.match(app, /phone-only side-set" aria-label="Keyboard shortcuts"/);
});
