import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import type { Hono } from "hono";
import type { Config } from "./config.ts";
import { DiskDevices, diskIdentity, readSmartKind, type Disk, type Pin, type SmartSnapshot } from "./disk-verify-device.ts";

import { DISK_VERIFY_PATH } from "./agent-auth.ts";
type Kind = "full" | "short" | "long";
type State = "running" | "paused" | "pass" | "warn" | "fail";
type Phase = typeof fullPhases[number] | "self-test";
type Report = Record<string, unknown>;
const fullPhases = [
  "capacity-write", "capacity-read", "sequential-write", "sequential-read", "random-write", "random-read",
  "fill", "verify", "smart-after", "discard", "wipefs",
] as const;
const lease = 45_000;
const chunk = 256 * 1024 * 1024;
const benchmark = 512 * 1024 * 1024;
const randomBenchmark = 16 * 1024 * 1024;
const discardChunk = 4 * 1024 ** 3;
const maxParallel = 4;

interface Result {
  id: string;
  disk: Disk;
  kind: Kind;
  state: State;
  phase: Phase;
  offset: number;
  total: number;
  started: number;
  updated: number;
  actor: string;
  operator: string;
  operatorEpoch: number;
  samples: { time: number; bps: number; phase: Phase }[];
  details: Partial<Record<Phase, { seconds: number; bytes: number }>>;
  bytesPerSecond?: number;
  etaSeconds?: number;
  jobEtaSeconds?: number;
  before: SmartSnapshot;
  after?: SmartSnapshot;
  findings: string[];
  error?: string;
}

interface Row {
  id: string;
  identity: string;
  key: string;
  owner: string | null;
  heartbeat: number;
  cancel: number;
  payload: string;
}
type Active = { stop: AbortController; done: Promise<void> };

export function requireResume(saved: string, pin: Pick<Pin, "disk" | "boot" | "sequence" | "sector">) {
  if (saved !== diskIdentity(pin)) throw new Error("The saved job belongs to a different device or boot");
}

const object = (value: unknown): Report => value && typeof value === "object" && !Array.isArray(value) ? value as Report : {};
const nested = (obj: Report, ...keys: string[]): Report => keys.reduce((value, key) => object(value[key]), obj);
const table = (value: unknown): Report[] => Array.isArray(value) ? value.map(object) : [];
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;

export function smartSummary(smart: SmartSnapshot) {
  const nvme = object(smart.data.nvme_smart_health_information_log);
  const attributes = table(nested(smart.data, "ata_smart_attributes").table);
  const metrics: Record<string, number> = Object.create(null);
  const add = (key: string, v: unknown) => {
    const n = number(v);
    if (n !== undefined) metrics[key] = n;
  };
  add("Wear used (%)", nvme.percentage_used);
  add("Available spare (%)", nvme.available_spare);
  add("Media errors", nvme.media_errors);
  add("Error log entries", nvme.num_err_log_entries);
  add("Grown defects", smart.data.scsi_grown_defect_list);
  const counters = object(smart.data.scsi_error_counter_log);
  for (const [operation, report] of Object.entries(counters))
    add(`Uncorrected ${operation} errors`, object(report).total_uncorrected_errors);
  for (const attribute of attributes) {
    const name = attribute.name;
    if (typeof name !== "string") continue;
    if (/wear|life|endurance/i.test(name)) add(name, attribute.value);
    if (/Reallocated_Sector_Ct|Current_Pending_Sector|Offline_Uncorrectable|Reported_Uncorrect/i.test(name)) add(name, object(attribute.raw).value);
  }
  const health = object(smart.data.smart_status).passed;
  return { health: typeof health === "boolean" ? health : undefined, metrics };
}

export function compareSmart(before: SmartSnapshot, after: SmartSnapshot) {
  const a = smartSummary(before);
  const b = smartSummary(after);
  if (a.health === undefined || b.health === undefined) throw new Error("SMART health evidence is unavailable");
  const findings: string[] = [];
  let fail = a.health === false || b.health === false || !!((before.exit | after.exit) & 0x18);
  if (fail) findings.push("SMART reports a health failure or a failed attribute");
  for (const key of Object.keys(a.metrics))
    if (b.metrics[key] === undefined) findings.push(`SMART no longer reports ${key}`);
  for (const [key, value] of Object.entries(b.metrics)) {
    if (a.metrics[key] !== undefined && a.metrics[key] !== value) findings.push(`${key} changed from ${a.metrics[key]} to ${value}`);
    if (/media errors|pending_sector|uncorrect/i.test(key) && a.metrics[key] !== undefined && value > a.metrics[key]) fail = true;
    if (/errors|Reallocated_Sector_Ct|Current_Pending_Sector|Offline_Uncorrectable|Reported_Uncorrect/i.test(key) && value > 0 && a.metrics[key] === value)
      findings.push(`${key} remains at ${value}`);
  }
  if ((before.exit | after.exit) & 0xe0) findings.push("SMART includes historical attribute, error or self-test records");
  if (!Object.keys(b.metrics).some((k) => /wear|life|endurance|spare/i.test(k))) findings.push("SMART does not expose a recognised wear metric");
  return { fail, findings };
}

export function selfTestEvidence(snapshot: SmartSnapshot) {
  if (readSmartKind(snapshot) === "scsi") {
    const first = object(snapshot.data.scsi_self_test_0);
    const lines = object(snapshot.data.smartctl).output;
    const output = Array.isArray(lines) ? lines.filter((line): line is string => typeof line === "string") : [];
    const remaining = output.map((line) => /^Self-test execution status:\s+(\d+)% of test remaining\s*$/.exec(line)).find(Boolean);
    const code = number(object(first.result).value);
    const kind = number(object(first.code).value);
    return { supported: (code !== undefined && kind !== undefined) || output.some((line) => line.trim() === "No Self-tests have been logged"),
      running: first.self_test_in_progress === true || code === 15 || !!remaining,
      complete: remaining ? 100 - Number(remaining[1]) : undefined,
      recent: Object.keys(first).length ? first : undefined, code, kind };
  }
  const log = object(snapshot.data.nvme_self_test_log);
  if (readSmartKind(snapshot) === "nvme") {
    const operation = number(object(log.current_self_test_operation).value);
    const first = table(log.table)[0];
    return { supported: operation !== undefined && (log.table === undefined || Array.isArray(log.table)), running: operation !== undefined && operation > 0,
      recent: first, code: number(object(first?.self_test_result).value), kind: number(object(first?.self_test_code).value) };
  }
  const status = nested(snapshot.data, "ata_smart_data", "self_test", "status");
  const extended = nested(snapshot.data, "ata_smart_self_test_log", "extended");
  const standard = nested(snapshot.data, "ata_smart_self_test_log", "standard");
  const rows = extended.table ?? standard.table;
  const first = table(rows)[0];
  const operation = number(status.value);
  return { supported: operation !== undefined && (Array.isArray(rows) || extended.count === 0 || standard.count === 0),
    running: operation !== undefined && (operation & 0xf0) === 0xf0, recent: first,
    code: number(object(first?.status).value), kind: number(object(first?.type).value) };
}

function selfTestLog(snapshot: SmartSnapshot) {
  switch (readSmartKind(snapshot)) {
    case "scsi": return Object.entries(snapshot.data).filter(([key]) => /^scsi_self_test_\d+$/.test(key));
    case "nvme": return nested(snapshot.data, "nvme_self_test_log").table;
    case "ata": return snapshot.data.ata_smart_self_test_log;
  }
}

function result(row: Row): Result {
  const item = JSON.parse(row.payload) as Result;
  return item.state === "running" && row.heartbeat <= Date.now() - lease ?
    { ...item, state: "paused", error: "The agent stopped before the job finished" } : item;
}

export function phaseWork(phase: Phase, size: number): { total: number; block: number; operation?: string } {
  switch (phase) {
    case "capacity-write":
    case "capacity-read": {
      const total = Math.min(4096, Math.floor(size / 4096)) * 4096;
      return { total, block: total, operation: phase };
    }
    case "sequential-read": return { total: Math.min(size, benchmark), block: chunk, operation: "read" };
    case "sequential-write": return { total: Math.min(size, benchmark), block: chunk, operation: "write" };
    case "random-read":
    case "random-write": {
      const total = Math.min(Math.floor(size / 4096) * 4096, randomBenchmark);
      return { total, block: 2 * 1024 * 1024, operation: phase };
    }
    case "fill": return { total: size, block: chunk, operation: "write" };
    case "verify": return { total: size, block: chunk, operation: "verify" };
    case "discard": return { total: size, block: discardChunk, operation: "discard" };
    default: return { total: 0, block: 0 };
  }
}

export class VerifyStore {
  constructor(readonly db: DatabaseSync) {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS disk_verify_runs (
        id TEXT PRIMARY KEY, identity TEXT NOT NULL, key TEXT NOT NULL,
        owner TEXT, heartbeat INTEGER NOT NULL, cancel INTEGER NOT NULL, payload TEXT NOT NULL,
        serial TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS disk_verify_revocations (operator TEXT PRIMARY KEY, epoch INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS disk_verify_history ON disk_verify_runs(serial, heartbeat DESC);
    `);
  }

  row(id: string): Row | undefined {
    return this.db.prepare("SELECT * FROM disk_verify_runs WHERE id = ?").get(id) as unknown as Row | undefined;
  }

  latestFull(serial: string): string | undefined {
    const row = this.db.prepare("SELECT id FROM disk_verify_runs WHERE serial = ? AND json_extract(payload, '$.kind') = 'full' ORDER BY rowid DESC LIMIT 1").get(serial);
    return typeof row?.id === "string" ? row.id : undefined;
  }

  list(serial?: string): Result[] {
    const rows = serial === undefined ? this.db.prepare("SELECT * FROM disk_verify_runs ORDER BY heartbeat DESC LIMIT 100").all() :
      this.db.prepare("SELECT * FROM disk_verify_runs WHERE serial = ? ORDER BY heartbeat DESC LIMIT 100").all(serial);
    return (rows as unknown as Row[]).map(result);
  }

  pulse(id: string, owner: string) {
    return this.db.prepare("UPDATE disk_verify_runs SET heartbeat=? WHERE id=? AND owner=? AND cancel=0")
      .run(Date.now(), id, owner).changes === 1;
  }

  checkpoint(item: Result, owner: string) {
    const now = Date.now();
    item.updated = now;
    const r = this.db.prepare("UPDATE disk_verify_runs SET payload=?, heartbeat=?, owner=? WHERE id=? AND owner=?")
      .run(JSON.stringify(item), now, item.state === "running" ? owner : null, item.id, owner);
    if (r.changes !== 1) throw new Error("The disk job lease changed");
  }

  claim(item: Result, owner: string, identity: string, row?: Row) {
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const { count } = this.db.prepare("SELECT count(*) AS count FROM disk_verify_runs WHERE owner IS NOT NULL AND heartbeat > ?").get(now - lease)!;
      const revocation = this.db.prepare("SELECT epoch FROM disk_verify_revocations WHERE operator=?").get(item.operator);
      if (revocation && Number(revocation.epoch) > item.operatorEpoch) throw new Error("The administrator credentials changed");
      if (Number(count) >= maxParallel) throw new Error("This node is at its parallel disk limit");
      if (row) {
        const r = this.db.prepare("UPDATE disk_verify_runs SET owner=?, heartbeat=?, cancel=0, payload=? WHERE id=? AND (owner IS NULL OR heartbeat <= ?)")
          .run(owner, now, JSON.stringify(item), row.id, now - lease);
        if (r.changes !== 1) throw new Error("The job is already running");
      } else {
        this.db.prepare("INSERT INTO disk_verify_runs (id, identity, key, owner, heartbeat, cancel, payload, serial) VALUES (?, ?, ?, ?, ?, 0, ?, ?)")
          .run(item.id, identity, randomBytes(32).toString("hex"), owner, now, JSON.stringify(item), item.disk.serial);
      }
      const claimed = this.row(item.id)!;
      this.db.exec("COMMIT");
      return claimed;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  revoke(operator: string, epoch: number) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO disk_verify_revocations VALUES (?, ?) ON CONFLICT(operator) DO UPDATE SET epoch=max(epoch, excluded.epoch)").run(operator, epoch);
      this.db.prepare("UPDATE disk_verify_runs SET cancel=1 WHERE owner IS NOT NULL AND json_extract(payload, '$.operator')=? AND json_extract(payload, '$.operatorEpoch') < ?")
        .run(operator, epoch);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  cancel(id: string) {
    this.db.prepare("UPDATE disk_verify_runs SET cancel=1 WHERE id=? AND owner IS NOT NULL").run(id);
  }
}

export class DiskVerify {
  private readonly active = new Map<string, Active>();
  private closing = false;
  private starting = 0;

  constructor(readonly devices: DiskDevices, private readonly store: VerifyStore | undefined, readonly writable: boolean) {}

  static async create(cfg: Config) {
    const allow = new Set(cfg.diskVerifyTargets ?? []);
    const devices = await DiskDevices.create(allow, cfg.readOnly, cfg.root);
    if (!cfg.diskVerifyState) return new DiskVerify(devices, undefined, false);
    const state = cfg.diskVerifyState;
    if (!path.isAbsolute(state)) throw new Error("Disk verify requires an absolute state directory");
    await fs.mkdir(state, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
    const stat = await fs.lstat(state);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) ||
        await fs.realpath(state) !== path.resolve(state)) throw new Error("Disk verify requires a private state directory");
    const db = new VerifyStore(new DatabaseSync(path.join(state, "runs.sqlite")));
    // Initial PID namespace has a reserved init inode. Limited hostPath mounts do not confer raw disk access.
    const init = await fs.readlink("/proc/1/ns/pid").catch(() => "");
    const own = await fs.readlink("/proc/self/ns/pid").catch(() => "");
    const writable = cfg.root === "/" && init === "pid:[4026531836]" && own === init && allow.size > 0;
    return new DiskVerify(devices, db, writable);
  }

  list(serial?: string) {
    return (this.store?.list(serial) ?? []).map(({ before, after, samples, details, ...summary }) => summary);
  }

  job(id: string) {
    const row = this.store?.row(id);
    return row && result(row);
  }

  async smart(byId: string, serial: string) {
    const pin = await this.devices.pin(byId, serial, false);
    try {
      const snapshot = await this.devices.smart(pin);
      return { snapshot, ...smartSummary(snapshot) };
    } finally {
      await pin.file.close();
    }
  }

  async start(input: { byId: string; serial: string; kind: Kind; actor: string; epoch: number; fingerprint: string; resume?: string; signal?: AbortSignal }) {
    const store = this.store;
    if (!store || !this.writable || this.closing) throw new Error("Disk tests require a configured native host agent");
    if (this.starting + this.active.size >= maxParallel) throw new Error("This node is at its parallel disk limit");
    this.starting++;
    let pin: Pin | undefined;
    try {
      const row = input.resume ? store.row(input.resume) : undefined;
      const saved = row && result(row);
      if (input.resume && (!saved || saved.kind !== "full" || saved.state !== "paused" ||
          input.serial !== saved.disk.serial || input.byId !== saved.disk.byId)) throw new Error("This run cannot be resumed");
      pin = await this.devices.pin(input.byId, input.serial, true);
      if (input.fingerprint !== diskIdentity(pin)) throw new Error("Disk identity changed after inventory. Select the disk again.");
      if (row) {
        requireResume(row.identity, pin);
        if (store.latestFull(input.serial) !== row.id) throw new Error("A newer full test replaced this checkpoint");
      }
      await this.devices.guard(pin, input.signal);
      const before = await this.devices.smart(pin, ["-x"], input.signal);
      if (smartSummary(before).health === undefined) throw new Error("SMART health evidence is unavailable");
      if (input.kind === "full" && pin.disk.size < 8192) throw new Error("Disk is smaller than the capacity sample");
      if (pin.sector > 4096 || 4096 % pin.sector || pin.disk.size % pin.sector) throw new Error("Unsupported logical sector size");
      const evidence = selfTestEvidence(before);
      if (evidence.running) throw new Error("A SMART self-test is already running");
      if (input.kind !== "full" && (!evidence.supported || !readSmartKind(before))) throw new Error("The device does not report a supported SMART self-test log");
      input.signal?.throwIfAborted();
      if (this.closing) throw new Error("The agent is stopping");
      const now = Date.now();
      const phase = input.kind === "full" ? fullPhases[0] : "self-test";
      const item: Result = saved ? { ...saved, state: "running", updated: now, error: undefined, operator: input.actor, operatorEpoch: input.epoch } : {
        id: randomUUID(), disk: pin.disk, kind: input.kind, state: "running", phase,
        offset: 0, total: phaseWork(phase, pin.disk.size).total, started: now, updated: now,
        actor: input.actor, operator: input.actor, operatorEpoch: input.epoch, before, samples: [], details: {}, findings: [],
      };
      if (saved?.phase === "verify") {
        item.offset = 0;
        delete item.details.verify;
      }
      const owner = randomUUID();
      const claimed = store.claim(item, owner, diskIdentity(pin), row);
      const stop = new AbortController();
      const done = this.run(pin, item, claimed, owner, stop);
      this.active.set(item.id, { stop, done });
      pin = undefined;
      return item;
    } finally {
      this.starting--;
      await pin?.file.close();
    }
  }

  cancel(id: string) {
    this.store?.cancel(id);
    this.active.get(id)?.stop.abort();
  }

  revoke(operator: string, epoch: number) { this.store?.revoke(operator, epoch); }

  activeCount() { return this.active.size; }

  async close() {
    this.closing = true;
    for (const { stop } of this.active.values()) stop.abort();
    await Promise.allSettled([...this.active.values()].map(({ done }) => done));
  }

  private async run(pin: Pin, item: Result, row: Row, owner: string, stop: AbortController) {
    const store = this.store!;
    const signal = stop.signal;
    const heartbeat = setInterval(() => {
      try {
        if (!store.pulse(item.id, owner)) stop.abort();
      } catch {
        stop.abort();
      }
    }, 1500);
    try {
      if (item.kind === "full") await this.full(pin, item, row.key, signal, () => store.checkpoint(item, owner));
      else await this.selfTest(pin, item, item.kind, signal, () => store.checkpoint(item, owner));
      const comparison = compareSmart(item.before, item.after!);
      item.findings.push(...comparison.findings);
      item.state = comparison.fail ? "fail" : item.findings.length ? "warn" : "pass";
    } catch (err) {
      item.state = (signal.aborted && item.kind === "full") ? "paused" : (signal.aborted ? "warn" : "fail");
      item.error = signal.aborted && (item.kind === "full" || (err as Error).name === "AbortError") ?
        "Job stopped" : (err as Error).message;
    } finally {
      clearInterval(heartbeat);
      await pin.file.close().catch(() => undefined);
      try { store.checkpoint(item, owner); }
      catch (error) { console.error("Disk verify checkpoint failed", (error as Error).message); }
      this.active.delete(item.id);
    }
  }

  private async full(pin: Pin, item: Result, key: string, signal: AbortSignal, checkpoint: () => void) {
    const size = pin.disk.size;
    const start = fullPhases.indexOf(item.phase as typeof fullPhases[number]);
    if (start < 0) throw new Error("Unknown saved disk phase");
    for (const phase of fullPhases.slice(start)) {
      const work = phaseWork(phase, size);
      if (item.phase !== phase) {
        item.phase = phase;
        item.offset = 0;
        item.total = work.total;
        item.bytesPerSecond = undefined;
        item.etaSeconds = undefined;
        item.jobEtaSeconds = undefined;
        checkpoint();
      }

      if (phase === "smart-after") {
        item.after = await this.devices.smart(pin, ["-x"], signal);
        compareSmart(item.before, item.after);
        checkpoint();
        continue;
      }
      if (phase === "wipefs") {
        await this.devices.guard(pin, signal);
        await this.devices.command(pin, "wipefs", [], signal);
        continue;
      }
      if (phase === "discard" && !pin.disk.discard) {
        item.findings.push("The drive does not advertise discard support. Random test data remains on the disk.");
        continue;
      }

      if (!Number.isSafeInteger(item.offset) || item.offset < 0 || item.offset > work.total || !work.operation || work.block <= 0)
        throw new Error("Invalid disk job checkpoint");
      while (item.offset < work.total) {
        const amount = Math.min(work.total - item.offset, work.block);
        await this.devices.guard(pin, signal);
        const args = [String(item.offset), String(amount)];
        if (phase !== "discard") args.push(key);
        const started = performance.now();
        const measured = await this.devices.command(pin, work.operation, args, signal);
        const [bytes, duration] = measured.split(" ").map(Number);
        if (phase !== "discard" && (bytes !== amount || !duration || !Number.isFinite(duration)))
          throw new Error("The disk helper did not confirm the complete range");
        const seconds = Math.max(phase === "discard" ? (performance.now() - started) / 1000 : duration!, 0.001);
        item.offset += amount;
        const summary = item.details[phase] ?? { bytes: 0, seconds: 0 };
        item.details[phase] = { bytes: summary.bytes + amount, seconds: summary.seconds + seconds };
        item.bytesPerSecond = Math.round(amount / seconds);
        item.etaSeconds = Math.ceil((work.total - item.offset) / item.bytesPerSecond);
        const read = item.details.verify ?? item.details["sequential-read"];
        const write = item.details.fill ?? item.details["sequential-write"];
        if (read && write) {
          const fillLeft = size - (item.details.fill?.bytes ?? 0);
          const verifyLeft = size - (item.details.verify?.bytes ?? 0);
          if (phase === "discard") item.jobEtaSeconds = item.etaSeconds;
          else if (phase === "fill" || phase === "verify")
            item.jobEtaSeconds = Math.ceil(fillLeft * write.seconds / write.bytes + verifyLeft * read.seconds / read.bytes);
        }
        item.samples.push({ time: Date.now(), bps: item.bytesPerSecond, phase });
        if (item.samples.length > 120) item.samples.shift();
        checkpoint();
      }
    }
  }

  private async selfTest(pin: Pin, item: Result, kind: "short" | "long", signal: AbortSignal, checkpoint: () => void) {
    const protocol = readSmartKind(item.before)!;
    const baseline = JSON.stringify(selfTestLog(item.before));
    await this.devices.guard(pin, signal);
    let sawRunning = false;
    try {
      await this.devices.command(pin, "smart", [protocol, kind], signal);
      const initiated = Date.now();
      const end = initiated + 24 * 60 * 60_000;
      const polling = nested(item.before.data, "ata_smart_data", "self_test", "polling_minutes");
      const scsiSeconds = number(item.before.data.scsi_extended_self_test_seconds);
      const estimate = number(polling[kind === "short" ? "short" : "extended"]) ??
        (kind === "long" ? number(item.before.data.nvme_extended_self_test_time) ?? (scsiSeconds === undefined ? undefined : scsiSeconds / 60) : undefined);
      item.total = 100;
      while (Date.now() < end) {
        await delay(sawRunning ? 15_000 : 3000, signal);
        item.after = await this.devices.smart(pin, ["-x"], signal);
        const report = selfTestEvidence(item.after);
        if (!report.supported) throw new Error("SMART self-test progress is unavailable");
        if (report.running) {
          sawRunning = true;
          const remaining = number(nested(item.after.data, "ata_smart_data", "self_test", "status").remaining_percent);
          const complete = number(nested(item.after.data, "nvme_self_test_log").current_self_test_completion_percent) ??
            report.complete;
          item.offset = Math.min(100, Math.max(0, complete ?? (remaining !== undefined ? 100 - remaining : 0)));
          const elapsed = (Date.now() - initiated) / 1000;
          item.etaSeconds = item.offset > 0 ? Math.round(elapsed * (100 - item.offset) / item.offset) :
            estimate === undefined ? undefined : Math.max(0, Math.round(estimate * 60 - elapsed));
          checkpoint();
        }
        else if (report.recent && baseline !== JSON.stringify(selfTestLog(item.after))) {
          if (report.kind !== (kind === "short" ? 1 : 2) || report.code !== 0) throw new Error("The requested SMART self-test did not pass");
          item.offset = item.total;
          item.etaSeconds = 0;
          return;
        } else if (sawRunning) throw new Error("The SMART self-test ended without a fresh result");
      }
      throw new Error("No fresh SMART self-test result within 24 hours");
    } catch (error) {
      if (signal.aborted) {
        // Stop the firmware operation only after fresh identity and safety checks.
        try {
          await this.devices.guard(pin);
          await this.devices.command(pin, "smart", [protocol, "cancel"]);
        } catch (abortError) {
          throw new Error(`The agent could not confirm firmware cancellation: ${(abortError as Error).message}`);
        }
      }
      throw error;
    }
  }
}

function delay(ms: number, signal: AbortSignal) { return sleep(ms, undefined, { signal }); }

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255;
}

export function registerDiskVerify(app: Hono, cfg: Config) {
  const enabled = cfg.auth && cfg.agentToken && cfg.diskVerify;
  const init = enabled ? DiskVerify.create(cfg).catch((err: Error) => err) : undefined;
  const agent = async () => {
    const result = await init;
    if (result instanceof Error) throw result;
    if (!result) throw new Error("Disk verify is disabled on this agent");
    return result;
  };
  app.use(DISK_VERIFY_PATH, requireAdmin);
  app.use(`${DISK_VERIFY_PATH}/*`, requireAdmin);
  async function requireAdmin(c: import("hono").Context, next: import("hono").Next) {
    if (!cfg.auth || !cfg.agentToken || c.get("user")?.admin !== true) return c.json({ error: "Administrators only" }, 403);
    c.header("cache-control", "no-store");
    return next();
  }

  app.get(DISK_VERIFY_PATH, async (c) => {
    if (!enabled) return c.json({ error: "Disk verify is disabled on this agent" }, 404);
    try {
      const verifier = await agent();
      return c.json({ disks: await verifier.devices.list(), jobs: verifier.list(), writable: verifier.writable });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 503);
    }
  });

  app.get(`${DISK_VERIFY_PATH}/history`, async (c) => {
    const serial = c.req.query("serial");
    if (!text(serial)) return c.json({ error: "A disk serial is required" }, 400);
    try {
      return c.json({ jobs: (await agent()).list(serial) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 503);
    }
  });

  app.get(`${DISK_VERIFY_PATH}/smart`, async (c) => {
    const byId = c.req.query("id"), serial = c.req.query("serial");
    if (!text(byId) || !text(serial)) return c.json({ error: "A by-id link and serial are required" }, 400);
    try {
      return c.json(await (await agent()).smart(byId, serial));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
  });

  app.post(`${DISK_VERIFY_PATH}/start`, async (c) => {
    const input = object(await c.req.json().catch(() => null));
    const { byId, serial, confirm, kind, resume, fingerprint } = input;
    if (!text(byId) || !text(serial) || confirm !== serial || typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint) ||
        (kind !== "full" && kind !== "short" && kind !== "long") || (resume !== undefined && (!text(resume) || kind !== "full")))
      return c.json({ error: "Confirm the exact serial and select a test" }, 400);
    try {
      return c.json(await (await agent()).start({ byId, serial, kind, actor: `${c.get("user").kind}:${c.get("user").name}`, epoch: c.get("user").epoch!, fingerprint, resume, signal: c.req.raw.signal }), 202);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
  });

  app.post(`${DISK_VERIFY_PATH}/revoke`, async (c) => {
    if (!enabled) return c.body(null, 204);
    try {
      const { kind, name, epoch } = c.get("user");
      (await agent()).revoke(`${kind}:${name}`, epoch!);
      return c.body(null, 204);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 503);
    }
  });

  app.get(`${DISK_VERIFY_PATH}/:id`, async (c) => {
    try {
      const job = (await agent()).job(c.req.param("id"));
      return job ? c.json(job) : c.json({ error: "No such disk job" }, 404);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 503);
    }
  });

  app.post(`${DISK_VERIFY_PATH}/:id/cancel`, async (c) => {
    try {
      (await agent()).cancel(c.req.param("id"));
      return c.body(null, 204);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
  });
  return {
    async close() {
      const verifier = await init;
      if (verifier instanceof DiskVerify) await verifier.close();
    },
    async activeCount() {
      const verifier = await init;
      return verifier instanceof DiskVerify ? verifier.activeCount() : 0;
    },
  };
}
