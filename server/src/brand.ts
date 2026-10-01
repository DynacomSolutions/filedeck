/**
 * Runtime branding. The image ships neutral ("Filedeck", no logos, no external
 * links); a deployment sets FILEDECK_BRAND (JSON) to carry its own name,
 * logos, header links, page title and the localStorage key of its theme
 * switch. The hub writes the validated result into index.html, so the page
 * has it before any script runs (no flash of the wrong theme).
 */
export interface Brand {
  name: string;
  title: string;
  /** logo images for the light and dark page (same-origin paths or https URLs); absent = the name as text */
  logo?: { light: string; dark: string };
  /** browser-tab icon; defaults to the bundled neutral one */
  icon: string;
  /** extra stylesheet loaded after the bundled theme (same-origin path or https URL), e.g. to recolour the accent */
  css?: string;
  /** links shown in the header, e.g. sibling tools */
  links: { label: string; url: string }[];
  /** localStorage key shared with other pages of the same deployment so the theme choice follows the user */
  themeKey: string;
}

export const DEFAULT_BRAND: Brand = { name: "Filedeck", title: "Filedeck", icon: "/favicon.svg", links: [], themeKey: "filedeck-theme" };

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
  const lg = j.logo as { light?: unknown; dark?: unknown } | undefined;
  const light = safeUrl(lg?.light);
  const dark = safeUrl(lg?.dark);
  if (light && dark) b.logo = { light, dark };
  const css = safeUrl(j.css);
  if (css) b.css = css;
  if (Array.isArray(j.links)) {
    for (const l of j.links.slice(0, 8)) {
      const label = text((l as { label?: unknown })?.label, 40);
      const url = safeUrl((l as { url?: unknown })?.url);
      if (label && url) b.links.push({ label, url });
    }
  }
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
