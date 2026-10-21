// Run by fanwatch.test.ts: uses a file-backed SizeStore (both workers) and returns without closing it; the process must exit by itself.
import os from "node:os";
import path from "node:path";
import { SizeStore } from "../src/size-store.ts";

const dir = os.tmpdir();
const st = new SizeStore(path.join(dir, `idle-exit-${process.pid}.db`), { root: dir, ttlMs: 60_000, maxEntries: 10 });
await st.notePending([{ path: "/a", dueAt: 0, modify: false }], 300);
await st.takeDue(Date.now(), 10, { modifyMs: 300, settleMs: 5 });
