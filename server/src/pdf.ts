import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { Readable, type Writable } from "node:stream";
import type { Hono, Context } from "hono";
import { FsError } from "./fsops.ts";
import { assertNotTrash, resolveRead } from "./paths.ts";
import { PasswordError, passwordFromHeader } from "./sevenzip.ts";
import type { Config } from "./config.ts";

/**
 * Password-protected PDFs. qpdf (a `--password-file=-` read from stdin, so the
 * password is never on a command line) answers "is it encrypted / does it need
 * a password" and writes a decrypted copy to the response stream. The browser's
 * own PDF viewer then renders that stream: the password stays on the server.
 */

export const qpdf = () => process.env.FILEDECK_QPDF || "qpdf";

function run(args: string[], file: string, password: string | undefined, stream: boolean, signal?: AbortSignal): Promise<{ code: number | null }> & { out: Readable } {
  const child = spawn(qpdf(), [...(password ? ["--password-file=-"] : []), ...args, file, ...(stream ? ["-"] : [])], { stdio: ["pipe", "pipe", "ignore"] });
  const stdin = child.stdin as Writable;
  stdin.on("error", () => undefined);
  stdin.end(password ? password + "\n" : "");
  const kill = () => {
    child.kill("SIGKILL");
    child.stdout?.destroy();
  };
  if (signal) {
    if (signal.aborted) kill();
    else signal.addEventListener("abort", kill, { once: true });
  }
  const done = new Promise<{ code: number | null }>((resolve) => {
    child.on("error", (e) => resolve({ code: (e as NodeJS.ErrnoException).code === "ENOENT" ? -1 : -2 }));
    child.on("close", (code) => resolve({ code }));
  });
  const p = done as Promise<{ code: number | null }> & { out: Readable };
  p.out = child.stdout as Readable;
  if (!stream) (child.stdout as Readable).resume();
  return p;
}

const need = (code: number | null) => {
  if (code === -1) throw new FsError(501, "PDF tools are not installed in this image");
};

export interface PdfStatus {
  encrypted: boolean;
  /** encrypted and a password is required to open it */
  locked: boolean;
  /** true when the supplied password was needed and is right */
  passwordUsed: boolean;
}

export async function pdfStatus(real: string, password: string | undefined): Promise<PdfStatus> {
  const enc = (await run(["--is-encrypted"], real, undefined, false)).code;
  need(enc);
  if (enc !== 0) return { encrypted: false, locked: false, passwordUsed: false };
  // 0 = a password is required, 3 = the file opens (empty user password, or the right password was supplied)
  const bare = (await run(["--requires-password"], real, undefined, false)).code;
  if (bare === 3) return { encrypted: true, locked: false, passwordUsed: false };
  if (!password) return { encrypted: true, locked: true, passwordUsed: false };
  const withPw = (await run(["--requires-password"], real, password, false)).code;
  if (withPw === 3) return { encrypted: true, locked: false, passwordUsed: true };
  if (withPw === 0) throw new PasswordError("password_incorrect", "wrong password");
  throw new FsError(400, "cannot read this PDF");
}

export function registerPdfRoutes(app: Hono, cfg: Config) {
  const pw = (c: Context) => passwordFromHeader(c.req.header("x-filedeck-password"));
  const target = async (c: Context) => {
    const r = resolveRead(cfg.root, c.req.query("path") ?? "");
    assertNotTrash(r.virtual);
    const st = await fs.stat(r.real);
    if (!st.isFile()) throw new FsError(400, "not a regular file");
    return r;
  };

  app.get("/api/pdf/status", async (c) => {
    const r = await target(c);
    const s = await pdfStatus(r.real, pw(c));
    return c.json({ encrypted: s.encrypted, locked: s.locked }, 200, s.passwordUsed ? { "x-filedeck-pw": "ok" } : {});
  });

  // A decrypted copy for the viewer. Only for PDFs that need a password: the hub supplies the saved one (or the one just typed).
  app.get("/api/pdf/decrypted", async (c) => {
    const r = await target(c);
    const password = pw(c);
    const s = await pdfStatus(r.real, password);
    if (s.locked) throw new PasswordError("password_required", "this PDF is password protected");
    const proc = run(["--decrypt", "--stream-data=preserve", "--object-streams=preserve"], r.real, s.passwordUsed ? password : undefined, true, c.req.raw.signal);
    void proc.then(({ code }) => {
      if (code !== 0 && code !== 3) proc.out.destroy(new Error("qpdf failed")); // 3 = warnings only
    });
    return new Response(Readable.toWeb(proc.out) as ReadableStream, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
        "Cache-Control": "no-store",
        ...(s.passwordUsed ? { "x-filedeck-pw": "ok" } : {}),
      },
    });
  });
}
