import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { executable, locateHelper } from "./native.ts";
import { hitsReadOnly, readOnlyForms } from "./readonly.ts";

type Json = Record<string, unknown>;
export interface Disk {
  name: string;
  model: string;
  serial: string;
  transport: string;
  size: number;
  byId?: string;
  reason?: string;
  fingerprint?: string;
  majorMinor: string;
  discard: number;
}

export interface Pin {
  disk: Disk;
  sequence: string;
  boot: string;
  sector: number;
  file: FileHandle;
}
export function diskIdentity(pin: Pick<Pin, "disk" | "boot" | "sequence">): string {
  const { disk } = pin;
  return createHash("sha256").update(JSON.stringify([
    disk.byId, disk.serial, disk.model, disk.size, disk.transport, disk.majorMinor, pin.boot, pin.sequence,
  ])).digest("hex");
}

export interface SmartSnapshot {
  exit: number;
  data: Json;
}
export type SmartKind = "ata" | "nvme" | "scsi";

const byIdDir = "/dev/disk/by-id";

const bootId = "/proc/sys/kernel/random/boot_id";
const smartctl = "/usr/sbin/smartctl";
const supported = new Set(["sata", "ata", "sas", "usb", "nvme", "scsi"]);
const basename = /^[\w.+:-]{1,255}$/;
const diskName = /^(?:sd[a-z]+|hd[a-z]+|nvme\d+n\d+)$/;
const devNumber = /^\d+:\d+$/;
const stableId = (name: string) => basename.test(name) && name !== "." && name !== ".." && !/-part\d+$/.test(name);

export function runTool(program: string, args: string[], { file, signal }: { file?: FileHandle; signal?: AbortSignal } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const stop = AbortSignal.timeout(120_000);
    const child = spawn(program, args, {
      stdio: ["ignore", "pipe", "pipe", ...(file ? [file.fd] : [])],
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C", FILEDECK_DISK_PARENT: String(process.pid) },
      signal: signal ? AbortSignal.any([signal, stop]) : stop,
      killSignal: "SIGKILL",
    });
    let out = "", err = "", failure: Error | undefined;
    child.stdout!.setEncoding("utf8").on("data", (s: string) => {
      out += s;
      if (out.length > 1024 * 1024) {
        failure = new Error("Disk tool output exceeded its limit");
        child.kill("SIGKILL");
      }
    });
    child.stderr!.setEncoding("utf8").on("data", (s: string) => { err = (err + s).slice(0, 4096); });
    child.on("error", (e) => { failure ??= e; });
    // Wait for close even on abort. The inherited exclusive claim must be released before another run starts.
    child.on("close", (code) => {
      if (failure || code === null) reject(failure ?? new Error("Disk tool was stopped"));
      else if (code !== 0 && program !== smartctl) reject(new Error(err.trim() || "Disk tool failed"));
      else resolve({ code, out });
    });
  });
}

export interface GuardEvidence {
  name: string;
  target: string;
  pinnedDevice: string;
  sysDevice: string;
  pinnedSequence: string;
  sysSequence: string;
  partitions: string[];
  holders: string[];
  mounted: string[];
  swap: string[];
  slaves: string[];
  bootBacked: boolean;
  readOnly: string;
  removable: string;
  serial: string;
  smartSerial: string;
  copies: number;
}

export function requireSafeDisk(e: GuardEvidence): void {
  if (!diskName.test(e.name) || e.target !== `/dev/${e.name}`) throw new Error("The by-id link changed or is ambiguous");
  if (!devNumber.test(e.pinnedDevice) || e.pinnedDevice !== e.sysDevice ||
      !/^\d+$/.test(e.pinnedSequence) || e.pinnedSequence !== e.sysSequence) throw new Error("The block device changed or was unplugged");
  if (!e.bootBacked) throw new Error("Cannot identify the host root backing device");
  if (e.readOnly !== "0" || e.removable !== "0") throw new Error("Disk is read-only, removable or has unknown flags");
  if (e.partitions.length) throw new Error("Disk has partitions");
  if (e.holders.length || e.slaves.length) throw new Error("Disk belongs to a storage stack");
  if (e.mounted.includes(e.pinnedDevice)) throw new Error("Disk backs a mount, boot or root");
  if (e.swap.includes(e.pinnedDevice)) throw new Error("Disk backs active swap");
  if (!e.serial || e.smartSerial !== e.serial || e.copies !== 1) throw new Error("Disk serial is missing, ambiguous or mismatched");
}

const str = (value: unknown) => typeof value === "string" ? value.trim() : "";
const valueOf = (row: Json, key: string) => str(row[key]);
const object = (data: unknown): Json => data && typeof data === "object" && !Array.isArray(data) ? data as Json : {};

function linuxDeviceNumber(raw: bigint): string {
  return `${((raw >> 8n) & 0xfffn) | ((raw >> 32n) & ~0xfffn)}:${(raw & 0xffn) | ((raw >> 12n) & ~0xffn)}`;
}

async function listDisks(lsblk: string): Promise<Disk[]> {
  const { out } = await runTool(lsblk, ["--bytes", "--json", "--list", "--output", "KNAME,TYPE,MODEL,SERIAL,TRAN,SIZE,MAJ:MIN,DISC-MAX"]);
  const rows: unknown = JSON.parse(out).blockdevices;
  if (!Array.isArray(rows)) throw new Error("No block inventory evidence");
  return rows.map(object).filter((r) => r.type === "disk").map((r) => ({
    name: valueOf(r, "kname"), model: valueOf(r, "model"), serial: valueOf(r, "serial"),
    transport: valueOf(r, "tran"), size: Number(r.size), majorMinor: valueOf(r, "maj:min"), discard: Number(r["disc-max"]) || 0,
  })).filter((r) => basename.test(r.name) && devNumber.test(r.majorMinor) && Number.isSafeInteger(r.size) && r.size > 0);
}

function smartType(disk: Disk): string {
  switch (disk.transport) {
    case "nvme": return "nvme";
    case "sata":
    case "ata":
    case "usb": return "sat";
    case "sas":
    case "scsi": return "scsi";
    default: throw new Error("Unknown SMART transport");
  }
}

export function inventoryMetadata(disk: Disk, contents: string) {
  const properties = new Map<string, string>();
  const aliases: string[] = [];
  for (const line of contents.split("\n")) {
    if (line.startsWith("S:disk/by-id/")) {
      const id = line.slice("S:disk/by-id/".length);
      if (stableId(id)) aliases.push(id);
    }
    const property = /^E:([A-Z0-9_]+)=(.*)$/.exec(line);
    if (property) properties.set(property[1]!, property[2]!.trim());
  }
  const bus = properties.get("ID_BUS");
  return {
    disk: { ...disk, model: disk.model || properties.get("ID_MODEL") || "",
      serial: disk.serial || properties.get("ID_SERIAL_SHORT") || "",
      transport: disk.transport || (bus === "ata" && properties.get("ID_ATA_SATA") === "1" ? "sata" : bus ?? "") },
    aliases: aliases.sort(),
  };
}

export function readSmartKind(data: SmartSnapshot): SmartKind | undefined {
  const protocol = object(data.data.device).protocol;
  if (protocol === "NVMe") return "nvme";
  if (protocol === "ATA") return "ata";
  if (protocol === "SCSI") return "scsi";
}

export function validateSmart(exit: number, data: Json, serial: string): SmartSnapshot {
  // Fatal command bits are distinct from health, error log and self-test result bits.
  if (exit < 0 || exit > 255 || (exit & 0x07) || !serial || valueOf(data, "serial_number") !== serial)
    throw new Error("SMART identity or command evidence is missing or mismatched");
  return { exit, data };
}

function parseMounts(contents: string) {
  const lines = contents.trim().split("\n").map((line) => line.split(" "));
  if (lines.some((l) => l.length < 10 || !devNumber.test(l[2] ?? "") || !l.includes("-"))) throw new Error("Cannot verify host mounts");
  return lines;
}

async function hostMounts(): Promise<{ mounted: string[]; bootBacked: boolean }> {
  const [ownNs, initNs, contents, boot] = await Promise.all([
    fs.readlink("/proc/self/ns/mnt"), fs.readlink("/proc/1/ns/mnt"), fs.readFile("/proc/1/mountinfo", "utf8"), fs.readFile("/proc/cmdline", "utf8"),
  ]);
  if (ownNs !== initNs || !boot.trim()) throw new Error("Host mount namespace or boot evidence is unavailable");
  const mounts = parseMounts(contents);
  const roots = mounts.filter((l) => l[4] === "/");
  const root = roots.length === 1 ? roots[0]![2] : undefined;
  const bootBacked = !!root && await fs.realpath(`/sys/dev/block/${root}`).then(() => true, () => false);
  return { mounted: mounts.map((l) => l[2]!), bootBacked };
}

async function activeSwap(): Promise<string[]> {
  const [header, ...lines] = (await fs.readFile("/proc/swaps", "utf8")).trim().split("\n");
  if (!header?.startsWith("Filename")) throw new Error("Cannot verify active swap");
  return Promise.all(lines.map(async (line) => {
    const source = line.split(/\s+/)[0]!.replace(/\\([0-7]{3})/g, (_, n: string) => String.fromCharCode(parseInt(n, 8)));
    if (!source.startsWith("/")) throw new Error("Unknown active swap location");
    const info = await fs.stat(source, { bigint: true });
    return linuxDeviceNumber(info.isBlockDevice() ? info.rdev : info.dev);
  }));
}

export class DiskDevices {
  constructor(readonly allow: ReadonlySet<string>, readonly helper: string, readonly lsblk = "/usr/bin/lsblk",
    readonly readOnly: string[] = [], readonly root = "/") {}

  static async create(allow: ReadonlySet<string>, readOnly: string[], root: string) {
    if (process.platform !== "linux") throw new Error("Disk verify requires Linux");
    const helper = await locateHelper("filedeck-disk-verify", undefined);
    const lsblk = await executable("/usr/bin/lsblk") ? "/usr/bin/lsblk" : "/bin/lsblk";
    if (!(await executable(lsblk)) || !(await executable(smartctl)) || !(await executable(helper)))
      throw new Error("Disk verify requires lsblk, smartctl and the native helper");
    return new DiskDevices(allow, helper, lsblk, readOnly, root);
  }

  async list(): Promise<Disk[]> {
    const [disks, aliases, boot] = await Promise.all([listDisks(this.lsblk), this.aliases(), fs.readFile(bootId, "utf8")]);
    const udev = path.join(this.root, "run/udev/data");
    const inventory = await Promise.all(disks.map(async (disk) => inventoryMetadata(disk,
      await fs.readFile(path.join(udev, `b${disk.majorMinor}`), "utf8").catch(() => ""))));
    return Promise.all(inventory.map(async ({ disk, aliases: metadata }) => {
      const ids = aliases.filter((entry) => entry.target === `/dev/${disk.name}`);
      const allowed = ids.filter((entry) => this.allow.has(entry.id));
      const byId = (allowed[0] ?? ids[0])?.id ?? metadata[0];
      let reason: string | undefined;
      let fingerprint: string | undefined;
      if (!byId) reason = "No whole-disk by-id link";
      else if (!diskName.test(disk.name) || !supported.has(disk.transport)) reason = "Unsupported device or transport";
      else if (!disk.model || !disk.serial || inventory.filter((item) => item.disk.serial === disk.serial).length !== 1) reason = "Model or unique serial is unavailable";
      else if (allowed.length !== 1) reason = allowed.length ? "More than one by-id link is allowed for this disk" : "Disk is outside the destructive allowlist";
      else if (this.protects(disk.name, byId)) reason = "The agent configuration protects this device";
      else {
        const sequence = (await fs.readFile(`/sys/block/${disk.name}/diskseq`, "utf8").catch(() => "")).trim();
        if (!/^[1-9]\d*$/.test(sequence)) reason = "Kernel disk sequence is unavailable";
        else fingerprint = diskIdentity({ disk: { ...disk, byId }, boot: boot.trim(), sequence });
      }
      return { ...disk, byId, reason, fingerprint };
    }));
  }

  protects(name: string, id: string): boolean {
    const forms = readOnlyForms("/", this.readOnly);
    return hitsReadOnly("/", this.readOnly, `/dev/${name}`, forms) ||
      hitsReadOnly("/", this.readOnly, path.join(byIdDir, id), forms);
  }

  async aliases() {
    const links = await fs.readdir(byIdDir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return [];
      throw err;
    });
    return (await Promise.all(links.filter(stableId).sort().map(async (id) => {
      const location = path.join(byIdDir, id);
      if (!(await fs.lstat(location).catch(() => null))?.isSymbolicLink()) return { id, target: "" };
      return { id, target: await fs.realpath(location).catch(() => "") };
    }))).filter((entry) => entry.target);
  }

  async pin(id: string, serial: string, destructive: boolean): Promise<Pin> {
    if (!stableId(id)) throw new Error("A whole-disk by-id link is required");
    const disks = await this.list();
    const disk = disks.find((d) => d.byId === id);
    if (!disk || !diskName.test(disk.name) || !supported.has(disk.transport) || !serial ||
        disk.serial !== serial || disks.filter((d) => d.serial === serial).length !== 1) throw new Error("Disk identity is missing, changed or ambiguous");
    if (destructive && disk.reason) throw new Error(disk.reason);
    const target = await fs.realpath(path.join(byIdDir, id));
    if (target !== `/dev/${disk.name}`) throw new Error("The by-id link changed");
    const file = await fs.open(target, fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK |
      (destructive ? fs.constants.O_RDWR | fs.constants.O_EXCL : fs.constants.O_RDONLY));
    try {
      const initial = await this.identify(file);
      const boot = (await fs.readFile(bootId, "utf8")).trim();
      if (initial.device !== disk.majorMinor || initial.bytes !== disk.size || !/^[0-9a-f-]{36}$/.test(boot)) throw new Error("Disk identity changed");
      const pin = { disk, boot, file, sequence: initial.sequence, sector: initial.sector };
      await this.binding(pin);
      return pin;
    } catch (err) {
      await file.close();
      throw err;
    }
  }

  async identify(file: FileHandle) {
    const { out } = await runTool(this.helper, ["identify"], { file });
    const row = /^(\d+:\d+) ([1-9]\d*) ([1-9]\d*) ([1-9]\d*)\n$/.exec(out);
    if (!row) throw new Error("No kernel disk identity");
    return { device: row[1], sequence: row[2]!, bytes: Number(row[3]), sector: Number(row[4]) };
  }

  async binding(pin: Pin) {
    const { disk } = pin;
    const sys = `/sys/block/${disk.name}`;
    const [target, sequence, device] = await Promise.all([
      fs.realpath(path.join(byIdDir, disk.byId!)), fs.readFile(`${sys}/diskseq`, "utf8"), fs.readFile(`${sys}/dev`, "utf8"),
    ]);
    if (target !== `/dev/${disk.name}` || sequence.trim() !== pin.sequence || device.trim() !== disk.majorMinor)
      throw new Error("The by-id link or kernel disk identity changed");
    return { sys, target, sequence: sequence.trim(), device: device.trim() };
  }

  async smart(pin: Pin, args = ["-x"], signal?: AbortSignal): Promise<SmartSnapshot> {
    await this.binding(pin);
    const type = smartType(pin.disk);
    // smartctl reports an empty SCSI self-test log and its progress only in the text output.
    const format = type === "scsi" && args.includes("-x") ? "-j=o" : "-j";
    const { code, out } = await runTool(smartctl, [format, ...args, "-d", type, `/dev/${pin.disk.name}`], { signal });
    const snapshot = validateSmart(code, object(JSON.parse(out)), pin.disk.serial);
    await this.binding(pin);
    return snapshot;
  }

  async guard(pin: Pin, signal?: AbortSignal) {
    const { disk } = pin;
    const binding = await this.binding(pin);
    const { sys } = binding;
    const [disks, entries, holders, slaves, mounts, swap, readOnly, removable, smart] = await Promise.all([
      this.list(), fs.readdir(sys), fs.readdir(`${sys}/holders`), fs.readdir(`${sys}/slaves`), hostMounts(), activeSwap(),
      fs.readFile(`${sys}/ro`, "utf8"), fs.readFile(`${sys}/removable`, "utf8"), this.smart(pin, ["-i"], signal),
    ]);
    const invariant = disks.find((d) => d.name === disk.name);
    if (!invariant || invariant.reason || invariant.byId !== disk.byId || invariant.majorMinor !== disk.majorMinor ||
        invariant.size !== disk.size || invariant.transport !== disk.transport || invariant.model !== disk.model) throw new Error("Disk is no longer uniquely allowed");
    // Sysfs partition entries on these transports are named after their parent disk.
    const partitions = (await Promise.all(entries.filter((entry) => entry !== disk.name && basename.test(entry)).map(async (entry) => {
      const stat = await fs.stat(`${sys}/${entry}/partition`).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
        throw err;
      });
      return stat || (entry.startsWith(disk.name) && /^(?:p)?\d+$/.test(entry.slice(disk.name.length))) ? entry : null;
    }))).filter((entry): entry is string => entry !== null);
    requireSafeDisk({
      name: disk.name, target: binding.target, pinnedDevice: disk.majorMinor, sysDevice: binding.device,
      pinnedSequence: pin.sequence, sysSequence: binding.sequence, partitions, holders, slaves, mounted: mounts.mounted,
      bootBacked: mounts.bootBacked, swap, readOnly: readOnly.trim(), removable: removable.trim(),
      serial: invariant.serial, smartSerial: valueOf(smart.data, "serial_number"), copies: disks.filter((d) => d.serial === disk.serial).length,
    });
    await this.command(pin, "probe", [], signal);
  }

  async command(pin: Pin, operation: string, args: string[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    await this.binding(pin);
    const result = await runTool(this.helper, [operation, pin.sequence, String(pin.disk.size), String(pin.sector), ...args], { file: pin.file, signal });
    await this.binding(pin);
    return result.out.trim();
  }
}
