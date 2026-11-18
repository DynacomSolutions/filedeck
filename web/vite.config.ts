import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { precacheFrom, swVersion, type BundleEntry } from "./src/swPolicy";

/** Every file under `dir`, as paths relative to it with forward slashes. */
function filesIn(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? filesIn(p, base) : [path.relative(base, p).split(path.sep).join("/")];
  });
}

/**
 * Builds src/sw.ts to /sw.js (a classic script, no imports) and puts the precache list and the version in front of it.
 * The version hashes the list and the public files' contents, so every build that changes what the app loads is a new
 * service worker, and the page offers to reload (pwa.ts).
 */
function serviceWorker(): Plugin {
  let publicDir = "";
  return {
    name: "filedeck-service-worker",
    apply: "build",
    configResolved(c) {
      publicDir = c.publicDir;
    },
    buildStart() {
      this.emitFile({ type: "chunk", id: path.resolve(import.meta.dirname, "src/sw.ts"), fileName: "sw.js" });
    },
    generateBundle(_o, bundle) {
      const sw = bundle["sw.js"];
      if (!sw || sw.type !== "chunk") throw new Error("sw.js was not built");
      if (sw.imports.length || sw.dynamicImports.length) throw new Error("sw.js must not import other chunks");
      const entries: BundleEntry[] = Object.values(bundle).map((b) =>
        b.type === "chunk"
          ? { type: "chunk", fileName: b.fileName, isEntry: b.isEntry, imports: b.imports, css: [...(b.viteMetadata?.importedCss ?? [])] }
          : { type: "asset", fileName: b.fileName },
      );
      const pub = publicDir ? filesIn(publicDir) : [];
      const list = precacheFrom(entries, pub);
      const sums = pub.map((f) => f + "@" + createHash("sha256").update(readFileSync(path.join(publicDir, f))).digest("hex").slice(0, 12));
      const version = swVersion([...list, ...sums]);
      sw.code = `self.__FD_PRECACHE__=${JSON.stringify(list)};self.__FD_VERSION__=${JSON.stringify(version)};\n` + sw.code;
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  build: { outDir: "dist", sourcemap: false },
  server: { proxy: { "/api": { target: process.env.HUB_URL ?? "http://127.0.0.1:8081", changeOrigin: false } } },
});
