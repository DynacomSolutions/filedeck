import net from "node:net";

/** A loopback port that was free a moment ago, for a real server program that must be told its port. */
export const freePort = () =>
  new Promise<number>((res, rej) => {
    const s = net.createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => res(port));
    });
  });

/** Wait until the program listens on the port; fail with what it printed when it stops first or never listens. */
export async function listening(what: string, port: number, child: { exitCode: number | null }, log: () => string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(`${what} stopped at once (status ${child.exitCode}): ${log()}`);
    const ok = await new Promise<boolean>((res) => {
      const c = net.connect(port, "127.0.0.1");
      c.once("connect", () => (c.destroy(), res(true)));
      c.once("error", () => res(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${what} did not listen on ${port}: ${log()}`);
}
