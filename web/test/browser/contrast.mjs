export function isEnhancedContrastFailure({ ratio, required, disabled = false }) {
  return !disabled && ratio < required;
}

/** Parse "#rgb", "#rrggbb" or "rgba(r,g,b,a)" into [r, g, b, a] (0-255, alpha 0-1). */
export function parseColour(value) {
  const text = String(value).trim().toLowerCase();
  let m = text.match(/^#([0-9a-f]{3})$/);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16)).concat(1);
  m = text.match(/^#([0-9a-f]{6})$/);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = text.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(',').map((s) => parseFloat(s));
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  throw new Error(`unsupported colour ${value}`);
}

/** Composite a (possibly translucent) colour over an opaque background; returns [r, g, b]. */
export function composite(foreground, background) {
  const f = parseColour(foreground);
  const b = parseColour(background);
  return [0, 1, 2].map((i) => f[i] * f[3] + b[i] * (1 - f[3]));
}

function luminance([r, g, b]) {
  const lin = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** WCAG contrast ratio of a colour (alpha composited over `background`) against `background`. */
export function contrastRatio(foreground, background) {
  const bg = parseColour(background).slice(0, 3);
  const a = luminance(composite(foreground, background));
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Contrast between two colours that are both drawn over the same page background. */
export function contrastBetween(first, second, page) {
  const a = luminance(composite(first, page));
  const b = luminance(composite(second, page));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
