import assert from "node:assert/strict";
import test from "node:test";
import { isOpenerPress, resolveOpener, swallowNextClick } from "../src/menuOpener.ts";

const el = (matches: boolean, parent?: unknown) => {
  const e: any = { matches: () => matches, closest: (s: string) => (matches ? e : parent ?? null), contains: (n: unknown) => n === e };
  return e as Element;
};

test("fresh primary press resolves to its closest trigger", () => {
  const btn = el(true);
  const icon: any = { closest: () => btn };
  assert.equal(resolveOpener({ target: icon, button: 0, time: 1000 }, null, 1100), btn);
});
test("right-click or non-trigger press has no opener", () => {
  const btn = el(true);
  assert.equal(resolveOpener({ target: btn, button: 2, time: 1000 }, btn, 1100), null);
  assert.equal(resolveOpener({ target: el(false), button: 0, time: 1000 }, null, 1100), null);
});
test("stale press falls back to focused trigger (keyboard open)", () => {
  (globalThis as any).document = { body: {} };
  const btn = el(true);
  assert.equal(resolveOpener({ target: el(false), button: 0, time: 0 }, btn, 5000), btn);
  assert.equal(resolveOpener(null, el(false), 5000), null);
});
test("isOpenerPress", () => {
  const b = el(true);
  assert.equal(isOpenerPress(b as Node, b as Node), true);
  assert.equal(isOpenerPress(el(false) as Node, b as Node), false);
  assert.equal(isOpenerPress(null, b as Node), false);
});
test("swallowNextClick stops one click on the opener only", () => {
  const b = el(true);
  const ls: Record<string, (e: any) => void> = {};
  const win: any = { addEventListener: (_: string, f: any) => (ls.click = f), removeEventListener: () => { delete ls.click; } };
  swallowNextClick(b, win, 50);
  let stopped = 0;
  const ev = (t: unknown) => ({ target: t, stopPropagation: () => stopped++, preventDefault: () => {} });
  ls.click!(ev(el(false)));
  assert.equal(stopped, 0);
  ls.click!(ev(b));
  assert.equal(stopped, 1);
  assert.equal(ls.click, undefined);
});
