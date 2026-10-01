import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineSourceSuite } from "./source-suite.ts";

const PASS = "smb-s3cret-pass";
const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-smbclient.mjs");

// The shared suite against the SMB backend with a stand-in `smbclient` (CI has no Samba). smb.live.test.ts runs
// the same suite against real smbclient and a real Samba server when FILEDECK_TEST_SMB is set.
defineSourceSuite("smb", async (tmp, secrets) => {
  const dir = path.join(tmp, "smbshare");
  fs.mkdirSync(path.join(dir, "share"), { recursive: true });
  for (const n of ["nas", "badnas"]) {
    fs.mkdirSync(path.join(secrets, n), { recursive: true });
    fs.writeFileSync(path.join(secrets, n, "username"), "carol\n");
    fs.writeFileSync(path.join(secrets, n, "password"), (n === "nas" ? PASS : "wrong-smb-pass") + "\n");
  }
  const env = { FILEDECK_SMBCLIENT: process.env.FILEDECK_SMBCLIENT, FAKE_SMB_ROOT: dir, FAKE_SMB_USER: "carol", FAKE_SMB_PASSWORD: PASS };
  process.env.FILEDECK_SMBCLIENT = fake;
  Object.assign(process.env, { FAKE_SMB_ROOT: dir, FAKE_SMB_USER: "carol", FAKE_SMB_PASSWORD: PASS });
  const base = { type: "smb", host: "smb.test", root: "/share", options: { share: "data" } };
  return {
    sources: [
      { name: "nas", ...base, secretRef: "nas-creds" },
      { name: "badnas", ...base, secretRef: "badnas-creds" },
    ],
    diskRoot: path.join(dir, "share"),
    leaks: [PASS, "wrong-smb-pass", "carol"],
    close: async () => {
      if (env.FILEDECK_SMBCLIENT === undefined) delete process.env.FILEDECK_SMBCLIENT;
      else process.env.FILEDECK_SMBCLIENT = env.FILEDECK_SMBCLIENT;
      for (const k of ["FAKE_SMB_ROOT", "FAKE_SMB_USER", "FAKE_SMB_PASSWORD"]) delete process.env[k];
    },
  };
});
