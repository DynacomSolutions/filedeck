import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { contractTest } from "./agent-under-test.ts";
import { getJson, withAgent } from "./fs-fixture.ts";

// The HTTP form of test/mounts.test.ts. The mount table is read from FILEDECK_PROC_MOUNTS, so a test controls what the agent sees.
// A mount point must exist under the root, because the agent reads its size there.
const folders = (root: string, ...points: string[]) => {
  for (const p of points) fs.mkdirSync(path.join(root, p), { recursive: true });
};

/** run with a table file; `table` gets the root, so a test can name real folders */
async function withTable(table: string, points: string[], env: Record<string, string>, fn: (mounts: any[], root: string) => Promise<void> | void) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fd-mounts-table-")));
  const file = path.join(dir, "mounts");
  fs.writeFileSync(file, table);
  try {
    await withAgent({ setup: (root) => folders(root, ...points), prefix: "fd-mounts-", env: { FILEDECK_PROC_MOUNTS: file, ...env } }, async (app, root) => {
      const r = await getJson(app, "/api/mounts");
      assert.equal(r.status, 200);
      assert.deepEqual(Object.keys(r.body), ["mounts"]);
      await fn(r.body.mounts, root);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const hostTable = "/dev/nvme0n1p2 / ext4 rw 0 0\n/dev/nvme0n1p3 /home ext4 rw 0 0\nproc /proc proc rw 0 0\n";

contractTest("a host table lists its real mounts, with sizes, sorted by mount point", () =>
  withTable(hostTable, ["home", "proc"], {}, (mounts) => {
    assert.deepEqual(mounts.map((m) => m.mountpoint), ["/", "/home"]);
    const [slash] = mounts;
    assert.deepEqual(Object.keys(slash).slice(0, 4), ["device", "mountpoint", "fstype", "network"]);
    assert.deepEqual([slash.device, slash.fstype, slash.network], ["/dev/nvme0n1p2", "ext4", false]);
    for (const m of mounts) {
      for (const k of ["total", "used", "free"]) assert.equal(typeof m[k], "number", `${m.mountpoint} ${k}`);
      assert.ok(m.total > 0, m.mountpoint);
      assert.ok(m.used + m.free <= m.total + 4096, m.mountpoint);
      assert.equal(m.netKind, undefined);
      assert.equal(m.unreachable, undefined);
    }
  }),
);

contractTest("stacked mounts: the last one is the visible one, at the place of the first; a pseudo filesystem on top hides a real one", () =>
  withTable(["/dev/a / ext4 rw 0 0", "/dev/b /srv ext4 rw 0 0", "/dev/c /srv xfs rw 0 0", "/dev/a /alias ext4 rw 0 0", "/dev/a /x ext4 rw 0 0", "proc /x proc rw 0 0", ""].join("\n"), ["srv", "alias", "x"], {}, (mounts) => {
    assert.deepEqual(mounts.map((m) => [m.mountpoint, m.device, m.fstype]), [["/", "/dev/a", "ext4"], ["/alias", "/dev/a", "ext4"], ["/srv", "/dev/c", "xfs"]]);
  }),
);

contractTest("tmpfs only under /tmp, runtime mounts (also /dev/shm) and pseudo filesystems are hidden", () =>
  withTable(
    [
      "/dev/a / ext4 rw 0 0",
      "tmpfs /tmp tmpfs rw 0 0",
      "tmpfs /tmp/inner tmpfs rw 0 0",
      "tmpfs /mnt/ram tmpfs rw 0 0",
      "tmpfs /dev/shm tmpfs rw 0 0",
      "/dev/a /var/lib/docker/x ext4 rw 0 0",
      "/dev/a /snap/core ext4 rw 0 0",
      "/dev/a /run/user/1000 ext4 rw 0 0",
      "sysfs /sys sysfs rw 0 0",
      "overlay /ov overlay rw 0 0",
      "",
    ].join("\n"),
    ["tmp/inner", "mnt/ram", "dev/shm", "var/lib/docker/x", "snap/core", "run/user/1000", "sys", "ov"],
    {},
    (mounts) => {
      assert.deepEqual(mounts.map((m) => m.mountpoint), ["/", "/tmp", "/tmp/inner"]);
    },
  ),
);

contractTest("network and FUSE mounts are marked with their kind", () =>
  withTable(
    ["/dev/a / ext4 rw 0 0", "srv:/export /nfs nfs4 rw 0 0", "//nas/share /smb cifs rw 0 0", "u@h:/ /ssh fuse.sshfs rw 0 0", "x /fuse fuse.unknown rw 0 0", ""].join("\n"),
    ["nfs", "smb", "ssh", "fuse"],
    {},
    (mounts) => {
      const kind = (p: string) => mounts.find((m) => m.mountpoint === p);
      assert.equal(kind("/").network, false);
      assert.deepEqual([kind("/nfs").network, kind("/nfs").netKind], [true, "NFS"]);
      assert.deepEqual([kind("/smb").network, kind("/smb").netKind], [true, "SMB/CIFS"]);
      assert.deepEqual([kind("/ssh").network, kind("/ssh").netKind], [true, "SSHFS"]);
      assert.deepEqual([kind("/fuse").network, kind("/fuse").netKind], [true, "FUSE"]);
      assert.deepEqual(Object.keys(kind("/nfs")).slice(0, 5), ["device", "mountpoint", "fstype", "network", "netKind"]);
    },
  ),
);

contractTest("octal escapes in the table are decoded, and a mount whose folder is not there is left out", () =>
  withTable("/dev/a / ext4 rw 0 0\n/dev/b /my\\040disk ext4 rw 0 0\n/dev/c /gone ext4 rw 0 0\n", ["my disk"], {}, (mounts) => {
    assert.deepEqual(mounts.map((m) => m.mountpoint), ["/", "/my disk"]);
  }),
);

contractTest("a mount under a read-only prefix is marked readOnly", () =>
  withTable(hostTable, ["home", "mnt/backup"], { FILEDECK_READONLY: "/home" }, (mounts) => {
    // the TS agent marks the mounts under the prefix; the Rust agent is read only everywhere and marks every mount
    assert.equal(mounts.find((m) => m.mountpoint === "/home").readOnly, true);
  }),
);

contractTest("a table that cannot be read gives no mounts", () =>
  withAgent({ prefix: "fd-mounts-", env: { FILEDECK_PROC_MOUNTS: "/nonexistent/mounts-table" } }, async (app) => {
    assert.deepEqual((await getJson(app, "/api/mounts")).body, { mounts: [] });
  }),
);

contractTest("without a setting, a root other than / reads <root>/proc/mounts and shows its mounts as seen from the root", (t) => {
  if (process.platform === "darwin") return void t.skip("macOS has no /proc: the Rust agent runs mount(8)");
  return withAgent(
    {
      setup: (root) => {
        folders(root, "proc", "home", "tmp", "var/lib/filedeck");
        const container = ["overlay / overlay rw 0 0", `/dev/nvme0n1p2 ${root} ext4 rw 0 0`, `/dev/nvme0n1p3 ${root}/home ext4 rw 0 0`, "/dev/nvme0n1p2 /tmp ext4 rw 0 0", "/dev/nvme0n1p2 /var/lib/filedeck ext4 rw 0 0", ""].join("\n");
        fs.writeFileSync(path.join(root, "proc/mounts"), container);
      },
      prefix: "fd-mounts-",
    },
    async (app) => {
      const m = (await getJson(app, "/api/mounts")).body.mounts;
      assert.deepEqual(m.map((x: { device: string; mountpoint: string }) => [x.device, x.mountpoint]), [["/dev/nvme0n1p2", "/"], ["/dev/nvme0n1p3", "/home"]]);
    },
  );
});

contractTest("the mount list needs the token", () =>
  withAgent({ prefix: "fd-mounts-", env: { FILEDECK_PROC_MOUNTS: "/nonexistent/mounts-table" } }, async (app) => {
    assert.equal((await app.anon("/api/mounts")).status, 401);
  }),
);
