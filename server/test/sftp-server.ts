import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import ssh2 from "ssh2";

const { Server, utils } = ssh2;
const { STATUS_CODE, OPEN_MODE } = utils.sftp;

export interface TestSftp {
  port: number;
  root: string;
  close(): Promise<void>;
}

/** Minimal in-process SFTP server over a local directory, for tests. Password auth only. */
export async function startSftp(root: string, user: string, password: string): Promise<TestSftp> {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } });
  const real = (p: string) => {
    const r = path.resolve(root, "." + path.posix.resolve("/", p));
    if (r !== root && !r.startsWith(root + path.sep)) throw Object.assign(new Error("escape"), { code: "EACCES" });
    return r;
  };
  const code = (e: unknown) => {
    const c = (e as NodeJS.ErrnoException)?.code;
    return c === "ENOENT" ? STATUS_CODE.NO_SUCH_FILE : c === "EACCES" || c === "EPERM" ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE;
  };
  const attrs = (s: fs.Stats) => ({ mode: s.mode, uid: s.uid, gid: s.gid, size: s.size, atime: Math.floor(s.atimeMs / 1000), mtime: Math.floor(s.mtimeMs / 1000) });

  const clients = new Set<{ end(): void; _sock?: { destroy(): void } }>();
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.username === user && ctx.password === password) ctx.accept();
      else ctx.reject(["password"]);
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("sftp", (acceptSftp) => {
          const sftp = acceptSftp();
          let next = 0;
          const files = new Map<string, { fd: number }>();
          const dirs = new Map<string, { names: string[]; dir: string; sent: boolean }>();
          const h = (n: number) => Buffer.from(String(n));
          const run = (reqid: number, fn: () => void) => {
            try {
              fn();
            } catch (e) {
              sftp.status(reqid, code(e));
            }
          };
          sftp.on("REALPATH", (reqid, p) => {
            const v = path.posix.resolve("/", p);
            sftp.name(reqid, [{ filename: v, longname: v, attrs: {} as never }]);
          });
          sftp.on("OPEN", (reqid, filename, flags) =>
            run(reqid, () => {
              const f = (flags & OPEN_MODE.WRITE ? (flags & OPEN_MODE.EXCL ? "wx" : flags & OPEN_MODE.TRUNC ? "w" : "r+") : "r");
              const fd = fs.openSync(real(filename), f);
              const id = String(next++);
              files.set(id, { fd });
              sftp.handle(reqid, Buffer.from(id));
            }),
          );
          sftp.on("READ", (reqid, handle, offset, length) =>
            run(reqid, () => {
              const f = files.get(handle.toString()) as { fd: number };
              const buf = Buffer.alloc(length);
              const n = fs.readSync(f.fd, buf, 0, length, offset);
              if (n === 0) sftp.status(reqid, STATUS_CODE.EOF);
              else sftp.data(reqid, buf.subarray(0, n));
            }),
          );
          sftp.on("WRITE", (reqid, handle, offset, data) =>
            run(reqid, () => {
              const f = files.get(handle.toString()) as { fd: number };
              fs.writeSync(f.fd, data, 0, data.length, offset);
              sftp.status(reqid, STATUS_CODE.OK);
            }),
          );
          sftp.on("CLOSE", (reqid, handle) => {
            const id = handle.toString();
            const f = files.get(id);
            if (f) {
              fs.closeSync(f.fd);
              files.delete(id);
            }
            dirs.delete(id);
            sftp.status(reqid, STATUS_CODE.OK);
          });
          sftp.on("FSTAT", (reqid, handle) => run(reqid, () => sftp.attrs(reqid, attrs(fs.fstatSync((files.get(handle.toString()) as { fd: number }).fd)))));
          sftp.on("FSETSTAT", (reqid) => sftp.status(reqid, STATUS_CODE.OK));
          sftp.on("SETSTAT", (reqid, p, a) =>
            run(reqid, () => {
              if (a.mtime !== undefined) fs.utimesSync(real(p), a.atime ?? a.mtime, a.mtime);
              sftp.status(reqid, STATUS_CODE.OK);
            }),
          );
          sftp.on("STAT", (reqid, p) => run(reqid, () => sftp.attrs(reqid, attrs(fs.statSync(real(p))))));
          sftp.on("LSTAT", (reqid, p) => run(reqid, () => sftp.attrs(reqid, attrs(fs.lstatSync(real(p))))));
          sftp.on("OPENDIR", (reqid, p) =>
            run(reqid, () => {
              const dir = real(p);
              const names = fs.readdirSync(dir);
              const id = String(next++);
              dirs.set(id, { names, dir, sent: false });
              sftp.handle(reqid, h(Number(id)));
            }),
          );
          sftp.on("READDIR", (reqid, handle) => {
            const d = dirs.get(handle.toString());
            if (!d || d.sent) return sftp.status(reqid, STATUS_CODE.EOF);
            d.sent = true;
            const list = d.names.map((n) => {
              const s = fs.lstatSync(path.join(d.dir, n));
              return { filename: n, longname: `${s.isDirectory() ? "d" : s.isSymbolicLink() ? "l" : "-"}rw-r--r-- 1 u g ${s.size} Jan 1 00:00 ${n}`, attrs: attrs(s) };
            });
            if (!list.length) return sftp.status(reqid, STATUS_CODE.EOF);
            sftp.name(reqid, list);
          });
          sftp.on("MKDIR", (reqid, p) =>
            run(reqid, () => {
              fs.mkdirSync(real(p));
              sftp.status(reqid, STATUS_CODE.OK);
            }),
          );
          sftp.on("RMDIR", (reqid, p) =>
            run(reqid, () => {
              fs.rmdirSync(real(p));
              sftp.status(reqid, STATUS_CODE.OK);
            }),
          );
          sftp.on("REMOVE", (reqid, p) =>
            run(reqid, () => {
              fs.unlinkSync(real(p));
              sftp.status(reqid, STATUS_CODE.OK);
            }),
          );
          // Like OpenSSH's plain rename: refuses to replace an existing target.
          sftp.on("RENAME", (reqid, a, b) =>
            run(reqid, () => {
              if (fs.existsSync(real(b))) return sftp.status(reqid, STATUS_CODE.FAILURE);
              fs.renameSync(real(a), real(b));
              sftp.status(reqid, STATUS_CODE.OK);
            }),
          );
        });
      });
    });
    client.on("error", () => undefined);
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  return {
    port: (server.address() as AddressInfo).port,
    root,
    close: () =>
      new Promise<void>((res) => {
        for (const c of clients) {
          c.end();
          c._sock?.destroy();
        }
        server.close(() => res());
      }),
  };
}
