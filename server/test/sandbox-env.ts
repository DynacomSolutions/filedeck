import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetSandbox, sandboxInfo } from "../src/sandbox.ts";

/**
 * Builds the native confinement helper (server/native/filedeck-sandbox.c) with `cc` and points `FILEDECK_SANDBOX_HELPER` at it,
 * then says which way Git runs here: "landlock" (confined by the kernel) or "fallback" (this kernel has no Landlock, or
 * the helper could not be built). `FILEDECK_REQUIRE_SANDBOX=1` makes a missing compiler or a missing Landlock an error
 * (the image build and CI set it where the kernel has Landlock).
 */
export async function useSandbox(): Promise<{ state: "landlock" | "fallback"; dir: string; bin: string; staticBin: string | null; why: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "filedeck-sandbox-"));
  const bin = path.join(dir, "filedeck-sandbox");
  const src = path.resolve(import.meta.dirname, "../native/filedeck-sandbox.c");
  const tries = ["cc", "gcc"].map((c) => spawnSync(c, ["-O2", "-Wall", "-o", bin, src], { encoding: "utf8" }));
  const cc = tries.find((t) => t.status === 0) ?? tries[0]!;
  let why = "";
  if (cc.status !== 0) {
    why = `helper not built: ${cc.error?.message ?? cc.stderr.trim().split("\n")[0]}`;
    process.env.FILEDECK_SANDBOX_HELPER = path.join(dir, "missing");
  } else process.env.FILEDECK_SANDBOX_HELPER = bin;
  delete process.env.FILEDECK_SANDBOX;
  resetSandbox();
  const info = await sandboxInfo();
  if (info.state !== "landlock" && !why) why = "Landlock is not usable on this kernel";
  if (process.env.FILEDECK_REQUIRE_SANDBOX && info.state !== "landlock") throw new Error(`sandbox required but not usable: ${why}`);
  console.log(`# sandbox mode: ${info.state}${why ? ` (${why})` : ""}`);
  // a statically linked copy for the tests that need the launcher to run with almost no descriptors (a dynamic loader needs one)
  const staticPath = path.join(dir, "filedeck-sandbox-static");
  const st = spawnSync("cc", ["-O2", "-static", "-o", staticPath, src], { encoding: "utf8" });
  const staticBin = st.status === 0 ? staticPath : null;
  if (!staticBin && process.env.FILEDECK_REQUIRE_SANDBOX) throw new Error(`static build of the launcher required: ${st.stderr.trim().split("\n")[0]}`);
  return { state: info.state === "landlock" ? "landlock" : "fallback", dir, bin, staticBin, why };
}

/**
 * For tests that are not about the sandbox but use Git on repositories made in a temporary folder (which may be owned by root
 * and not world-readable, as when the suite runs as root): the real sandbox where the kernel has Landlock, otherwise the sandbox
 * off, since the fallback would refuse such repositories.
 */
export async function useSandboxOrOff(): Promise<void> {
  const box = await useSandbox();
  if (box.state !== "landlock") {
    process.env.FILEDECK_SANDBOX = "off";
    resetSandbox();
  }
}
