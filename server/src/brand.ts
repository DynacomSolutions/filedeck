/**
 * Runtime branding. The image ships neutral ("Filedeck", no logos, no external
 * links); a deployment sets FILEDECK_BRAND (JSON) to carry its own name,
 * page title and the localStorage key of its theme
 * switch. The hub writes the validated result into index.html, so the page
 * has it before any script runs (no flash of the wrong theme).
 */
export interface Brand {
  name: string;
  title: string;
  /** browser-tab icon; defaults to the bundled neutral one */
  icon: string;
  /** extra stylesheet loaded after the bundled theme (same-origin path or https URL), e.g. to recolour the accent */
  css?: string;
  /** localStorage key shared with other pages of the same deployment so the theme choice follows the user */
  themeKey: string;
}

export const DEFAULT_BRAND: Brand = { name: "Filedeck", title: "Filedeck", icon: "/favicon.svg", themeKey: "filedeck-theme" };

const safeUrl = (v: unknown): string | null => (typeof v === "string" && v.length <= 300 && (/^\/(?!\/)[^\s"'<>]*$/.test(v) || /^https:\/\/[^\s"'<>]+$/.test(v)) ? v : null);
const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null);

export function parseBrand(s: string | undefined): Brand {
  if (!s) return DEFAULT_BRAND;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(s) as Record<string, unknown>;
  } catch {
    throw new Error("FILEDECK_BRAND is not valid JSON");
  }
  const name = text(j.name, 60) ?? DEFAULT_BRAND.name;
  const b: Brand = { ...DEFAULT_BRAND, name, title: text(j.title, 100) ?? name };
  const icon = safeUrl(j.icon);
  if (icon) b.icon = icon;
  const css = safeUrl(j.css);
  if (css) b.css = css;
  const key = j.themeKey;
  if (typeof key === "string" && /^[A-Za-z0-9._-]{1,60}$/.test(key)) b.themeKey = key;
  return b;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** index.html with the title, icon and the boot object filled in. */
export function renderIndex(html: string, b: Brand): string {
  // "<" is escaped inside the JSON so a value can never close the script element
  const boot = JSON.stringify(b).replace(/</g, "\\u003c");
  return html
    .replace("%%TITLE%%", esc(b.title))
    .replace("%%ICON%%", esc(b.icon))
    .replace("%%BRANDCSS%%", b.css ? `<link rel="stylesheet" href="${esc(b.css)}" />` : "")
    .replace("%%BOOT%%", `window.__FILEDECK__=${boot};`);
}
