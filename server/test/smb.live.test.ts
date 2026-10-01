import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { defineSourceSuite } from "./source-suite.ts";

/**
 * Runs the shared suite against a real SMB server through the real `smbclient`.
 * Skipped unless FILEDECK_TEST_SMB is set to JSON {"host","share","user","pass","dir"} where `dir` is the
 * share's directory on this machine (so the suite can inspect files). See smb.test.ts for the CI variant.
 */
const live = process.env.FILEDECK_TEST_SMB;
if (!live) {
  test("smb live: skipped (FILEDECK_TEST_SMB not set)", { skip: true }, () => undefined);
} else {
  const c = JSON.parse(live) as { host: string; share: string; user: string; pass: string; dir: string };
  defineSourceSuite("smb", async (_tmp, secrets) => {
    fs.mkdirSync(path.join(c.dir, "share"), { recursive: true });
    for (const n of ["nas", "badnas"]) {
      fs.mkdirSync(path.join(secrets, n), { recursive: true });
      fs.writeFileSync(path.join(secrets, n, "username"), c.user + "\n");
      fs.writeFileSync(path.join(secrets, n, "password"), (n === "nas" ? c.pass : "wrong-smb-pass") + "\n");
    }
    const base = { type: "smb", host: c.host, root: "/share", options: { share: c.share } };
    return {
      sources: [
        { name: "nas", ...base, secretRef: "nas-creds" },
        { name: "badnas", ...base, secretRef: "badnas-creds" },
      ],
      diskRoot: path.join(c.dir, "share"),
      leaks: [c.pass, "wrong-smb-pass", c.user],
      close: async () => {
        try {
          fs.rmSync(path.join(c.dir, "share"), { recursive: true, force: true });
        } catch {
          /* files created by the server's user may not be removable by this one */
        }
      },
    };
  });
}
