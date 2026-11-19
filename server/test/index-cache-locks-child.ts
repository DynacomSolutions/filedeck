// Child of index-cache-locks.test.ts. Role "a": open the database twice (as a second thread or store would), then write until told to stop.
// Role "b": a second process that opens the same database and writes.
import fs from "node:fs";
import { openDb } from "../src/index-cache.ts";

const [file, role] = process.argv.slice(2) as [string, string];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (role === "a") {
  const db = openDb(file)!;
  db.exec("CREATE TABLE IF NOT EXISTS t (x BLOB)");
  const again = openDb(file)!; // the second open of a file this process holds: it must not drop the first connection's locks
  again.exec("SELECT 1");
  console.log("ready");
  const end = Date.now() + 1500;
  while (Date.now() < end) {
    db.exec("INSERT INTO t VALUES (randomblob(2000))");
    await sleep(1);
  }
  console.log("shm", fs.statSync(file + "-shm").size);
  process.exit(0);
} else {
  const db = openDb(file)!;
  db.exec("INSERT INTO t VALUES (randomblob(10))");
  await sleep(200);
  db.close();
  process.exit(0);
}
