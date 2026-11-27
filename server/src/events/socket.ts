import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { FsError } from "../fsops.ts";
import type { EventBus } from "./bus.ts";
import { Filter, type FilterSpec } from "./filter.ts";

/**
 * The node-local Unix socket (FILEDECK_EVENTS_SOCKET). A client connects and sends one JSON line:
 *     {"filter":{"prefix":["/srv/repos"],"glob":["*.md"],"kind":["create","modify"],"type":"file","label":["org:acme"]},"since":"<cursor>"}
 * and the server answers with one JSON line per event (NDJSON), and a `ping` line when nothing happened for a while. No TLS and no token: the
 * directory (mode 0750, group `group`) and the socket (mode 0660) decide who may connect. The line is at most 16 KiB, and a client has 10 s to send it.
 * A client may close its writing side after the request and still read (`printf '{}\n' | nc -U ...`); one that vanished is found when a line cannot be written to it (a ping, at the latest).
 */

export interface SocketOptions {
  path: string;
  /** group that may connect (name or number); the socket and its directory are given to it */
  group?: string;
  /** the user that must own the socket's folder (default: the user of this process): a folder of anyone else is never changed */
  uid?: number;
  /** most clients at once (default 256) */
  maxClients?: number;
  log?: (s: string) => void;
}

const MAX_REQUEST = 16 * 1024;
const REQUEST_MS = 10_000;

export interface EventSocket {
  close(): Promise<void>;
  readonly path: string;
}

export async function startEventSocket(bus: EventBus, o: SocketOptions): Promise<EventSocket> {
  if (Buffer.byteLength(o.path) > 100) throw new Error("the socket path is longer than 100 bytes (the limit of a Unix socket address)");
  const me = o.uid ?? process.getuid?.() ?? 0;
  const dir = path.dirname(o.path);
  // The folder is made (or kept) 0750 only when it is a real folder of this user: the agent never changes the mode or group of a folder it does not own,
  // and never follows a link to one. The checks and the changes go through one descriptor (opened without following a link), so the folder cannot be
  // swapped for a link between them.
  if (!lstatOrNull(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  let dfd: number;
  try {
    dfd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    throw new Error(`the socket folder ${dir} is not a folder (a link is not followed): ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  try {
    if (fs.fstatSync(dfd).uid !== me) throw new Error(`the socket folder ${dir} is not owned by the agent's user: it is not changed`);
    fs.fchmodSync(dfd, 0o750);
    if (o.group) fs.fchownSync(dfd, me, groupId(o.group));
  } finally {
    fs.closeSync(dfd);
  }
  // Anything but an old socket at that place is kept, and the start is refused. An old socket (of a process that is gone, or one that is going) is
  // replaced at the end by a rename, not removed first: the new socket is bound under a name of its own and moved into place when it is ready.
  const old = lstatOrNull(o.path);
  if (old && !old.isSocket()) throw new Error(`${o.path} exists and is not a socket: it is not removed`);
  await removeStaleSockets(o.path, o.log);
  const own = `${o.path}.${randomBytes(3).toString("hex")}`;
  const clients = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (sock) => {
    if (clients.size >= (o.maxClients ?? 256)) {
      sock.end(JSON.stringify({ kind: "error", error: "too many clients" }) + "\n");
      return;
    }
    clients.add(sock);
    sock.on("close", () => clients.delete(sock));
    sock.on("error", () => sock.destroy());
    void serve(bus, sock).catch((e) => {
      const msg = e instanceof FsError ? e.message : "bad request";
      sock.end(JSON.stringify({ kind: "error", error: msg }) + "\n");
    });
  });
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(own, () => res());
  });
  let ino: { dev: number; ino: number };
  try {
    fs.chmodSync(own, 0o660);
    if (o.group) fs.chownSync(own, me, groupId(o.group));
    fs.renameSync(own, o.path);
    const st = fs.lstatSync(o.path);
    ino = { dev: st.dev, ino: st.ino };
  } catch (e) {
    await new Promise<void>((res) => server.close(() => res()));
    throw e;
  }
  return {
    path: o.path,
    async close() {
      for (const c of clients) c.destroy();
      await new Promise<void>((res) => server.close(() => res()));
      // (the server removes the name it bound, which is gone after the rename.) The socket at the shared path is removed only while it is still this one: a
      // newer process may have put its own there already (a rolling deploy), and that one must stay.
      const now = lstatOrNull(o.path);
      if (now?.isSocket() && now.dev === ino.dev && now.ino === ino.ino) fs.rmSync(o.path, { force: true });
    },
  };
}

/**
 * A process that was killed between `listen(own)` and the rename leaves its `<name>.<6 hex>` socket in the folder. At start, every such name is removed
 * when it is a socket (not a link or a file) and nobody listens on it (the connection is refused). A name of any other kind stays, and so does a socket that
 * answers: it belongs to a process that starts at the same time (a rolling deploy).
 */
async function removeStaleSockets(sockPath: string, log?: (s: string) => void): Promise<void> {
  const dir = path.dirname(sockPath);
  const re = new RegExp(`^${path.basename(sockPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.[0-9a-f]{6}$`);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => re.test(n));
  } catch {
    return;
  }
  for (const n of names) {
    const file = path.join(dir, n);
    if (!lstatOrNull(file)?.isSocket()) continue;
    if ((await probe(file)) !== "ECONNREFUSED") continue;
    // (checked again: the name must still be a socket when it is removed)
    if (!lstatOrNull(file)?.isSocket()) continue;
    fs.rmSync(file, { force: true });
    log?.(`event socket: the stale socket ${file} was removed`);
  }
}

/** Connect to a socket and give the error code of the attempt (`ok` when something answered). */
function probe(file: string): Promise<string> {
  return new Promise((res) => {
    const c = net.connect(file);
    const timer = setTimeout(() => done("timeout"), 2000);
    const done = (r: string) => {
      clearTimeout(timer);
      c.destroy();
      res(r);
    };
    c.once("connect", () => done("ok"));
    c.once("error", (e: NodeJS.ErrnoException) => done(e.code ?? "error"));
  });
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function groupId(group: string): number {
  const gid = Number(group);
  if (Number.isInteger(gid)) return gid;
  // names are looked up in /etc/group (the process may not have NSS)
  const line = fs.readFileSync("/etc/group", "utf8").split("\n").find((l) => l.startsWith(group + ":"));
  if (!line) throw new Error(`events socket group "${group}" does not exist`);
  return Number(line.split(":")[2]);
}

/** Read the request line, subscribe, and write what the subscriber yields until it ends or the client goes. */
async function serve(bus: EventBus, sock: net.Socket): Promise<void> {
  const request = await readLine(sock);
  let spec: { filter?: unknown; since?: unknown };
  try {
    spec = JSON.parse(request) as typeof spec;
  } catch {
    throw new FsError(400, "the request is one JSON line");
  }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new FsError(400, "the request is a JSON object");
  if (spec.since !== undefined && typeof spec.since !== "string") throw new FsError(400, "since is a cursor (text)");
  const f = spec.filter;
  if (f !== undefined && (typeof f !== "object" || f === null || Array.isArray(f))) throw new FsError(400, "filter is an object");
  const filter = new Filter(f as FilterSpec | undefined);
  const sub = await bus.subscribe(filter, spec.since as string | undefined, "socket");
  const gone = () => sub.close();
  sock.on("close", gone);
  sock.on("end", () => {
    /* a client that closes its writing side still reads */
  });
  try {
    for (;;) {
      const batch = await sub.next();
      if (!batch) break;
      if (sock.destroyed) break;
      sock.cork();
      let ok = true;
      for (const b of batch) ok = sock.write(b);
      sock.uncork();
      if (!ok) await new Promise<void>((res) => sock.once("drain", res).once("close", res));
    }
  } finally {
    sub.close();
    sock.end();
  }
}

function readLine(sock: net.Socket): Promise<string> {
  return new Promise((res, rej) => {
    let buf = "";
    const timer = setTimeout(() => done(new FsError(400, "no request line within 10 s")), REQUEST_MS);
    const done = (e: Error | null, line?: string) => {
      clearTimeout(timer);
      sock.off("data", onData);
      sock.off("close", onClose);
      if (e) rej(e);
      else res(line!);
    };
    const onData = (d: Buffer) => {
      buf += d.toString("utf8");
      const i = buf.indexOf("\n");
      if (i >= 0) done(null, buf.slice(0, i));
      else if (buf.length > MAX_REQUEST) done(new FsError(400, "the request line is too long"));
    };
    const onClose = () => done(new FsError(400, "closed before a request"));
    sock.on("data", onData);
    sock.on("close", onClose);
  });
}
