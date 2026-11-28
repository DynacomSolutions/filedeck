import fs from "node:fs";
import path from "node:path";
import { BUILT_NATIVE_DIR } from "../native.ts";

/**
 * Where the eBPF helper is: the setting FILEDECK_IOTRACE when it has a value (`off` = never), else the installed helper, else the one built beside the code.
 * Empty when there is none: the collector then reads /proc and /sys. A path that is set is used as given, so a wrong value shows up in the log.
 */
export function iotracePath(setting: string, builtDir = BUILT_NATIVE_DIR, installed = "/usr/local/bin/filedeck-iotrace"): string {
  if (setting === "off") return "";
  if (setting) return setting;
  for (const p of [installed, path.join(builtDir, "filedeck-iotrace")]) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return "";
}
