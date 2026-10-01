#!/usr/bin/env node
// Test stand-in for `smbclient`: speaks the subset filedeck uses (ls, get, put, mkdir, rmdir, del, rename) over a
// local directory, printing the same text real smbclient does (formats checked against Samba 4.24).
// Env: FAKE_SMB_ROOT (share directory), FAKE_SMB_USER, FAKE_SMB_PASSWORD (checked against -U and $PASSWD).
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const root = process.env.FAKE_SMB_ROOT;
const user = opt("-U");
if (user !== process.env.FAKE_SMB_USER || process.env.PASSWD !== process.env.FAKE_SMB_PASSWORD) {
  process.stderr.write("session setup failed: NT_STATUS_LOGON_FAILURE\n");
  process.exit(1);
}
const cmds = String(opt("-c") ?? "");
const split = (s) => [...s.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
const [verb, ...args] = split(cmds);
const real = (p) => {
  const r = path.join(root, ...p.split("\\").filter(Boolean));
  if (!(r === root || r.startsWith(root + path.sep))) throw new Error("escape");
  return r;
};
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const date = (d) =>
  `${DAY[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${[d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map((n) => String(n).padStart(2, "0")).join(":")} ${d.getUTCFullYear()}`;
const line = (name, st) => `  ${name.padEnd(30)}  ${(st.isDirectory() ? "D" : name.startsWith(".") ? "AH" : "N").padStart(1).padEnd(6)} ${String(st.isDirectory() ? 0 : st.size).padStart(8)}  ${date(st.mtime)}\n`;
const fail = (status, ctx, code = 1) => {
  process.stdout.write(`${status} ${ctx}\n`);
  process.exit(code);
};
const tail = "\n\t\t1000 blocks of size 1024. 500 blocks available\n";

try {
  if (verb === "ls" || verb === undefined) {
    const a = args[0] ?? "*";
    if (a === "*" || a.endsWith("\\*")) {
      const dir = real(a === "*" ? "" : a.slice(0, -2));
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        fail("NT_STATUS_OBJECT_NAME_NOT_FOUND", `listing \\${a}`);
      }
      const st = fs.statSync(dir);
      let out = line(".", st) + line("..", st);
      for (const n of names) out += line(n, fs.statSync(path.join(dir, n)));
      process.stdout.write(out + tail);
    } else {
      let st;
      try {
        st = fs.statSync(real(a));
      } catch {
        fail("NT_STATUS_NO_SUCH_FILE", `listing \\${a}`);
      }
      process.stdout.write(line(path.basename(real(a)), st) + tail);
    }
  } else if (verb === "get") {
    const p = real(args[0]);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      fail("NT_STATUS_OBJECT_NAME_NOT_FOUND", `opening remote file \\${args[0]}`);
    }
    if (st.isDirectory()) fail("NT_STATUS_FILE_IS_A_DIRECTORY", `opening remote file \\${args[0]}`);
    process.stderr.write(`getting file \\${args[0]} of size ${st.size} as - (1.0 KiloBytes/sec) (average inf KiloBytes/sec)\n`);
    const rs = fs.createReadStream(p);
    rs.on("data", (c) => process.stdout.write(c));
    rs.on("end", () => process.stdout.write("", () => process.exit(0))); // exit only once stdout has been flushed
    await new Promise(() => undefined);
  } else if (verb === "put") {
    const dst = real(args[1]);
    if (!fs.existsSync(path.dirname(dst))) fail("NT_STATUS_OBJECT_PATH_NOT_FOUND", `opening remote file \\${args[1]}`);
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    fs.writeFileSync(dst, Buffer.concat(chunks));
    process.stdout.write(`putting file ${args[0]} as \\${args[1]} (1.0 kB/s) (average 1.0 kB/s)\n`);
  } else if (verb === "mkdir") {
    const p = real(args[0]);
    if (fs.existsSync(p)) fail("NT_STATUS_OBJECT_NAME_COLLISION", `making remote directory \\${args[0]}`, 0);
    if (!fs.existsSync(path.dirname(p))) fail("NT_STATUS_OBJECT_PATH_NOT_FOUND", `making remote directory \\${args[0]}`, 0);
    fs.mkdirSync(p);
  } else if (verb === "rmdir") {
    const p = real(args[0]);
    if (!fs.existsSync(p)) fail("NT_STATUS_OBJECT_NAME_NOT_FOUND", `removing remote directory file \\${args[0]}`, 0);
    if (fs.readdirSync(p).length) fail("NT_STATUS_DIRECTORY_NOT_EMPTY", `removing remote directory file \\${args[0]}`, 0);
    fs.rmdirSync(p);
  } else if (verb === "del") {
    const p = real(args[0]);
    if (!fs.existsSync(p)) fail("NT_STATUS_NO_SUCH_FILE", `listing \\${args[0]}`);
    fs.unlinkSync(p);
  } else if (verb === "rename") {
    const [a, b] = [real(args[0]), real(args[1])];
    if (!fs.existsSync(a)) fail("NT_STATUS_OBJECT_NAME_NOT_FOUND", `renaming files \\${args[0]} -> \\${args[1]} `);
    if (fs.existsSync(b)) fail("NT_STATUS_OBJECT_NAME_COLLISION", `renaming files \\${args[0]} -> \\${args[1]} `);
    fs.renameSync(a, b);
  } else {
    fail("NT_STATUS_NOT_SUPPORTED", verb);
  }
} catch (e) {
  process.stdout.write(`NT_STATUS_INTERNAL_ERROR ${e.code ?? e.message}\n`);
  process.exit(1);
}
