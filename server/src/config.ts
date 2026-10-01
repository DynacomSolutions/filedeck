export interface Config {
  mode: "agent" | "hub";
  port: number;
  root: string;
  node: string;
  procMounts: string;
  maxUpload: number;
  staticDir: string;
  /** hub: name -> agent base URL */
  nodes: { name: string; url: string }[];
}

/** NODES="node-a=http://filedeck-agent-node-a:8080,node-b=http://..." */
export function parseNodes(s: string | undefined) {
  return (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const i = x.indexOf("=");
      if (i < 1) throw new Error(`bad NODES entry: ${x}`);
      return { name: x.slice(0, i), url: x.slice(i + 1).replace(/\/$/, "") };
    });
}

export function loadConfig(env = process.env): Config {
  const mode = env.FILEDECK_MODE === "hub" ? "hub" : "agent";
  const root = (env.FILEDECK_ROOT ?? "/host").replace(/\/+$/, "") || "/";
  return {
    mode,
    port: Number(env.PORT ?? 8080),
    root,
    node: env.FILEDECK_NODE ?? "local",
    procMounts: env.FILEDECK_PROC_MOUNTS ?? `${root === "/" ? "" : root}/proc/mounts`,
    maxUpload: Number(env.FILEDECK_MAX_UPLOAD ?? 1024 ** 4),
    staticDir: env.FILEDECK_STATIC ?? "/app/web",
    nodes: parseNodes(env.NODES),
  };
}
