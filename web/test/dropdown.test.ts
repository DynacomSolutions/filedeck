import assert from "node:assert/strict";
import test from "node:test";
import { shouldCloseOnOutside } from "../src/Dropdown.tsx";

// Minimal Node stand-ins: contains() mirrors the DOM semantics the helper relies on.
const node = (...kids: unknown[]) => ({ contains: (n: unknown) => n === undefined ? false : kids.includes(n) }) as unknown as Node;

test("a pointerdown on the trigger never closes the menu (the click handler toggles it)", () => {
  const trigger = { contains: (n: unknown) => n === trigger } as unknown as Node;
  const menu = node();
  assert.equal(shouldCloseOnOutside(trigger, menu, trigger), false);
});

test("a pointerdown inside the menu keeps it open, anywhere else closes it", () => {
  const item = {} as Node;
  const menu = { contains: (n: unknown) => n === item || n === menu } as unknown as Node;
  const trigger = { contains: (n: unknown) => n === trigger } as unknown as Node;
  assert.equal(shouldCloseOnOutside(item, menu, trigger), false);
  assert.equal(shouldCloseOnOutside({} as Node, menu, trigger), true);
  assert.equal(shouldCloseOnOutside(null, menu, trigger), false);
});
