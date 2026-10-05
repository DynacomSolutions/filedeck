import type { Hono } from "hono";
import fs from "node:fs/promises";
import { FsError } from "./fsops.ts";
import { resolveRead } from "./paths.ts";
import { ceilingFor, listRefs, prDiff, readBlob, repoInfo, type DiffInput, type GitCtx } from "./git-diff.ts";
import type { Config } from "./config.ts";

/**
 * Agent side of the pull request diff view (read-only, no token):
 *  - GET /api/git/refs?path=                                  refs and recent pull requests the picker offers
 *  - GET /api/git/diff?path=&pr=<n> | &base=<ref>&head=<ref>  changed files vs the merge-base
 *  - GET /api/git/blob?path=&sha=<commit>&file=<path>         one file's text at a commit (capped)
 * `path` is the repository folder (work tree, or a bare mirror) as a virtual path under the agent root.
 */
export function registerGitDiffRoutes(app: Hono, cfg: Config): void {
  const ctx = async (p: string | undefined): Promise<GitCtx> => {
    const r = resolveRead(cfg.root, p ?? "");
    if (!(await fs.stat(r.real)).isDirectory()) throw new FsError(400, "not a folder");
    const c = { cwd: r.real, ceiling: ceilingFor(cfg.root) };
    await repoInfo(c);
    return c;
  };

  app.get("/api/git/refs", async (c) => c.json(await listRefs(await ctx(c.req.query("path")))));

  app.get("/api/git/diff", async (c) => {
    const pr = c.req.query("pr");
    const base = c.req.query("base");
    const head = c.req.query("head");
    let input: DiffInput;
    if (pr !== undefined && pr !== "") {
      if (!/^\d{1,8}$/.test(pr)) throw new FsError(400, "invalid pull request number");
      input = { pr: Number(pr) };
    } else if (base && head) input = { base, head };
    else throw new FsError(400, "give a pull request number (pr) or two refs (base and head)");
    const g = await ctx(c.req.query("path"));
    return c.json(await prDiff(g, input), 200, { "cache-control": "no-store" });
  });

  app.get("/api/git/blob", async (c) => {
    const g = await ctx(c.req.query("path"));
    return c.json(await readBlob(g, c.req.query("sha") ?? "", c.req.query("file") ?? ""), 200, { "cache-control": "private, max-age=3600" });
  });
}
