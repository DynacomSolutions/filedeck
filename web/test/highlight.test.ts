import assert from "node:assert/strict";
import { test } from "node:test";
import { fallbackLanguage, fenceLanguage, isTextName } from "../src/highlight";

const langs = [
  { id: "json", aliases: ["JSON", "json"] },
  { id: "shell", aliases: ["Shell Script", "shell", "bash", "sh", "zsh"] },
  { id: "typescript", aliases: ["TypeScript", "ts", "typescript"] },
  { id: "yaml", aliases: ["YAML", "yaml"] },
  { id: "ini", aliases: ["Ini", "ini"] },
  { id: "plaintext", aliases: ["Plain Text", "text"] },
];

test("fence info strings map to language ids", () => {
  assert.equal(fenceLanguage("json", langs), "json");
  assert.equal(fenceLanguage("bash", langs), "shell");
  assert.equal(fenceLanguage("bash", [{ id: "shell", aliases: ["Shell", "sh"] }]), "shell");
  assert.equal(fenceLanguage("BASH title=x", langs), "shell");
  assert.equal(fenceLanguage("ts", langs), "typescript");
  assert.equal(fenceLanguage("{.yaml}", langs), "yaml");
  assert.equal(fenceLanguage("language-json", langs), "json");
  assert.equal(fenceLanguage("yml", langs), "yaml");
  assert.equal(fenceLanguage("jsonc", langs), "json");
  assert.equal(fenceLanguage("console", langs), "shell");
  assert.equal(fenceLanguage("klingon", langs), undefined);
  assert.equal(fenceLanguage("", langs), undefined);
});

test("text decision by name", () => {
  for (const n of ["/a/x.json", "Dockerfile", "/p/Makefile", "a.JSONC", "x.mjs", "q.scss", ".gitignore", ".editorconfig", ".env", ".env.local", "a.ps1", "b.proto", "s.sql"]) assert.equal(isTextName(n), true, n);
  for (const n of ["a.exe", "photo.png", "noext", "archive.zip"]) assert.equal(isTextName(n), false, n);
});

test("fallback languages", () => {
  assert.equal(fallbackLanguage("x.jsonc"), "json");
  assert.equal(fallbackLanguage(".env.production"), "ini");
  assert.equal(fallbackLanguage("a.txt"), undefined);
});
