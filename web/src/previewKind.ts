// Which viewer a file gets. Known extensions decide at once; unknown or missing ones are decided by sniffing the first bytes.
import { isArchive } from "./api";
import { AUDIO_EXT, VIDEO_EXT } from "./MediaPlayers";
import { LEGACY_OFFICE, OFFICE_EXT } from "./officeParse";
import { isTextName } from "./highlight";

export const IMG_EXT = ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico"];

/** Lower-case extension without the dot; "" when the name has none ("Makefile" has none, ".env" is all extension). */
export const extOf = (name: string) => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");

export type PreviewKind = "empty" | "archive" | "image" | "video" | "audio" | "pdf" | "office" | "legacy-office" | "markdown" | "text" | "unknown";

/** Decide from the name alone. "unknown" means the bytes must be looked at. */
export function previewKind(name: string, size: number): PreviewKind {
  const e = extOf(name);
  if (isArchive(name)) return "archive";
  if (IMG_EXT.includes(e)) return "image";
  if (VIDEO_EXT.includes(e)) return "video";
  if (AUDIO_EXT.includes(e)) return "audio";
  if (e === "pdf") return "pdf";
  if (OFFICE_EXT.includes(e) && ((e !== "csv" && e !== "tsv") || size <= 8 * 1024 * 1024)) return "office";
  if (LEGACY_OFFICE.includes(e)) return "legacy-office";
  if (e === "md" || e === "markdown") return "markdown";
  if (isTextName(name) || size === 0) return "text";
  return "unknown";
}

/** How many leading bytes are looked at to tell text from binary. */
export const SNIFF_BYTES = 8192;

/** Text when the bytes hold no NUL and decode as UTF-8. A multi-byte character cut by the sample end is allowed. */
export function looksLikeText(bytes: Uint8Array, truncated = false): boolean {
  if (bytes.includes(0)) return false;
  let end = bytes.length;
  if (truncated) {
    // Drop an incomplete trailing sequence (at most 3 bytes) so a cut does not read as invalid.
    for (let back = 1; back <= Math.min(3, end); back++) {
      const b = bytes[end - back]!;
      if (b >= 0xc0) {
        const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
        if (back < need) end -= back;
        break;
      }
      if (b < 0x80) break;
    }
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
    return true;
  } catch {
    return false;
  }
}
