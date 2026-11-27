import { readFileSync } from "node:fs";
import { posix } from "node:path";

export interface GroupRule {
  name: string;
  paths: string[];
  exclude: string[];
  labels: Record<string, string>;
}

export const containsPath = (parent: string, child: string): boolean =>
  parent === child || child.startsWith(parent === "/" ? "/" : parent + "/");

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
  return value as Record<string, unknown>;
}

function prefixes(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("expected an array of path prefixes");
  return [...new Set(value.map((p: unknown) => {
    if (typeof p !== "string" || !p.startsWith("/") || /[\0]/.test(p) || p.includes("\\") || p.split("/").includes("..")) {
      throw new Error("expected an absolute path prefix");
    }
    return posix.normalize(p).replace(/\/$/, "") || "/";
  }))];
}

export function parseGroupRules(text: string, node: string): GroupRule[] {
  const byNode = object(JSON.parse(text));
  if (!Object.hasOwn(byNode, node)) return [];
  const raw = byNode[node];
  if (!Array.isArray(raw)) throw new Error("expected a list of group rules");
  const owners = new Set<string>();
  const names = new Set<string>();
  return raw.map((item: unknown) => {
    const rule = object(item);
    const name = typeof rule.name === "string" ? rule.name.trim() : "";
    if (!name || names.has(name)) throw new Error("group names must be nonempty and unique per node");
    names.add(name);
    const paths = prefixes(rule.paths);
    if (!paths.length) throw new Error("a group needs at least one path");
    for (const p of paths) {
      if (owners.has(p)) throw new Error("each path prefix can have only one owner");
      owners.add(p);
    }
    const exclude = prefixes(rule.exclude ?? []);
    if (exclude.some((p) => !paths.some((base) => base !== p && containsPath(base, p)))) {
      throw new Error("excluded prefixes must be below a group path");
    }
    const labels: Record<string, string> = Object.create(null);
    for (const [key, value] of Object.entries(object(rule.labels ?? {}))) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || key.startsWith("__") || key === "node" ||
        typeof value !== "string" || !value || /[\x00-\x1f\x7f]/.test(value)) {
        throw new Error("expected exact IO labels with nonempty values");
      }
      labels[key] = value;
    }
    return { name, paths, exclude, labels };
  });
}

export function loadGroupRules(file: string | undefined, node: string): GroupRule[] {
  return file ? parseGroupRules(readFileSync(file, "utf8"), node) : [];
}
