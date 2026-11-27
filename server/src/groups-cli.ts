import type { GroupsResult } from "./group-types.ts";

export const GROUPS_USAGE = "       filedeck groups [--json] [node]";

export async function runGroups(
  args: string[],
  env: NodeJS.ProcessEnv,
  io: { fetch: typeof fetch; out(s: string): void; err(s: string): void; signal: AbortSignal },
): Promise<number> {
  const names = args.filter((arg) => arg !== "--json");
  if (names.length > 1 || names.some((name) => !name || name.startsWith("-"))) {
    io.err(`${GROUPS_USAGE}\n`);
    return 2;
  }
  const base = env.FILEDECK_URL?.replace(/\/+$/, "");
  const token = env.FILEDECK_TOKEN;
  if (!base || !token) {
    io.err("filedeck groups: set FILEDECK_URL and FILEDECK_TOKEN\n");
    return 2;
  }
  try {
    const url = new URL(base + "/api/groups");
    if (names[0]) url.searchParams.set("node", names[0]);
    const reply = await io.fetch(url, {
      headers: { "X-Filedeck-Token": token },
      redirect: "error",
      signal: AbortSignal.any([io.signal, AbortSignal.timeout(20_000)]),
    });
    if (!reply.ok) throw new Error(`the hub returned HTTP ${reply.status}`);
    const data = await reply.json() as GroupsResult;
    if (args.includes("--json")) io.out(JSON.stringify(data, null, 2) + "\n");
    else {
      for (const node of data.nodes) {
        io.out(`${node.node}\n`);
        for (const drive of node.drives) {
          const devices = drive.devices.map((d) => d.model ? `${d.name} (${d.model})` : d.name).join(", ");
          io.out(`  ${devices || drive.mounts.join(", ")}\n`);
          for (const group of drive.groups) {
            const flags = [group.notStored && "not stored", group.stale && "stale", group.hardLinks === "heavy" && "many hard links"].filter(Boolean);
            io.out(`    ${group.bytes}\t${group.name}${flags.length ? ` (${flags.join(", ")})` : ""}\n`);
          }
        }
      }
      for (const node of data.unavailable) io.err(`filedeck groups: ${node} unavailable\n`);
    }
    return data.unavailable.length ? 1 : 0;
  } catch (error) {
    io.err(`filedeck groups: ${error instanceof Error ? error.message : "request failed"}\n`);
    return 1;
  }
}
