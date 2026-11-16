import { test } from "node:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { freePort, listening } from "./local-server.ts";
import { defineSourceSuite } from "./source-suite.ts";

/**
 * Runs the shared source suite against a real WebDAV server: Apache httpd with mod_dav and basic authentication.
 * webdav.test.ts runs the same suite against the in-process test server, so this file is what shows that the WebDAV source works
 * with a server people really use.
 *
 * The server is started as the user that runs the tests, on a loopback port, with a configuration, a password file and a lock
 * database of its own in a temporary folder; nothing of the machine's own web server set-up is read or changed.
 *
 * Skipped where there is no Apache with mod_dav, and as root (the files it serves would then belong to another user than the one
 * the suite inspects them as). FILEDECK_REQUIRE_APACHE=1 turns the "no Apache" skip into a failure; CI sets it in the unprivileged pass.
 */
const PASSWORD = "dav-apache-s3cret";
const httpd = ["/usr/sbin/apache2", "/usr/bin/httpd", "/usr/sbin/httpd", "/usr/local/sbin/httpd"].find((p) => fs.existsSync(p));
const modules = ["/usr/lib/apache2/modules", "/usr/lib/httpd/modules", "/usr/lib64/httpd/modules", "/usr/libexec/apache2"].find((d) => fs.existsSync(path.join(d, "mod_dav_fs.so")));
const isRoot = process.getuid?.() === 0;

if (isRoot) {
  test("webdav apache: skipped (running as root)", { skip: true }, () => undefined);
} else if (!httpd || !modules) {
  if (process.env.FILEDECK_REQUIRE_APACHE === "1")
    test("webdav apache: Apache is required here", () => {
      throw new Error("FILEDECK_REQUIRE_APACHE=1 but no Apache httpd with mod_dav was found");
    });
  else test("webdav apache: skipped (no Apache with mod_dav here)", { skip: true }, () => undefined);
} else {
  defineSourceSuite("webdav", async (tmp, secrets) => {
    const dav = path.join(tmp, "dav");
    const etc = path.join(tmp, "httpd");
    fs.mkdirSync(path.join(dav, "share"), { recursive: true });
    fs.mkdirSync(etc, { mode: 0o700 });
    for (const n of ["nas", "badnas"]) {
      fs.mkdirSync(path.join(secrets, n), { recursive: true });
      fs.writeFileSync(path.join(secrets, n, "username"), "bob\n");
      fs.writeFileSync(path.join(secrets, n, "password"), (n === "nas" ? PASSWORD : "wrong-dav-pass") + "\n");
    }
    fs.writeFileSync(path.join(etc, "htpasswd"), `bob:{SHA}${createHash("sha1").update(PASSWORD).digest("base64")}\n`);
    const port = await freePort();
    // A module that this build of Apache has compiled in has no file to load.
    const load = (name: string) => (fs.existsSync(path.join(modules, `mod_${name}.so`)) ? [`LoadModule ${name}_module ${path.join(modules, `mod_${name}.so`)}`] : []);
    const conf = path.join(etc, "httpd.conf");
    fs.writeFileSync(
      conf,
      [
        `ServerRoot ${etc}`,
        `DefaultRuntimeDir ${etc}`,
        `PidFile ${path.join(etc, "httpd.pid")}`,
        `Listen 127.0.0.1:${port}`,
        "ServerName localhost",
        ...["mpm_event", "unixd", "alias", "authz_core", "authn_core", "authn_file", "auth_basic", "authz_user", "dav", "dav_fs"].flatMap(load),
        `ErrorLog ${path.join(etc, "error.log")}`,
        "LogLevel warn",
        `DavLockDB ${path.join(etc, "davlock")}`,
        `DocumentRoot ${dav}`,
        `Alias /dav ${dav}`,
        "LimitRequestBody 0",
        `<Directory ${dav}>`,
        "  Dav On",
        "  Options None",
        "  AllowOverride None",
        "  AuthType Basic",
        '  AuthName "dav"',
        `  AuthUserFile ${path.join(etc, "htpasswd")}`,
        "  Require valid-user",
        "</Directory>",
        "",
      ].join("\n"),
    );
    let log = "";
    const child = spawn(httpd, ["-D", "FOREGROUND", "-f", conf], { stdio: ["ignore", "pipe", "pipe"] });
    for (const s of [child.stdout, child.stderr]) s.on("data", (d: Buffer) => (log = (log + d.toString()).slice(-2000)));
    const errorLog = () => log + (fs.existsSync(path.join(etc, "error.log")) ? fs.readFileSync(path.join(etc, "error.log"), "utf8").slice(-2000) : "");
    await listening("Apache", port, child, errorLog);
    const host = `http://127.0.0.1:${port}/dav`;
    return {
      sources: [
        { name: "nas", type: "webdav", host, root: "/share", secretRef: "nas-creds" },
        { name: "badnas", type: "webdav", host, root: "/share", secretRef: "badnas-creds" },
      ],
      diskRoot: path.join(dav, "share"),
      leaks: [PASSWORD, "wrong-dav-pass", "bob"],
      close: async () => {
        child.kill("SIGTERM");
        await new Promise<void>((res) => (child.exitCode !== null ? res() : child.once("exit", () => res())));
      },
    };
  });
}
