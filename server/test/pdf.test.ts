import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createAgent } from "../src/agent.ts";
import { createHub } from "../src/hub.ts";
import { loadConfig } from "../src/config.ts";
import { qpdf } from "../src/pdf.ts";

const HAVE = spawnSync(qpdf(), ["--version"]).status === 0;
const need = { skip: HAVE ? false : "qpdf not installed" };
const SECRET = "pdf-secret-Ünï-123"; // AES-256 (R6) PDFs take UTF-8 passwords
const SECRET128 = "pdf-secret-ascii-123"; // the older 128-bit scheme is Latin/ASCII only
const KEY = "0123456789abcdef0123456789abcdef-pdf-test";

/** True when `pdf` opens with no password and its page text contains the marker (qpdf recompresses streams, so look at a QDF copy). */
function readableWithoutPassword(pdf: Buffer): boolean {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-pdfchk-")), "copy.pdf");
  try {
    fs.writeFileSync(f, pdf);
    if (spawnSync(qpdf(), ["--is-encrypted", f]).status !== 2) return false; // 2 = not encrypted
    const q = spawnSync(qpdf(), ["--qdf", "--object-streams=disable", f, "-"]);
    return (q.status === 0 || q.status === 3) && q.stdout.includes("Filedeck secret PDF");
  } finally {
    fs.rmSync(path.dirname(f), { recursive: true, force: true });
  }
}

/** A minimal one-page PDF whose text stream is uncompressed. */
function plainPdf(): Buffer {
  const stream = "BT /F1 24 Tf 20 60 Td (Filedeck secret PDF) Tj ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

let dir: string;
let root: string;
const servers: ReturnType<typeof serve>[] = [];
const open = (app: { fetch: unknown }) =>
  new Promise<ReturnType<typeof serve>>((res) => {
    const s: ReturnType<typeof serve> = serve({ fetch: app.fetch as never, port: 0 }, () => res(s));
    servers.push(s);
  });
const url = (s: ReturnType<typeof serve>) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
const b64 = (s: string) => Buffer.from(s).toString("base64");
const enc = encodeURIComponent;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-pdf-"));
  root = path.join(dir, "root");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  if (!HAVE) return;
  const plain = path.join(root, "docs/plain.pdf");
  fs.writeFileSync(plain, plainPdf());
  const mk = (name: string, user: string, bits: string) => {
    const r = spawnSync(qpdf(), [...(bits === "128" ? ["--allow-weak-crypto"] : []), "--encrypt", user, "owner-pw", bits, "--", plain, path.join(root, "docs", name)]);
    assert.equal(r.status, 0, String(r.stderr));
  };
  mk("locked256.pdf", SECRET, "256");
  mk("locked128.pdf", SECRET128, "128");
  mk("owner-only.pdf", "", "256");
});
after(() => {
  for (const s of servers) s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("agent: plain, locked and owner-only PDFs; wrong and right passwords", need, async () => {
  const agent = url(await open(createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t" } as never))));
  const st = (p: string, pw?: string) => fetch(`${agent}/api/pdf/status?path=${enc(p)}`, { headers: pw ? { "x-filedeck-password": b64(pw) } : {} });
  assert.deepEqual(await (await st("/docs/plain.pdf")).json(), { encrypted: false, locked: false });
  assert.deepEqual(await (await st("/docs/owner-only.pdf")).json(), { encrypted: true, locked: false });
  for (const [f, pw] of [["locked256.pdf", SECRET], ["locked128.pdf", SECRET128]] as const) {
    const none = await st(`/docs/${f}`);
    assert.deepEqual(await none.json(), { encrypted: true, locked: true });
    const wrong = await st(`/docs/${f}`, "nope");
    assert.equal(wrong.status, 401);
    assert.equal(((await wrong.json()) as { code: string }).code, "password_incorrect");
    const ok = await st(`/docs/${f}`, pw);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("x-filedeck-pw"), "ok");
    assert.deepEqual(await ok.json(), { encrypted: true, locked: false });
    // decrypted copy: needs the password, then is a readable, unencrypted PDF
    const d0 = await fetch(`${agent}/api/pdf/decrypted?path=${enc(`/docs/${f}`)}`);
    assert.equal(d0.status, 401);
    const d = await fetch(`${agent}/api/pdf/decrypted?path=${enc(`/docs/${f}`)}`, { headers: { "x-filedeck-password": b64(pw) } });
    assert.equal(d.status, 200);
    assert.equal(d.headers.get("content-type"), "application/pdf");
    const body = Buffer.from(await d.arrayBuffer());
    assert.ok(body.subarray(0, 5).toString() === "%PDF-" && readableWithoutPassword(body));
  }
  // a password given for a PDF that does not need one is not "used"
  const free = await st("/docs/plain.pdf", SECRET);
  assert.equal(free.headers.get("x-filedeck-pw"), null);
  assert.equal((await fetch(`${agent}/api/pdf/status?path=${enc("/docs/nothing.pdf")}`)).status, 404);
});

test("hub: typed PDF password is saved server-side, the viewer URL needs none, forget locks it again", need, async () => {
  const agentSrv = await open(createAgent(loadConfig({ FILEDECK_ROOT: root, FILEDECK_NODE: "t" } as never)));
  const audits: string[] = [];
  const hub = createHub(loadConfig({ FILEDECK_MODE: "hub", NODES: `t=${url(agentSrv)}`, FILEDECK_STATIC: dir, FILEDECK_VAULT_KEY: KEY, FILEDECK_VAULT_FILE: path.join(dir, "hub", "vault.sqlite") } as never), undefined, (l) => audits.push(l));
  const base = url(await open(hub));
  const p = "/docs/locked256.pdf";
  const status = (h: Record<string, string> = {}) => fetch(`${base}/api/nodes/t/api/pdf/status?path=${enc(p)}`, { headers: h });
  const decrypted = () => fetch(`${base}/api/nodes/t/api/pdf/decrypted?path=${enc(p)}`);

  assert.equal(((await (await status()).json()) as { locked: boolean }).locked, true);
  assert.equal((await decrypted()).status, 401);
  assert.equal((await status({ "x-filedeck-password": b64("wrong") })).status, 401);
  assert.equal(hub.vault.list().length, 0, "a wrong password is not saved");

  const ok = await status({ "x-filedeck-password": b64(SECRET), "x-filedeck-save": "forever" });
  assert.equal(ok.status, 200);
  assert.equal(hub.vault.list().length, 1);
  assert.equal(hub.vault.list()[0]!.remembered, true);

  // what the iframe does: a plain GET with no headers at all
  const d = await decrypted();
  assert.equal(d.status, 200);
  const body = Buffer.from(await d.arrayBuffer());
  assert.ok(readableWithoutPassword(body));
  const again = await status();
  assert.equal(again.headers.get("x-filedeck-pw-source"), "saved");

  assert.ok(!(audits.join("\n") + JSON.stringify(hub.vault.list())).includes(SECRET));
  assert.deepEqual(await (await fetch(`${base}/api/vault/forget`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ node: "t", path: p }) })).json(), { removed: 1 });
  assert.equal((await decrypted()).status, 401);
  await hub.close();
});
