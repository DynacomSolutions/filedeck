import { test } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { freePort, listening } from "./local-server.ts";
import { defineSourceSuite } from "./source-suite.ts";

/**
 * Runs the shared source suite against a real OpenSSH server (`sshd` with its own `internal-sftp`), with key authentication.
 * sources.test.ts runs the same suite against the in-process test server with a password, so this file is what shows that the
 * SFTP source works with the server most people use.
 *
 * The server is started as the user that runs the tests, on a loopback port, with a host key, a configuration and an
 * `authorized_keys` file of its own in a temporary folder; nothing of the machine's own SSH set-up is read or changed.
 *
 * Skipped where there is no `sshd`, and as root (an `sshd` started by root needs its privilege separation user and folder, which a
 * test must not create). FILEDECK_REQUIRE_SSHD=1 turns the "no sshd" skip into a failure; CI sets it in the unprivileged pass, whose
 * skip gate (scripts/check-test-skips.mjs) does not allow either skip.
 */
const sshd = ["/usr/sbin/sshd", "/usr/bin/sshd", "/usr/local/sbin/sshd"].find((p) => fs.existsSync(p));
const keygen = ["/usr/bin/ssh-keygen", "/usr/local/bin/ssh-keygen"].find((p) => fs.existsSync(p));
const isRoot = process.getuid?.() === 0;

if (isRoot) {
  test("sftp openssh: skipped (running as root)", { skip: true }, () => undefined);
} else if (!sshd || !keygen) {
  if (process.env.FILEDECK_REQUIRE_SSHD === "1")
    test("sftp openssh: sshd is required here", () => {
      throw new Error("FILEDECK_REQUIRE_SSHD=1 but no sshd or ssh-keygen was found");
    });
  else test("sftp openssh: skipped (no sshd here)", { skip: true }, () => undefined);
} else {
  defineSourceSuite("sftp", async (tmp, secrets) => {
    const remote = path.join(tmp, "remote");
    const etc = path.join(tmp, "sshd");
    fs.mkdirSync(path.join(remote, "share"), { recursive: true });
    fs.mkdirSync(etc, { mode: 0o700 });
    const key = (name: string) => {
      const file = path.join(etc, name);
      execFileSync(keygen, ["-q", "-t", "ed25519", "-N", "", "-C", "filedeck-test", "-f", file], { stdio: "ignore" });
      return file;
    };
    const hostKey = key("host");
    const good = key("good");
    const bad = key("bad"); // a valid key the server does not know
    fs.copyFileSync(good + ".pub", path.join(etc, "authorized_keys"));
    fs.chmodSync(path.join(etc, "authorized_keys"), 0o600);
    const user = os.userInfo().username;
    for (const [n, k] of [["nas", good], ["badnas", bad]] as const) {
      fs.mkdirSync(path.join(secrets, n), { recursive: true });
      fs.writeFileSync(path.join(secrets, n, "username"), user + "\n");
      fs.writeFileSync(path.join(secrets, n, "privateKey"), fs.readFileSync(k));
    }
    const port = await freePort();
    const conf = path.join(etc, "sshd_config");
    fs.writeFileSync(
      conf,
      [
        `Port ${port}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${hostKey}`,
        `PidFile ${path.join(etc, "sshd.pid")}`,
        `AuthorizedKeysFile ${path.join(etc, "authorized_keys")}`,
        "PubkeyAuthentication yes",
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "UsePAM no",
        "StrictModes no",
        "Subsystem sftp internal-sftp",
        "MaxStartups 100:30:200",
        "MaxSessions 100",
        "LogLevel ERROR",
        "",
      ].join("\n"),
    );
    let log = "";
    const child = spawn(sshd, ["-D", "-e", "-f", conf], { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", (d: Buffer) => (log = (log + d.toString()).slice(-2000)));
    await listening("sshd", port, child, () => log);
    const privateKeyBodies = [good, bad].map((k) => fs.readFileSync(k, "utf8").split("\n")[1]!);
    // A real server shows the files under their real path, so the source's root is the folder itself.
    const base = { type: "sftp", host: `127.0.0.1:${port}`, root: path.join(remote, "share") };
    return {
      sources: [
        { name: "nas", ...base, secretRef: "nas-creds" },
        { name: "badnas", ...base, secretRef: "badnas-creds" },
      ],
      diskRoot: path.join(remote, "share"),
      // The user name is not in this list: here it is also the owner of every file and of the temporary folder.
      leaks: privateKeyBodies,
      close: async () => {
        child.kill("SIGTERM");
        await new Promise<void>((res) => (child.exitCode !== null ? res() : child.once("exit", () => res())));
      },
    };
  });
}
