#!/usr/bin/env node
// Generates the app icons in web/public from the Filedeck mark in web/public/favicon.svg.
// Needs rsvg-convert (librsvg). The PNGs are committed, so a build never runs this.
//
//   node web/scripts/icons.mjs
//
// - icon-192.png, icon-512.png: purpose "any", the mark in light ink on the dark header colour, as before
// - icon-maskable-192.png, icon-maskable-512.png: purpose "maskable", full-bleed background, the mark well inside the
//   central 80 % circle Android keeps for adaptive icons
// - icon-monochrome.png: purpose "monochrome" (Android themed icons), the mark in white on transparent, same safe zone
// - apple-touch-icon.png: 180 px, full bleed (iOS rounds the corners)
// - favicon-16/32/48.png: the mark alone in dark ink, for tabs and bookmarks on a light background
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const src = readFileSync(path.join(pub, "favicon.svg"), "utf8");
const paths = [...src.matchAll(/<path d="([^"]+)"\/>/g)].map((m) => m[1]);
if (paths.length === 0) throw new Error("no paths found in favicon.svg");

const BG = "#151518"; // the dark theme's header (--surface)
const INK = "#e8eaed"; // the dark favicon's ink
const DARK_INK = "#1a1d21"; // the light favicon's ink

// The mark's drawing spans 2..22 of its 24-unit box (path 3..21 plus half the 2-unit stroke): `share` is the part of the
// icon's width the 24-unit box takes, centred.
function svg({ size, share, bg, ink }) {
  const box = size * share;
  const off = (size - box) / 2;
  const scale = box / 24;
  const back = bg ? `<rect width="${size}" height="${size}" fill="${bg}"/>` : "";
  const mark = paths.map((d) => `<path d="${d}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${back}<g transform="translate(${off} ${off}) scale(${scale})" fill="none" stroke="${ink}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${mark}</g></svg>`;
}

function png(name, opts) {
  execFileSync("rsvg-convert", ["-w", String(opts.size), "-h", String(opts.size), "-o", path.join(pub, name)], { input: svg(opts) });
  console.log(name);
}

// share 0.6: the drawing (20/24 of the box) is 50 % of the icon, its corners at most 0.354 of the width from the centre.
for (const size of [192, 512]) png(`icon-${size}.png`, { size, share: 0.6, bg: BG, ink: INK });
// share 0.55: the drawing's farthest corner is 0.32 of the width from the centre, inside the 0.4 safe-zone radius.
for (const size of [192, 512]) png(`icon-maskable-${size}.png`, { size, share: 0.55, bg: BG, ink: INK });
png("icon-monochrome.png", { size: 512, share: 0.55, ink: "#ffffff" });
png("apple-touch-icon.png", { size: 180, share: 0.6, bg: BG, ink: INK });
for (const size of [16, 32, 48]) png(`favicon-${size}.png`, { size, share: 1, ink: DARK_INK });
